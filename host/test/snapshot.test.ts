import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultEnv } from "../src/exec.js";
import { ensureSnapshot, snapshotKey, waitForGuestReady } from "../src/snapshot.js";
import { restoreSnapshot } from "../src/firecracker.js";

test("restore loads paused, switches disk, then resumes on a private vsock path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "restore-"));
  const calls: unknown[] = [];
  let rejectDisk = false;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push([req.method, req.url, JSON.parse(body)]);
    if (rejectDisk && req.url === "/drives/rootfs") {
      res.writeHead(400).end("bad disk");
      return;
    }
    res.writeHead(204).end();
  });
  const sock = path.join(dir, "api");
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  try {
    await restoreSnapshot(sock, "/saved", {
      rootfsPath: "/run/disk", vsockPath: "/run/v.sock", kernelPath: "/unused", network: { hostDevName: "tap0" },
    });
    assert.deepEqual(calls, [
      ["PUT", "/snapshot/load", {
        snapshot_path: "/saved/state", mem_backend: { backend_type: "File", backend_path: "/saved/memory" },
        vsock_override: { uds_path: "/run/v.sock" }, resume_vm: false,
        network_overrides: [{ iface_id: "eth0", host_dev_name: "tap0" }],
      }],
      ["PATCH", "/drives/rootfs", { drive_id: "rootfs", path_on_host: "/run/disk" }],
      ["PATCH", "/vm", { state: "Resumed" }],
    ]);
    calls.length = 0;
    await restoreSnapshot(sock, "/host/saved", {
      rootfsPath: "/host/run/disk", vsockPath: "/host/run/v.sock", kernelPath: "/unused", jailed: true,
    });
    assert.deepEqual(calls, [
      ["PUT", "/snapshot/load", {
        snapshot_path: "/snapshot/state", mem_backend: { backend_type: "File", backend_path: "/snapshot/memory" },
        vsock_override: { uds_path: "/sandbox/v.sock" }, resume_vm: false,
      }],
      ["PATCH", "/drives/rootfs", { drive_id: "rootfs", path_on_host: "/sandbox/rootfs.ext4" }],
      ["PATCH", "/vm", { state: "Resumed" }],
    ]);
    // A failed disk switch must leave the VM paused; never run on the template.
    rejectDisk = true;
    calls.length = 0;
    await assert.rejects(restoreSnapshot(sock, "/saved", {
      rootfsPath: "/bad", vsockPath: "/another.sock", kernelPath: "/unused",
    }), /bad disk/);
    assert.equal(calls.length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("one clean snapshot is built, concurrent callers reuse it, and changed images invalidate it", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "snap-"));
  const files = ["kernel", "disk", "firecracker"].map((name) => path.join(home, name));
  await Promise.all(files.map((file) => writeFile(file, "original")));
  let boots = 0;
  let kills = 0;
  let server: http.Server;
  let serial = "";
  let fail = false;
  const env = {
    ...defaultEnv(), openNetwork: undefined, home, kernelPath: files[0], rootfsBase: files[1], firecrackerBin: files[2],
    async copy(_base: string, dest: string) { await writeFile(dest, "boot-disk"); },
    spawn(args: { apiSock: string; serialPath: string }) {
      boots++;
      serial = args.serialPath;
      server = http.createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        if (req.url === "/actions") {
          await writeFile(serial, "SANDBOX_NODE_READY_FOR_SNAPSHOT\n");
        }
        if (req.url === "/snapshot/create") {
          if (fail) { res.writeHead(400).end("cannot snapshot"); return; }
          const parsed = JSON.parse(body);
          await writeFile(parsed.snapshot_path, "state");
          await writeFile(parsed.mem_file_path, "memory");
        }
        res.writeHead(204).end();
      });
      return {
        ready: new Promise<void>((resolve) => server.listen(args.apiSock, resolve)),
        kill() { kills++; server.close(); },
      };
    },
    async waitForApi() {},
  };
  try {
    const [a, b] = await Promise.all([ensureSnapshot(env), ensureSnapshot(env)]);
    assert.equal(a, b);
    assert.equal(boots, 1);
    assert.equal(kills, 1);
    assert.equal(await readFile(path.join(a, "rootfs.ext4"), "utf8"), "boot-disk");
    const key = await snapshotKey(env);
    await writeFile(files[1], "rebuilt-image");
    assert.notEqual(await snapshotKey(env), key);
    fail = true;
    await assert.rejects(ensureSnapshot(env), /cannot snapshot/);
    assert.equal(kills, 2);
    fail = false;
    const c = await ensureSnapshot(env);
    assert.notEqual(a, c);
    assert.equal(boots, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});


test("missing guest readiness fails with an actionable error", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "not-ready-"));
  try {
    await assert.rejects(waitForGuestReady(path.join(home, "serial.log"), 10), /rebuild with scripts\/setup-host.sh/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
