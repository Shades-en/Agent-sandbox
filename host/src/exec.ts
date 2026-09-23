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
import { createNetwork, NETWORK_HELPER, type NetworkHandle } from "./network.js";
import type { ExecResponse } from "./frame.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  runDir: string;
  timings?: Record<string, number>;
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
  openNetwork?: () => Promise<NetworkHandle>;
  copy: (base: string, dest: string) => Promise<void>;
  spawn: (args: { bin: string; apiSock: string; logPath: string; serialPath: string; network?: NetworkHandle; snapshotDirectory?: string; boot?: boolean }) => FirecrackerHandle;
  waitForApi: (apiSock: string, deadline: number) => Promise<void>;
  configure: (apiSock: string, request: BootRequest) => Promise<void>;
  exchange: (vsockPath: string, command: string, timeoutMs: number, timings?: Record<string, number>) => Promise<ExecResponse>;
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
  network?: NetworkHandle;
  snapshotDirectory?: string;
}): FirecrackerHandle {
  const serial = fs.openSync(args.serialPath, "a");
  const child: ChildProcess = spawn(
    args.network ? "sudo" : args.bin,
    args.network ? ["-n", NETWORK_HELPER, "run", args.network.id, JSON.stringify({ directory: path.dirname(args.apiSock), snapshot: args.snapshotDirectory })] : firecrackerArgs(args.apiSock, args.logPath),
    { stdio: ["ignore", serial, serial] },
  );
  fs.closeSync(serial);
  const ready = new Promise<void>((resolve, reject) => {
    child.once("spawn", () => {
      // A jailed VMM uses its own UID; grant the controller socket access.
      Promise.resolve(args.network?.allowSocket?.("api")).then(resolve, reject);
    });
    child.once("error", (err) => {
      reject(new Error(`failed to spawn ${args.bin}: ${err.message}`));
    });
  });
  return {
    kill: () => {
      // The root helper terminates the namespaced VMM during release.
      if (!args.network) child.kill("SIGKILL");
    },
    ready,
  };
}

export function defaultEnv(): ExecEnv {
  const base = path.join(os.homedir(), ".sandbox");
  const home = path.join(base, "storage");
  let snapshotDirectory: string;
  const env: ExecEnv = {
    home,
    kernelPath: "/usr/local/lib/agent-sandbox/vmlinux",
    rootfsBase: path.join(home, "images", "rootfs.ext4"),
    firecrackerBin: "/usr/local/lib/agent-sandbox/firecracker",
    copy: copyRootfs,
    openNetwork: createNetwork,
    spawn(args) {
      // Snapshot construction boots a kernel; executions restore cached memory.
      return spawnFirecracker({ ...args, snapshotDirectory: args.boot ? undefined : snapshotDirectory });
    },
    waitForApi: waitForSocket,
    async prepare() {
      await assertBtrfsStorage(home);
      snapshotDirectory = await ensureSnapshot(env);
      return path.join(snapshotDirectory, "rootfs.ext4");
    },
    async configure(socket, request) {
      await restoreSnapshot(socket, snapshotDirectory, { ...request, jailed: true });
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
  const started = performance.now();
  const timings: Record<string, number> = {};
  const measure = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try { return await operation(); }
    finally { timings[phase] = performance.now() - start; }
  };
  const env: ExecEnv = { ...defaultEnv(), ...overrides };
  const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const runDir = path.join(env.home, "run", id);
  const base = await measure("snapshot.prepare", async () => env.prepare ? env.prepare() : env.rootfsBase);
  await mkdir(runDir, { recursive: true });
  const rootfsPath = path.join(runDir, "rootfs.ext4");
  await measure("disk.clone", () => env.copy(base, rootfsPath));
  const apiSock = path.join(runDir, "api.sock");
  const vsockPath = path.join(runDir, "v.sock");
  const logPath = path.join(runDir, "firecracker.log");
  const serialPath = path.join(runDir, "serial.log");
  // Firecracker is idle until we load its snapshot. Its serial console
  // (kernel messages) is redirected into serial.log.
  const network = await measure("network.create", async () => env.openNetwork?.());
  const spawnStarted = performance.now();
  let child: FirecrackerHandle | undefined;
  try {
    child = env.spawn({
      bin: env.firecrackerBin, apiSock, logPath, serialPath, network,
    });
    await child.ready;
    timings["firecracker.start"] = performance.now() - spawnStarted;
    await measure("api.ready", () => env.waitForApi(apiSock, Date.now() + BOOT_TIMEOUT_MS));
    await measure("snapshot.restore", () => env.configure(apiSock, {
      kernelPath: env.kernelPath,
      rootfsPath,
      vsockPath,
      network,
    }));
    await measure("vsock.access", async () => network?.allowSocket?.("vsock"));
    // The guest has resumed. exchange reconnects to its saved vsock listener.
    const response = await env.exchange(vsockPath, command, timeoutSec * 1000, timings);
    return {
      stdout: response.stdout,
      stderr: response.stderr,
      exitCode: response.exitCode,
      runDir,
      timings,
    };
  } catch (error) {
    // A command that runs too long is a result. A boot that never connects
    // is a thrown error, so the caller can tell the two apart.
    if (error instanceof CommandTimeoutError) {
      return { stdout: "", stderr: "timeout\n", exitCode: 124, runDir, timings };
    }
    if (error instanceof Error) {
      error.message = `${error.message}\nserial log: ${serialPath}`;
    }
    throw error;
  } finally {
    child?.kill();
    await measure("network.cleanup", async () => network?.release());
    // The returned result references this object, including cleanup time.
    timings["sandbox.total"] = performance.now() - started;
  }
}
