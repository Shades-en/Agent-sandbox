import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { kvmDeniedMessage, kvmMissingMessage, parseExecArgs, runCli, type CliIo } from "../src/cli.js";

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

  it("exits 1 when kvm is not writable and does not exec", async () => {
    let called = false;
    const kvm = path.join(os.tmpdir(), `kvm-denied-${process.pid}`);
    fs.writeFileSync(kvm, "");
    fs.chmodSync(kvm, 0);
    const context = io({
      kvmPath: kvm,
      async exec() {
        called = true;
        return { stdout: "", stderr: "", exitCode: 0, runDir: "" };
      },
    });
    try {
      const code = await runCli(["exec", "--", "echo hello"], context);
      assert.equal(code, 1);
      assert.equal(called, false);
      assert.equal(context.err, `${kvmDeniedMessage()}\n`);
    } finally {
      fs.chmodSync(kvm, 0o644);
      fs.unlinkSync(kvm);
    }
  });

  it("passes a non-zero guest exit and guest stderr through", async () => {
    const kvm = path.join(os.tmpdir(), `kvm-guest-${process.pid}`);
    fs.writeFileSync(kvm, "");
    const context = io({
      kvmPath: kvm,
      async exec() {
        return { stdout: "", stderr: "no\n", exitCode: 1, runDir: "/run/1" };
      },
    });
    try {
      const code = await runCli(["exec", "--", "false"], context);
      assert.equal(code, 1);
      assert.equal(context.out, "");
      assert.equal(context.err, "no\n");
    } finally {
      fs.unlinkSync(kvm);
    }
  });

  it("passes a command timeout through unchanged", async () => {
    const kvm = path.join(os.tmpdir(), `kvm-timeout-${process.pid}`);
    fs.writeFileSync(kvm, "");
    const context = io({
      kvmPath: kvm,
      async exec() {
        return { stdout: "", stderr: "timeout\n", exitCode: 124, runDir: "/run/1" };
      },
    });
    try {
      const code = await runCli(["exec", "--", "sleep 30"], context);
      assert.equal(code, 124);
      assert.equal(context.out, "");
      assert.equal(context.err, "timeout\n");
    } finally {
      fs.unlinkSync(kvm);
    }
  });

  it("wraps an exec rejection as a sandbox failure", async () => {
    const kvm = path.join(os.tmpdir(), `kvm-wrap-${process.pid}`);
    fs.writeFileSync(kvm, "");
    const context = io({
      kvmPath: kvm,
      async exec() {
        throw new Error("API socket did not open\nserial log: /run/1/serial.log");
      },
    });
    try {
      const code = await runCli(["exec", "--", "echo hello"], context);
      assert.equal(code, 1);
      assert.equal(context.err, "sandbox: API socket did not open\nserial log: /run/1/serial.log\n");
    } finally {
      fs.unlinkSync(kvm);
    }
  });
});
