import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BOOT_ARGS, GUEST_CID, MEM_SIZE_MIB, VCPU_COUNT } from "./constants.js";
import { apiUpdate, configureAndStart } from "./firecracker.js";
import type { ExecEnv } from "./exec.js";

const READY = "SANDBOX_NODE_READY_FOR_SNAPSHOT";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Snapshot files are local to this Linux host. A changed image, kernel,
// Firecracker binary, or machine configuration gets a new cache directory.
export async function snapshotKey(env: ExecEnv): Promise<string> {
  const inputs = await Promise.all(
    [env.kernelPath, env.rootfsBase, env.firecrackerBin].map(async (file) => {
      const info = await stat(file);
      return [file, info.size, info.mtimeMs, info.ctimeMs, info.ino];
    }),
  );
  // Format 4 includes networking and per-restore cryptographic reseeding.
  return createHash("sha256").update(JSON.stringify({
    format: 4, inputs, arch: os.arch(), kernel: os.release(), cpu: os.cpus()[0]?.model,
    BOOT_ARGS, GUEST_CID, MEM_SIZE_MIB, VCPU_COUNT,
  })).digest("hex").slice(0, 20);
}

async function complete(directory: string): Promise<boolean> {
  try {
    await Promise.all(["ready", "state", "memory", "rootfs.ext4"].map(
      (name) => stat(path.join(directory, name)),
    ));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

export async function waitForGuestReady(serialPath: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(serialPath, "utf8")).includes(READY)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await sleep(50);
  }
  throw new Error(`guest did not announce snapshot readiness; rebuild with scripts/setup-host.sh\nserial log: ${serialPath}`);
}

// Only one caller builds a particular snapshot. Other callers wait for its
// ready marker. A failed build never publishes that marker and can be retried.
export async function ensureSnapshot(env: ExecEnv): Promise<string> {
  const directory = path.join(env.home, "snapshots", await snapshotKey(env));
  await mkdir(path.dirname(directory), { recursive: true });
  if (await complete(directory)) return directory;
  const lock = `${directory}.lock`;
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await complete(directory)) return directory;
      if (Date.now() > deadline) {
        throw new Error(`snapshot build lock still exists: ${lock}; check for an interrupted build`);
      }
      await sleep(100);
    }
  }
  try {
    if (await complete(directory)) return directory;
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory);
    // Keep this path stable: Firecracker records it inside the state file.
    const rootfsPath = path.join(directory, "rootfs.ext4");
    const apiSock = path.join(directory, "api.sock");
    const serialPath = path.join(directory, "serial.log");
    await env.copy(env.rootfsBase, rootfsPath);
    const network = await env.openNetwork?.();
    let child;
    try {
      child = env.spawn({
        bin: env.firecrackerBin, apiSock, serialPath,
        logPath: path.join(directory, "firecracker.log"), network,
      });
      await child.ready;
      await env.waitForApi(apiSock, Date.now() + 15_000);
      await configureAndStart(apiSock, {
        kernelPath: env.kernelPath, rootfsPath,
        vsockPath: path.join(directory, "v.sock"), network,
      });
      // Do not probe vsock: the guest accepts just one connection. Read its
      // serial marker instead, then freeze memory and disk at the same point.
      await waitForGuestReady(serialPath);
      await apiUpdate(apiSock, "/vm", { state: "Paused" }, "PATCH");
      await apiUpdate(apiSock, "/snapshot/create", {
        snapshot_type: "Full", snapshot_path: path.join(directory, "state"),
        mem_file_path: path.join(directory, "memory"),
      });
      await writeFile(path.join(directory, "ready"), "Snapshot contains no user code.\n");
    } catch (error) {
      if (error instanceof Error && !error.message.includes(serialPath)) {
        error.message += `\nserial log: ${serialPath}`;
      }
      throw error;
    } finally {
      child?.kill();
      await network?.release();
    }
    return directory;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
