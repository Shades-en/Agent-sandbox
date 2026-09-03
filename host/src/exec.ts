import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { BOOT_TIMEOUT_MS } from "./constants.js";
import { configureAndStart, firecrackerArgs, type BootRequest } from "./firecracker.js";
import { CommandTimeoutError, connectAndExchange } from "./vsock.js";
import type { ExecResponse } from "./frame.js";

const execFileAsync = promisify(execFile);

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

export async function copyRootfs(base: string, dest: string, log: (line: string) => void): Promise<void> {
  try {
    await execFileAsync("cp", ["--reflink=always", base, dest]);
  } catch {
    log("reflink refused; copied rootfs byte for byte");
    await execFileAsync("cp", [base, dest]);
  }
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
  const home = path.join(os.homedir(), ".sandbox");
  return {
    home,
    kernelPath: path.join(home, "images", "vmlinux"),
    rootfsBase: path.join(home, "images", "rootfs.ext4"),
    firecrackerBin: path.join(home, "bin", "firecracker"),
    async copy(base, dest) {
      await copyRootfs(base, dest, (line) => process.stderr.write(`${line}\n`));
    },
    spawn: spawnFirecracker,
    waitForApi: waitForSocket,
    configure: configureAndStart,
    exchange: connectAndExchange,
    log(line) {
      process.stderr.write(`${line}\n`);
    },
  };
}

export async function execCommand(
  command: string,
  timeoutSec: number,
  overrides: Partial<ExecEnv> = {},
): Promise<ExecResult> {
  const env: ExecEnv = { ...defaultEnv(), ...overrides };
  const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const runDir = path.join(env.home, "run", id);
  await mkdir(runDir, { recursive: true });
  const rootfsPath = path.join(runDir, "rootfs.ext4");
  await env.copy(env.rootfsBase, rootfsPath);
  const apiSock = path.join(runDir, "api.sock");
  const vsockPath = path.join(runDir, "v.sock");
  const logPath = path.join(runDir, "firecracker.log");
  const serialPath = path.join(runDir, "serial.log");
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
    const response = await env.exchange(vsockPath, command, timeoutSec * 1000);
    return {
      stdout: response.stdout,
      stderr: response.stderr,
      exitCode: response.exitCode,
      runDir,
    };
  } catch (error) {
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
