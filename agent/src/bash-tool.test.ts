import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { interpretControllerResult, sandboxArgs } from "./bash-tool.js";

describe("bash tool", () => {
  it("builds the limactl command", () => {
    assert.deepEqual(sandboxArgs("/repo/host/dist/cli.js", "echo hello"), [
      "shell",
      "fc",
      "--",
      "node",
      "/repo/host/dist/cli.js",
      "exec",
      "--timeout",
      "10",
      "--",
      "echo hello",
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
