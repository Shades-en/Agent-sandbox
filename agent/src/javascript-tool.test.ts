import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { interpretControllerResult, parseTimingReport, sandboxArgs } from "./javascript-tool.js";

describe("javascript tool", () => {
  it("builds the limactl command", () => {
    assert.deepEqual(sandboxArgs("/repo/host/dist/cli.js", "console.log('hello')"), [
      "shell",
      "fc",
      "--",
      "node",
      "/repo/host/dist/cli.js",
      "exec",
      "--timeout",
      "10",
      "--",
      "console.log('hello')",
    ]);
  });

  it("returns a guest failure as data", () => {
    assert.deepEqual(
      interpretControllerResult({ stdout: "", stderr: "", exitCode: 1 }),
      { stdout: "", stderr: "", exitCode: 1 },
    );
  });

  it("returns a timeout result", () => {
    assert.deepEqual(
      interpretControllerResult({ stdout: "", stderr: "timeout\n", exitCode: 124 }),
      { stdout: "", stderr: "timeout", exitCode: 124 },
    );
  });

  it("rejects controller failures", () => {
    assert.throws(
      () => interpretControllerResult({
        stdout: "",
        stderr: "sandbox: /dev/kvm is missing\n",
        exitCode: 1,
      }),
      /kvm/,
    );
  });

  it("returns a guest exit 124 as data", () => {
    assert.deepEqual(
      interpretControllerResult({ stdout: "nope\n", stderr: "still running\n", exitCode: 124 }),
      { stdout: "nope\n", stderr: "still running\n", exitCode: 124 },
    );
  });

  it("rejects a limactl failure", () => {
    assert.throws(
      () => interpretControllerResult({
        stdout: "",
        stderr: "FATA[0000] instance fc is stopped\n",
        exitCode: 1,
      }),
      /stopped/,
    );
  });
});


describe("timing report", () => {
  it("keeps guest output separate from timing diagnostics, including timeout detection", () => {
    for (const guest of [
      { stdout: "hello\n", stderr: "[timing sandbox] user text\n", exitCode: 0 },
      { stdout: "", stderr: "timeout\n", exitCode: 124 },
    ]) {
      const report = parseTimingReport({
        stdout: JSON.stringify({ ...guest, runDir: "/run/1", timings: { "sandbox.total": 10 } }),
        stderr: "", exitCode: guest.exitCode,
      });
      assert.deepEqual(report.result, guest);
      assert.deepEqual(report.timings, { "sandbox.total": 10 });
      if (guest.exitCode === 124) assert.equal(interpretControllerResult(report.result).stderr, "timeout");
      assert.equal("timings" in report.result, false);
    }
  });
  it("rejects infrastructure failures and malformed reports", () => {
    assert.throws(() => parseTimingReport({ stdout: "", stderr: "FATA[0000] fc stopped", exitCode: 1 }), /stopped/);
    assert.throws(() => parseTimingReport({ stdout: "hello", stderr: "", exitCode: 0 }), /invalid controller/);
    assert.throws(() => parseTimingReport({ stdout: JSON.stringify({ stdout: "", stderr: "", exitCode: 0, timings: { total: "wrong" } }), stderr: "", exitCode: 0 }), /invalid controller/);
  });
  it("requests a structured report only in timing mode", () => {
    const args = sandboxArgs("/cli.js", "console.log(1)", true);
    assert.deepEqual(args.slice(-4), ["--timings", "--json", "--", "console.log(1)"]);
  });
});
