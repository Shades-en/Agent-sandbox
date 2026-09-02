import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CommandTimeoutError } from "../src/vsock.js";
import { execCommand } from "../src/exec.js";

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
        return { kill() { killed = true; } };
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
        return { kill() { killed = true; } };
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
});
