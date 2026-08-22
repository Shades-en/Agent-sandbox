import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_FRAME_BYTES } from "../src/constants.js";
import {
  FrameError,
  decodeFrame,
  encodeFrame,
  parseExecResponse,
} from "../src/frame.js";

describe("frames", () => {
  it("round-trips a request and a response", () => {
    const request = { command: "echo hello" };
    const response = {
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      truncated: false,
    };
    assert.deepEqual(decodeFrame(encodeFrame(request)), request);
    assert.deepEqual(parseExecResponse(decodeFrame(encodeFrame(response))), response);
  });

  it("keeps newlines inside stdout", () => {
    const response = {
      stdout: "a\nb\n",
      stderr: "err\n",
      exitCode: 2,
      truncated: true,
    };
    assert.deepEqual(parseExecResponse(decodeFrame(encodeFrame(response))), response);
  });

  it("rejects a declared length over 1 MiB", () => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    assert.throws(() => decodeFrame(buffer), FrameError);
  });

  it("rejects a truncated buffer", () => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(10, 0);
    assert.throws(() => decodeFrame(buffer), /truncated/);
  });

  it("rejects JSON missing exitCode", () => {
    const encoded = encodeFrame({ stdout: "", stderr: "", truncated: false });
    assert.throws(() => parseExecResponse(decodeFrame(encoded)), /exitCode/);
  });
});
