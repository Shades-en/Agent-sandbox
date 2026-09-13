import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { CommandTimeoutError } from "../src/vsock.js";
import { defaultEnv, execCommand } from "../src/exec.js";

describe("execCommand", () => {
  it("copies the rootfs, configures, exchanges one command, and kills the process", async () => {
    const calls: string[] = [];
    let killed = false;
    const result = await execCommand("echo hello", 10, {
      home: "/tmp/sandbox",
      kernelPath: "/images/vmlinux",
      rootfsBase: "/images/rootfs.ext4",
      firecrackerBin: "/bin/firecracker",
      async copy(base, dest) {
        calls.push(`copy ${base} ${dest}`);
      },
      spawn() {
        calls.push("spawn");
        return { kill() { killed = true; }, ready: Promise.resolve() };
      },
      async waitForApi() {
        calls.push("wait");
      },
      async configure(_apiSock, request) {
        calls.push(`configure ${request.rootfsPath}`);
      },
      async exchange(_vsock, command) {
        calls.push(`exchange ${command}`);
        return { stdout: "hello\n", stderr: "", exitCode: 0, truncated: false };
      },
      log() {},
    });
    assert.equal(result.stdout, "hello\n");
    assert.equal(result.exitCode, 0);
    assert.equal(killed, true);
    assert.deepEqual(calls.map((call) => call.split(" ")[0]), [
      "copy",
      "spawn",
      "wait",
      "configure",
      "exchange",
    ]);
  });

  it("returns timeout and still kills the process", async () => {
    let killed = false;
    const result = await execCommand("sleep 30", 1, {
      home: "/tmp/sandbox",
      kernelPath: "/k",
      rootfsBase: "/r",
      firecrackerBin: "/bin/firecracker",
      async copy() {},
      spawn() {
        return { kill() { killed = true; }, ready: Promise.resolve() };
      },
      async waitForApi() {},
      async configure() {},
      async exchange() {
        throw new CommandTimeoutError();
      },
      log() {},
    });
    assert.equal(result.exitCode, 124);
    assert.equal(result.stderr, "timeout\n");
    assert.equal(result.stdout, "");
    assert.equal(killed, true);
  });

  it("rejects a failed boot instead of returning a command timeout", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "exec-boot-"));
    await assert.rejects(
      () => execCommand("echo", 10, {
        home,
        kernelPath: "/k",
        rootfsBase: "/r",
        firecrackerBin: "/bin/firecracker",
        async copy() {},
        spawn() {
          return { kill() {}, ready: Promise.resolve() };
        },
        async waitForApi() {},
        async configure() {},
        async exchange() {
          throw new Error("no vsock CONNECT within 15000ms");
        },
        log() {},
      }),
      (error: Error) => {
        assert.match(error.message, /no vsock CONNECT within 15000ms/);
        assert.match(error.message, /serial log:/);
        return true;
      },
    );
  });

  it("records a reflink refusal beside the run, not on stderr", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "exec-copy-"));
    const base = path.join(home, "base");
    const dest = path.join(home, "run", "rootfs.ext4");
    await mkdir(path.dirname(dest), { recursive: true });
    fs.writeFileSync(base, "image");
    const written: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await defaultEnv().copy(base, dest);
    } finally {
      process.stderr.write = original;
    }
    assert.equal(fs.readFileSync(dest, "utf8"), "image");
    assert.deepEqual(written, []);
    const note = path.join(home, "run", "controller.log");
    if (fs.existsSync(note)) {
      assert.match(fs.readFileSync(note, "utf8"), /reflink refused/);
    }
  });

  it("rejects when spawn fails and still kills the process", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "exec-spawn-err-"));
    const missingBin = path.join(home, "missing-firecracker");
    let killed = false;
    const realSpawn = defaultEnv().spawn;
    await assert.rejects(
      () => execCommand("echo", 10, {
        home,
        kernelPath: "/k",
        rootfsBase: "/r",
        firecrackerBin: missingBin,
        async copy() {},
        spawn(args) {
          const handle = realSpawn(args);
          const kill = handle.kill.bind(handle);
          return {
            ready: handle.ready,
            kill() {
              killed = true;
              kill();
            },
          };
        },
        async waitForApi() {
          throw new Error("waitForApi should not run");
        },
        async configure() {
          throw new Error("configure should not run");
        },
        async exchange() {
          throw new Error("exchange should not run");
        },
        log() {},
      }),
      (error: Error) => {
        assert.match(error.message, new RegExp(`failed to spawn ${missingBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        return true;
      },
    );
    assert.equal(killed, true);
  });
});
