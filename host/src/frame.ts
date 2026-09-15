import { MAX_FRAME_BYTES } from "./constants.js";

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export interface ExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

// A frame is 4 big-endian length bytes, then that many UTF-8 JSON bytes.
// Both the Lima host and the guest use this layout on the vsock pipe.
export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new FrameError("frame too large");
  }
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

export function decodeFrame(buffer: Buffer): unknown {
  if (buffer.length < 4) {
    throw new FrameError("truncated");
  }
  const length = buffer.readUInt32BE(0);
  if (length > MAX_FRAME_BYTES) {
    throw new FrameError("frame too large");
  }
  if (buffer.length < 4 + length) {
    throw new FrameError("truncated");
  }
  const json = buffer.subarray(4, 4 + length).toString("utf8");
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new FrameError("invalid JSON");
  }
}

export function parseExecResponse(value: unknown): ExecResponse {
  if (typeof value !== "object" || value === null) {
    throw new FrameError("response is not an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.stdout !== "string") throw new FrameError("stdout missing");
  if (typeof record.stderr !== "string") throw new FrameError("stderr missing");
  if (typeof record.exitCode !== "number" || !Number.isInteger(record.exitCode)) {
    throw new FrameError("exitCode missing");
  }
  if (record.exitCode < 0 || record.exitCode > 255) {
    throw new FrameError("exitCode out of range");
  }
  if (typeof record.truncated !== "boolean") {
    throw new FrameError("truncated missing");
  }
  return {
    stdout: record.stdout,
    stderr: record.stderr,
    exitCode: record.exitCode,
    truncated: record.truncated,
  };
}
