import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ApiError,
  bootCalls,
  configureAndStart,
  firecrackerArgs,
  putJson,
} from "../src/firecracker.js";

describe("firecracker api", () => {
  it("builds the five boot calls in order", () => {
    const calls = bootCalls({
      kernelPath: "/images/vmlinux",
      rootfsPath: "/run/rootfs.ext4",
      vsockPath: "/run/v.sock",
    });
    assert.deepEqual(calls.map((call) => call.path), [
      "/machine-config",
      "/boot-source",
      "/drives/rootfs",
      "/vsock",
      "/actions",
    ]);
    assert.deepEqual(calls[0]?.body, { vcpu_count: 1, mem_size_mib: 256, smt: false });
    assert.deepEqual(calls[1]?.body, {
      kernel_image_path: "/images/vmlinux",
      boot_args: "keep_bootcon console=ttyS0 reboot=k panic=1",
    });
    assert.deepEqual(calls[2]?.body, {
      drive_id: "rootfs",
      path_on_host: "/run/rootfs.ext4",
      is_root_device: true,
      is_read_only: false,
    });
    assert.deepEqual(calls[3]?.body, { guest_cid: 3, uds_path: "/run/v.sock" });
    assert.deepEqual(calls[4]?.body, { action_type: "InstanceStart" });
  });

  it("uses the v1.17 CLI flags", () => {
    assert.deepEqual(firecrackerArgs("/run/api.sock", "/run/firecracker.log"), [
      "--api-sock",
      "/run/api.sock",
      "--log-path",
      "/run/firecracker.log",
    ]);
  });

  it("PUT returns the status and body", async () => {
    const sock = path.join(os.tmpdir(), `fc-api-${process.pid}.sock`);
    const server = http.createServer((req, res) => {
      res.writeHead(204);
      res.end();
      void req;
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      const result = await putJson(sock, "/machine-config", { vcpu_count: 1 });
      assert.equal(result.status, 204);
    } finally {
      server.close();
    }
  });

  it("PUT rejects when the server never ends the response", async () => {
    const sock = path.join(os.tmpdir(), `fc-api-hang-${process.pid}.sock`);
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.write("partial");
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      await assert.rejects(
        () => putJson(sock, "/machine-config", { vcpu_count: 1 }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /\/machine-config/);
          return true;
        },
      );
    } finally {
      server.close();
    }
  });

  it("configureAndStart throws ApiError when a call is not 204", async () => {
    const sock = path.join(os.tmpdir(), `fc-api-bad-${process.pid}.sock`);
    const server = http.createServer((_req, res) => {
      res.writeHead(400);
      res.end("no kernel");
    });
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      await assert.rejects(
        () => configureAndStart(sock, {
          kernelPath: "/k",
          rootfsPath: "/r",
          vsockPath: "/v",
        }),
        ApiError,
      );
    } finally {
      server.close();
    }
  });
});
