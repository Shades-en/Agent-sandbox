import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { kvmMissingMessage, parseExecArgs, runCli, type CliIo } from "../src/cli.js";

function io(overrides: Partial<CliIo> = {}): CliIo & { out: string; err: string } {
  const state = { out: "", err: "" };
  return {
    kvmPath: fs.existsSync("/dev/kvm") ? "/dev/kvm" : path.join(os.tmpdir(), "present-kvm"),
    stdout: (chunk) => {
      state.out += chunk;
    },
    stderr: (chunk) => {
      state.err += chunk;
    },
    async exec() {
      return { stdout: "hello\n", stderr: "", exitCode: 0, runDir: "/run/1" };
    },
    ...overrides,
    get out() {
      return state.out;
    },
    get err() {
      return state.err;
    },
  };
}

describe("cli", () => {
  it("joins the command after --", () => {
    assert.deepEqual(parseExecArgs(["exec", "--timeout", "3", "--", "echo", "hello"]), {
      timeoutSec: 3,
      command: "echo hello",
    });
  });

  it("defaults the timeout to 10 seconds", () => {
    assert.equal(parseExecArgs(["exec", "--", "true"]).timeoutSec, 10);
  });

  it("exits 1 when kvm is missing and does not exec", async () => {
    let called = false;
    const missing = path.join(os.tmpdir(), `no-kvm-${process.pid}`);
    const context = io({
      kvmPath: missing,
      async exec() {
        called = true;
        return { stdout: "", stderr: "", exitCode: 0, runDir: "" };
      },
    });
    const code = await runCli(["exec", "--", "echo hello"], context);
    assert.equal(code, 1);
    assert.equal(called, false);
    assert.equal(context.err, `${kvmMissingMessage()}\n`);
  });

  it("prints guest streams and returns the guest exit code", async () => {
    const kvm = path.join(os.tmpdir(), `kvm-${process.pid}`);
    fs.writeFileSync(kvm, "");
    const context = io({
      kvmPath: kvm,
      async exec(command) {
        assert.equal(command, "echo hello");
        return { stdout: "hello\n", stderr: "", exitCode: 0, runDir: "/run/1" };
      },
    });
    const code = await runCli(["exec", "--", "echo", "hello"], context);
    assert.equal(code, 0);
    assert.equal(context.out, "hello\n");
    fs.unlinkSync(kvm);
  });
});
