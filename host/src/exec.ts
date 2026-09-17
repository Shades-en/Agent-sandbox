import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BOOT_TIMEOUT_MS } from "./constants.js";
import { firecrackerArgs, restoreSnapshot, type BootRequest } from "./firecracker.js";
import { CommandTimeoutError, connectAndExchange } from "./vsock.js";
import { ensureSnapshot } from "./snapshot.js";
import { assertBtrfsStorage, copyRootfs } from "./storage.js";
import type { ExecResponse } from "./frame.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  runDir: string;
}

export interface FirecrackerHandle {
  kill: () => void;
  ready: Promise<void>;
}

export interface ExecEnv {
  home: string;
  // Returns the disk that matches the saved memory, before the per-run copy.
  prepare?: () => Promise<string>;
  kernelPath: string;
  rootfsBase: string;
  firecrackerBin: string;
  copy: (base: string, dest: string) => Promise<void>;
  spawn: (args: { bin: string; apiSock: string; logPath: string; serialPath: string }) => FirecrackerHandle;
  waitForApi: (apiSock: string, deadline: number) => Promise<void>;
  configure: (apiSock: string, request: BootRequest) => Promise<void>;
  exchange: (vsockPath: string, command: string, timeoutMs: number) => Promise<ExecResponse>;
  log: (line: string) => void;
}

async function waitForSocket(apiSock: string, deadline: number): Promise<void> {
  const net = await import("node:net");
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(apiSock);
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("API socket did not open");
}

function spawnFirecracker(args: {
  bin: string;
  apiSock: string;
  logPath: string;
  serialPath: string;
}): FirecrackerHandle {
  const serial = fs.openSync(args.serialPath, "a");
  const child: ChildProcess = spawn(
    args.bin,
    firecrackerArgs(args.apiSock, args.logPath),
    { stdio: ["ignore", serial, serial] },
  );
  fs.closeSync(serial);
  const ready = new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (err) => {
      reject(new Error(`failed to spawn ${args.bin}: ${err.message}`));
    });
  });
  return {
    kill: () => child.kill("SIGKILL"),
    ready,
  };
}

export function defaultEnv(): ExecEnv {
  const base = path.join(os.homedir(), ".sandbox");
  const home = path.join(base, "storage");
  let snapshotDirectory: string;
  const env: ExecEnv = {
    home,
    kernelPath: path.join(base, "images", "vmlinux"),
    rootfsBase: path.join(home, "images", "rootfs.ext4"),
    firecrackerBin: path.join(base, "bin", "firecracker"),
    copy: copyRootfs,
    spawn: spawnFirecracker,
    waitForApi: waitForSocket,
    async prepare() {
      await assertBtrfsStorage(home);
      snapshotDirectory = await ensureSnapshot(env);
      return path.join(snapshotDirectory, "rootfs.ext4");
    },
    async configure(socket, request) {
      await restoreSnapshot(socket, snapshotDirectory, request);
    },
    exchange: connectAndExchange,
    log(line) {
      process.stderr.write(`${line}\n`);
    },
  };
  return env;
}

// Restore a fresh microVM, run one command, then kill Firecracker.
// The run directory is left behind so serial.log can be inspected.
export async function execCommand(
  command: string,
  timeoutSec: number,
  overrides: Partial<ExecEnv> = {},
): Promise<ExecResult> {
  const env: ExecEnv = { ...defaultEnv(), ...overrides };
  const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const runDir = path.join(env.home, "run", id);
  const base = env.prepare ? await env.prepare() : env.rootfsBase;
  await mkdir(runDir, { recursive: true });
  const rootfsPath = path.join(runDir, "rootfs.ext4");
  await env.copy(base, rootfsPath);
  const apiSock = path.join(runDir, "api.sock");
  const vsockPath = path.join(runDir, "v.sock");
  const logPath = path.join(runDir, "firecracker.log");
  const serialPath = path.join(runDir, "serial.log");
  // Firecracker is idle until we load its snapshot. Its serial console
  // (kernel messages) is redirected into serial.log.
  const child = env.spawn({
    bin: env.firecrackerBin,
    apiSock,
    logPath,
    serialPath,
  });
  try {
    await child.ready;
    await env.waitForApi(apiSock, Date.now() + BOOT_TIMEOUT_MS);
    await env.configure(apiSock, {
      kernelPath: env.kernelPath,
      rootfsPath,
      vsockPath,
    });
    // The guest has resumed. exchange reconnects to its saved vsock listener.
    const response = await env.exchange(vsockPath, command, timeoutSec * 1000);
    return {
      stdout: response.stdout,
      stderr: response.stderr,
      exitCode: response.exitCode,
      runDir,
    };
  } catch (error) {
    // A command that runs too long is a result. A boot that never connects
    // is a thrown error, so the caller can tell the two apart.
    if (error instanceof CommandTimeoutError) {
      return { stdout: "", stderr: "timeout\n", exitCode: 124, runDir };
    }
    if (error instanceof Error) {
      error.message = `${error.message}\nserial log: ${serialPath}`;
    }
    throw error;
  } finally {
    child.kill();
  }
}
