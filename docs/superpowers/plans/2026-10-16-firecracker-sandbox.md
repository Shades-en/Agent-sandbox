# Firecracker command sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boot a Firecracker microVM from this repo and return one bash command's stdout, stderr, and exit code, then call that path from an Ari tool.

**Architecture:** A TypeScript controller in `host/` runs inside a Lima VM named `fc`. It speaks Firecracker's HTTP API over a Unix socket, then a `CONNECT` handshake on a second Unix socket that Firecracker bridges to the guest's `AF_VSOCK` port 5000. `guest/agent.py` runs the command. `agent/` on the Mac imports Ari and shells out to `limactl shell fc`.

**Tech Stack:** Node.js 24, TypeScript (`NodeNext`), `node:test`, Python 3, Firecracker v1.17.0, Lima 2.1 (`vmType: vz`), Ari via `file:../../ai/ari`.

## Global Constraints

- Firecracker version is v1.17.0, asset `firecracker-v1.17.0-aarch64.tgz`, sha256 `e351ebe4f7a16b5873bbd51005d2e6767103cff4d5ebc829df2d3f95a93e2256`.
- Guest kernel and Ubuntu squashfs come from `https://s3.amazonaws.com/spec.ccfc.min`. URLs are written to `~/.sandbox/manifest.json` and reused. The ext4 image is rebuilt on every `scripts/setup-host.sh` run.
- Large artifacts live under `~/.sandbox/` inside the Lima VM, never in git.
- `host/` must not depend on Ari. `agent/` depends on `ari` at `file:../../ai/ari`.
- Machine config: `vcpu_count` 1, `mem_size_mib` 256, `smt` false.
- Boot args: `keep_bootcon console=ttyS0 reboot=k panic=1`.
- Vsock: `guest_cid` 3, guest port 5000. Host handshake is `CONNECT 5000\n` then `OK <port>\n`.
- Frame: 4-byte big-endian length plus UTF-8 JSON. Maximum frame 1 MiB. Guest caps stdout and stderr at 256 KiB each.
- Boot deadline is 15 seconds. Default command timeout is 10 seconds.
- API PUT success is HTTP 204. No network interface. No jailer. No snapshots. No `InstanceHalt`.
- Controller-generated failures print stderr starting with `sandbox: ` and exit 1, except command timeout, which prints exactly `timeout\n` and exits 124.
- Guest `exitCode` in `0..255` is the controller's process exit code. The Ari tool returns that object. It rejects only when stderr starts with `sandbox: `.
- Each `exec` copies the base rootfs into `~/.sandbox/run/<pid>-<8 hex>/` and kills Firecracker in a `finally` block. The run directory stays.
- Do not modify the Ari repository.

---

### Task 1: Frame codec

**Files:**
- Create: `host/package.json`
- Create: `host/tsconfig.json`
- Create: `host/src/constants.ts`
- Create: `host/src/frame.ts`
- Create: `host/test/frame.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `MAX_FRAME_BYTES`, `MAX_STREAM_BYTES`, `BOOT_TIMEOUT_MS` (15000), `DEFAULT_COMMAND_TIMEOUT_SEC` (10), `VSOCK_PORT` (5000), `GUEST_CID` (3), `MEM_SIZE_MIB` (256), `VCPU_COUNT` (1), `BOOT_ARGS` (`keep_bootcon console=ttyS0 reboot=k panic=1`)
  - `class FrameError extends Error`
  - `encodeFrame(payload: unknown): Buffer`
  - `decodeFrame(buffer: Buffer): unknown`
  - `interface ExecResponse { stdout: string; stderr: string; exitCode: number; truncated: boolean }`
  - `parseExecResponse(value: unknown): ExecResponse`

- [ ] **Step 1: Write the failing test**

Create `host/package.json`:

```json
{
  "name": "sandbox-host",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "tsc -p tsconfig.json && node --test dist/test/frame.test.js"
  },
  "devDependencies": {
    "@types/node": "^26.1.1",
    "typescript": "^5.9.3"
  }
}
```

Create `host/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
*.tsbuildinfo
.DS_Store
```

Create `host/test/frame.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && pnpm install && pnpm test`

Expected: FAIL. `tsc` cannot find `../src/frame.js` or `../src/constants.js`.

- [ ] **Step 3: Write minimal implementation**

Create `host/src/constants.ts`:

```ts
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_STREAM_BYTES = 256 * 1024;
export const BOOT_TIMEOUT_MS = 15_000;
export const DEFAULT_COMMAND_TIMEOUT_SEC = 10;
export const VSOCK_PORT = 5000;
export const GUEST_CID = 3;
export const MEM_SIZE_MIB = 256;
export const VCPU_COUNT = 1;
export const BOOT_ARGS = "keep_bootcon console=ttyS0 reboot=k panic=1";
```

Create `host/src/frame.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && pnpm test`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add .gitignore host/package.json host/pnpm-lock.yaml host/tsconfig.json host/src/constants.ts host/src/frame.ts host/test/frame.test.ts
git commit -m "$(cat <<'EOF'
Add the length-prefixed JSON frame codec.

EOF
)"
```

---

### Task 2: Guest agent

**Files:**
- Create: `guest/agent.py`
- Create: `guest/sandbox-agent.service`
- Create: `guest/test_agent.py`

**Interfaces:**
- Consumes: the frame layout from Task 1 (`>I` length, JSON fields `command`, `stdout`, `stderr`, `exitCode`, `truncated`). Caps match `MAX_STREAM_BYTES`.
- Produces: `guest/agent.py` functions `encode_frame`, `decode_frame`, `cap_text`, `run_command`, and `main`. systemd unit `sandbox-agent.service` starts `/usr/bin/python3 /opt/sandbox/agent.py`.

- [ ] **Step 1: Write the failing test**

Create `guest/test_agent.py`:

```python
import unittest

from agent import cap_text, decode_frame, encode_frame, run_command

MAX_STREAM = 256 * 1024


class AgentTest(unittest.TestCase):
    def test_round_trip(self):
        payload = {"command": "echo hello"}
        self.assertEqual(decode_frame(encode_frame(payload)), payload)

    def test_cap_text_marks_truncation(self):
        text, truncated = cap_text("x" * (MAX_STREAM + 10))
        self.assertTrue(truncated)
        self.assertLessEqual(len(text.encode("utf-8")), MAX_STREAM)

    def test_run_command_echo(self):
        result = run_command("echo hello")
        self.assertEqual(result["stdout"], "hello\n")
        self.assertEqual(result["stderr"], "")
        self.assertEqual(result["exitCode"], 0)
        self.assertFalse(result["truncated"])

    def test_run_command_false(self):
        result = run_command("false")
        self.assertNotEqual(result["exitCode"], 0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd guest && python3 -m unittest test_agent.py -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'agent'`.

- [ ] **Step 3: Write minimal implementation**

Create `guest/agent.py`:

```python
#!/usr/bin/env python3
"""Listen on vsock port 5000 and run one bash command."""

import json
import socket
import struct
import subprocess

MAX_FRAME = 1024 * 1024
MAX_STREAM = 256 * 1024
PORT = 5000
GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


def encode_frame(payload: dict) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    if len(body) > MAX_FRAME:
        raise ValueError("frame too large")
    return struct.pack(">I", len(body)) + body


def decode_frame(buf: bytes) -> dict:
    if len(buf) < 4:
        raise ValueError("truncated")
    (length,) = struct.unpack(">I", buf[:4])
    if length > MAX_FRAME:
        raise ValueError("frame too large")
    if len(buf) < 4 + length:
        raise ValueError("truncated")
    return json.loads(buf[4 : 4 + length])


def cap_text(text: str) -> tuple[str, bool]:
    raw = text.encode("utf-8")
    if len(raw) <= MAX_STREAM:
        return text, False
    return raw[:MAX_STREAM].decode("utf-8", errors="ignore"), True


def run_command(command: str) -> dict:
    completed = subprocess.run(
        ["bash", "-c", command],
        cwd="/",
        env={"PATH": GUEST_PATH},
        capture_output=True,
    )
    stdout, out_cut = cap_text(completed.stdout.decode("utf-8", errors="replace"))
    stderr, err_cut = cap_text(completed.stderr.decode("utf-8", errors="replace"))
    return {
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": completed.returncode,
        "truncated": out_cut or err_cut,
    }


def _read_exact(conn: socket.socket, n: int) -> bytes:
    chunks = []
    got = 0
    while got < n:
        piece = conn.recv(n - got)
        if not piece:
            raise ValueError("truncated")
        chunks.append(piece)
        got += len(piece)
    return b"".join(chunks)


def handle(conn: socket.socket) -> None:
    header = _read_exact(conn, 4)
    (length,) = struct.unpack(">I", header)
    if length > MAX_FRAME:
        raise ValueError("frame too large")
    body = _read_exact(conn, length)
    request = json.loads(body)
    command = request["command"]
    if not isinstance(command, str):
        raise ValueError("command missing")
    conn.sendall(encode_frame(run_command(command)))


def main() -> None:
    server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    server.bind((socket.VMADDR_CID_ANY, PORT))
    server.listen(1)
    conn, _ = server.accept()
    try:
        handle(conn)
    finally:
        conn.close()
        server.close()


if __name__ == "__main__":
    main()
```

Create `guest/sandbox-agent.service`:

```ini
[Unit]
Description=Sandbox vsock command agent
After=local-fs.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/sandbox/agent.py
Restart=no

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd guest && python3 -m unittest test_agent.py -v`

Expected: PASS, 4 tests. `main` is not imported by the test, so the Mac does not need `AF_VSOCK`.

- [ ] **Step 5: Commit**

```bash
git add guest/agent.py guest/sandbox-agent.service guest/test_agent.py
git commit -m "$(cat <<'EOF'
Add the guest vsock agent that runs one bash command.

EOF
)"
```

---

### Task 3: Vsock handshake and frame IO

**Files:**
- Create: `host/src/vsock.ts`
- Create: `host/test/vsock.test.ts`
- Modify: `host/package.json` scripts.test so it also runs `dist/test/vsock.test.js`

**Interfaces:**
- Consumes: `encodeFrame`, `decodeFrame`, `parseExecResponse`, `BOOT_TIMEOUT_MS`, `VSOCK_PORT` from Task 1
- Produces:
  - `parseConnectAck(line: string): number`
  - `class CommandTimeoutError extends Error`
  - `connectAndExchange(udsPath: string, command: string, commandTimeoutMs: number): Promise<ExecResponse>`

- [ ] **Step 1: Write the failing test**

Create `host/test/vsock.test.ts`:

```ts
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { encodeFrame } from "../src/frame.js";
import { connectAndExchange, parseConnectAck } from "../src/vsock.js";

describe("vsock handshake", () => {
  it("parses OK port", () => {
    assert.equal(parseConnectAck("OK 52"), 52);
  });

  it("rejects a line that is not OK", () => {
    assert.throws(() => parseConnectAck("NO 52"));
  });

  it("connects, reads the ack, and returns the guest frame", async () => {
    const sockPath = path.join(os.tmpdir(), `vsock-test-${process.pid}.sock`);
    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (!buf.includes("\n")) return;
        socket.write("OK 5000\n");
        socket.end(encodeFrame({
          stdout: "hello\n",
          stderr: "",
          exitCode: 0,
          truncated: false,
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      const result = await connectAndExchange(sockPath, "echo hello", 2000);
      assert.equal(result.stdout, "hello\n");
      assert.equal(result.exitCode, 0);
    } finally {
      server.close();
    }
  });
});
```

Update the `test` script in `host/package.json` to:

```json
"test": "tsc -p tsconfig.json && node --test dist/test/frame.test.js dist/test/vsock.test.js"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && pnpm test`

Expected: FAIL. `tsc` cannot find `../src/vsock.js`.

- [ ] **Step 3: Write minimal implementation**

Create `host/src/vsock.ts`:

```ts
import net from "node:net";

import { BOOT_TIMEOUT_MS, VSOCK_PORT } from "./constants.js";
import {
  decodeFrame,
  encodeFrame,
  parseExecResponse,
  type ExecResponse,
} from "./frame.js";

export class CommandTimeoutError extends Error {
  constructor() {
    super("timeout");
    this.name = "CommandTimeoutError";
  }
}

export function parseConnectAck(line: string): number {
  const match = /^OK (\d+)$/.exec(line);
  if (!match) throw new Error(`bad vsock ack: ${line}`);
  return Number(match[1]);
}

function readExact(socket: net.Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let got = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new CommandTimeoutError());
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      got += chunk.length;
      if (got >= n) {
        cleanup();
        const all = Buffer.concat(chunks);
        const extra = all.subarray(n);
        if (extra.length > 0) socket.unshift(extra);
        resolve(all.subarray(0, n));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

async function readLine(socket: net.Socket, timeoutMs: number): Promise<string> {
  let buf = Buffer.alloc(0);
  while (!buf.includes(0x0a)) {
    const next = await readExact(socket, 1, timeoutMs);
    buf = Buffer.concat([buf, next]);
  }
  return buf.toString("utf8").replace(/\n$/, "");
}

function connectOnce(udsPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(udsPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function connectGuest(udsPath: string, deadline: number): Promise<net.Socket> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const socket = await connectOnce(udsPath);
      socket.write(`CONNECT ${VSOCK_PORT}\n`);
      const line = await readLine(socket, deadline - Date.now());
      parseConnectAck(line);
      return socket;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("vsock connect failed");
}

export async function connectAndExchange(
  udsPath: string,
  command: string,
  commandTimeoutMs: number,
): Promise<ExecResponse> {
  const socket = await connectGuest(udsPath, Date.now() + BOOT_TIMEOUT_MS);
  try {
    const frame = encodeFrame({ command });
    await new Promise<void>((resolve, reject) => {
      socket.write(frame, (error) => (error ? reject(error) : resolve()));
    });
    const header = await readExact(socket, 4, commandTimeoutMs);
    const length = header.readUInt32BE(0);
    const body = await readExact(socket, length, commandTimeoutMs);
    return parseExecResponse(decodeFrame(Buffer.concat([header, body])));
  } finally {
    socket.destroy();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && pnpm test`

Expected: PASS. The mock server must receive a buffer that starts with `CONNECT 5000\n`. The test above checks the returned frame. If the ack parser throws, the test fails.

- [ ] **Step 5: Commit**

```bash
git add host/src/vsock.ts host/test/vsock.test.ts host/package.json
git commit -m "$(cat <<'EOF'
Add the host vsock CONNECT handshake and frame exchange.

EOF
)"
```

---

### Task 4: Firecracker API client

**Files:**
- Create: `host/src/firecracker.ts`
- Create: `host/test/firecracker.test.ts`
- Modify: `host/package.json` `test` script to include `dist/test/firecracker.test.js`

**Interfaces:**
- Consumes: `BOOT_ARGS`, `GUEST_CID`, `MEM_SIZE_MIB`, `VCPU_COUNT`
- Produces:
  - `interface BootRequest { kernelPath: string; rootfsPath: string; vsockPath: string }`
  - `interface ApiCall { path: string; body: unknown }`
  - `bootCalls(request: BootRequest): ApiCall[]`
  - `firecrackerArgs(apiSock: string, logPath: string): string[]`
  - `putJson(socketPath: string, urlPath: string, body: unknown): Promise<{ status: number; body: string }>`
  - `class ApiError extends Error`
  - `configureAndStart(apiSock: string, request: BootRequest): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `host/test/firecracker.test.ts`:

```ts
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
```

Set `host/package.json` `scripts.test` to:

```json
"test": "tsc -p tsconfig.json && node --test dist/test/frame.test.js dist/test/vsock.test.js dist/test/firecracker.test.js"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && pnpm test`

Expected: FAIL because `host/src/firecracker.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `host/src/firecracker.ts`:

```ts
import http from "node:http";

import { BOOT_ARGS, GUEST_CID, MEM_SIZE_MIB, VCPU_COUNT } from "./constants.js";

export class ApiError extends Error {
  constructor(
    readonly urlPath: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`API PUT ${urlPath} returned ${status}: ${responseBody}`);
    this.name = "ApiError";
  }
}

export interface BootRequest {
  kernelPath: string;
  rootfsPath: string;
  vsockPath: string;
}

export interface ApiCall {
  path: string;
  body: unknown;
}

export function bootCalls(request: BootRequest): ApiCall[] {
  return [
    {
      path: "/machine-config",
      body: { vcpu_count: VCPU_COUNT, mem_size_mib: MEM_SIZE_MIB, smt: false },
    },
    {
      path: "/boot-source",
      body: { kernel_image_path: request.kernelPath, boot_args: BOOT_ARGS },
    },
    {
      path: "/drives/rootfs",
      body: {
        drive_id: "rootfs",
        path_on_host: request.rootfsPath,
        is_root_device: true,
        is_read_only: false,
      },
    },
    {
      path: "/vsock",
      body: { guest_cid: GUEST_CID, uds_path: request.vsockPath },
    },
    {
      path: "/actions",
      body: { action_type: "InstanceStart" },
    },
  ];
}

export function firecrackerArgs(apiSock: string, logPath: string): string[] {
  return ["--api-sock", apiSock, "--log-path", logPath];
}

export function putJson(
  socketPath: string,
  urlPath: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

export async function configureAndStart(apiSock: string, request: BootRequest): Promise<void> {
  for (const call of bootCalls(request)) {
    const result = await putJson(apiSock, call.path, call.body);
    if (result.status !== 204) {
      throw new ApiError(call.path, result.status, result.body);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && pnpm test`

Expected: PASS, including the four new tests.

- [ ] **Step 5: Commit**

```bash
git add host/src/firecracker.ts host/test/firecracker.test.ts host/package.json
git commit -m "$(cat <<'EOF'
Add the Firecracker API boot sequence.

EOF
)"
```

---

### Task 5: Exec orchestration

**Files:**
- Create: `host/src/exec.ts`
- Create: `host/test/exec.test.ts`
- Modify: `host/package.json` `test` script to include `dist/test/exec.test.js`

**Interfaces:**
- Consumes: `configureAndStart`, `firecrackerArgs`, `connectAndExchange`, `CommandTimeoutError`, `ApiError`, `BOOT_TIMEOUT_MS`
- Produces:
  - `interface ExecResult { stdout: string; stderr: string; exitCode: number; runDir: string }`
  - `copyRootfs(base: string, dest: string, log: (line: string) => void): Promise<void>`
  - `execCommand(command: string, timeoutSec: number, env?: Partial<ExecEnv>): Promise<ExecResult>`
  - `interface ExecEnv` with `home`, `kernelPath`, `rootfsBase`, `firecrackerBin`, `spawn`, `configure`, `exchange`, `copy`, `waitForApi`, `log`

- [ ] **Step 1: Write the failing test**

Create `host/test/exec.test.ts`:

```ts
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
```

Set `host/package.json` `scripts.test` to:

```json
"test": "tsc -p tsconfig.json && node --test dist/test/frame.test.js dist/test/vsock.test.js dist/test/firecracker.test.js dist/test/exec.test.js"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && pnpm test`

Expected: FAIL because `host/src/exec.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `host/src/exec.ts`:

```ts
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { BOOT_TIMEOUT_MS } from "./constants.js";
import { configureAndStart, firecrackerArgs, type BootRequest } from "./firecracker.js";
import { CommandTimeoutError, connectAndExchange } from "./vsock.js";
import type { ExecResponse } from "./frame.js";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  runDir: string;
}

export interface FirecrackerHandle {
  kill: () => void;
}

export interface ExecEnv {
  home: string;
  kernelPath: string;
  rootfsBase: string;
  firecrackerBin: string;
  copy: (base: string, dest: string) => Promise<void>;
  spawn: (args: { bin: string; apiSock: string; logPath: string; serialPath: string }) => FirecrackerHandle;
  waitForApi: (apiSock: string, deadline: number) => Promise<void>;
  configure: (apiSock: string, request: BootRequest) => Promise<void>;
  exchange: (vsockPath: string, command: string, timeoutMs: number) => Promise<ExecResponse>;
  log: (line: string) => void;
}

export async function copyRootfs(base: string, dest: string, log: (line: string) => void): Promise<void> {
  try {
    await execFileAsync("cp", ["--reflink=always", base, dest]);
  } catch {
    log("reflink refused; copied rootfs byte for byte");
    await execFileAsync("cp", [base, dest]);
  }
}

async function waitForSocket(apiSock: string, deadline: number): Promise<void> {
  const net = await import("node:net");
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(apiSock);
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("API socket did not open");
}

function spawnFirecracker(args: {
  bin: string;
  apiSock: string;
  logPath: string;
  serialPath: string;
}): FirecrackerHandle {
  const serial = fs.openSync(args.serialPath, "a");
  const child: ChildProcess = spawn(
    args.bin,
    firecrackerArgs(args.apiSock, args.logPath),
    { stdio: ["ignore", serial, serial] },
  );
  return { kill: () => child.kill("SIGKILL") };
}

export function defaultEnv(): ExecEnv {
  const home = path.join(os.homedir(), ".sandbox");
  return {
    home,
    kernelPath: path.join(home, "images", "vmlinux"),
    rootfsBase: path.join(home, "images", "rootfs.ext4"),
    firecrackerBin: path.join(home, "bin", "firecracker"),
    async copy(base, dest) {
      await copyRootfs(base, dest, (line) => process.stderr.write(`${line}\n`));
    },
    spawn: spawnFirecracker,
    waitForApi: waitForSocket,
    configure: configureAndStart,
    exchange: connectAndExchange,
    log(line) {
      process.stderr.write(`${line}\n`);
    },
  };
}

export async function execCommand(
  command: string,
  timeoutSec: number,
  overrides: Partial<ExecEnv> = {},
): Promise<ExecResult> {
  const env: ExecEnv = { ...defaultEnv(), ...overrides };
  const id = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const runDir = path.join(env.home, "run", id);
  await mkdir(runDir, { recursive: true });
  const rootfsPath = path.join(runDir, "rootfs.ext4");
  await env.copy(env.rootfsBase, rootfsPath);
  const apiSock = path.join(runDir, "api.sock");
  const vsockPath = path.join(runDir, "v.sock");
  const logPath = path.join(runDir, "firecracker.log");
  const serialPath = path.join(runDir, "serial.log");
  const child = env.spawn({
    bin: env.firecrackerBin,
    apiSock,
    logPath,
    serialPath,
  });
  try {
    await env.waitForApi(apiSock, Date.now() + BOOT_TIMEOUT_MS);
    await env.configure(apiSock, {
      kernelPath: env.kernelPath,
      rootfsPath,
      vsockPath,
    });
    const response = await env.exchange(vsockPath, command, timeoutSec * 1000);
    return {
      stdout: response.stdout,
      stderr: response.stderr,
      exitCode: response.exitCode,
      runDir,
    };
  } catch (error) {
    if (error instanceof CommandTimeoutError) {
      return { stdout: "", stderr: "timeout\n", exitCode: 124, runDir };
    }
    if (error instanceof Error) {
      error.message = `${error.message}\nserial log: ${serialPath}`;
    }
    throw error;
  } finally {
    child.kill();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && pnpm test`

Expected: PASS. `execCommand` with fakes must not spawn a real Firecracker process.

- [ ] **Step 5: Commit**

```bash
git add host/src/exec.ts host/test/exec.test.ts host/package.json
git commit -m "$(cat <<'EOF'
Orchestrate a fresh microVM for one command.

EOF
)"
```

---

### Task 6: CLI

**Files:**
- Create: `host/src/cli.ts`
- Create: `host/test/cli.test.ts`
- Modify: `host/package.json` `test` script to include `dist/test/cli.test.js`

**Interfaces:**
- Consumes: `execCommand`, `DEFAULT_COMMAND_TIMEOUT_SEC`, `ExecResult`
- Produces:
  - `parseExecArgs(argv: string[]): { timeoutSec: number; command: string }`
  - `kvmMissingMessage(): string`
  - `runCli(argv: string[], io: CliIo): Promise<number>`
  - `main(argv: string[]): Promise<void>` which sets `process.exitCode`

`kvmMissingMessage()` returns exactly:

```text
sandbox: /dev/kvm is missing. Nested virtualization did not come up in the Lima VM.
```

- [ ] **Step 1: Write the failing test**

Create `host/test/cli.test.ts`:

```ts
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
```

Set `host/package.json` `scripts.test` to:

```json
"test": "tsc -p tsconfig.json && node --test dist/test/frame.test.js dist/test/vsock.test.js dist/test/firecracker.test.js dist/test/exec.test.js dist/test/cli.test.js"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd host && pnpm test`

Expected: FAIL because `host/src/cli.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `host/src/cli.ts`:

```ts
import fs from "node:fs";

import { DEFAULT_COMMAND_TIMEOUT_SEC } from "./constants.js";
import { execCommand, type ExecResult } from "./exec.js";

export function kvmMissingMessage(): string {
  return "sandbox: /dev/kvm is missing. Nested virtualization did not come up in the Lima VM.";
}

export function parseExecArgs(argv: string[]): { timeoutSec: number; command: string } {
  if (argv[0] !== "exec") {
    throw new Error("usage: exec [--timeout seconds] -- <command>");
  }
  let timeoutSec = DEFAULT_COMMAND_TIMEOUT_SEC;
  let index = 1;
  if (argv[index] === "--timeout") {
    const value = argv[index + 1];
    if (value === undefined || Number.isNaN(Number(value))) {
      throw new Error("usage: exec [--timeout seconds] -- <command>");
    }
    timeoutSec = Number(value);
    index += 2;
  }
  if (argv[index] !== "--") {
    throw new Error("usage: exec [--timeout seconds] -- <command>");
  }
  const command = argv.slice(index + 1).join(" ");
  if (command.length === 0) {
    throw new Error("usage: exec [--timeout seconds] -- <command>");
  }
  return { timeoutSec, command };
}

export interface CliIo {
  kvmPath: string;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  exec: (command: string, timeoutSec: number) => Promise<ExecResult>;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: { timeoutSec: number; command: string };
  try {
    parsed = parseExecArgs(argv);
  } catch (error) {
    io.stderr(`sandbox: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!fs.existsSync(io.kvmPath)) {
    io.stderr(`${kvmMissingMessage()}\n`);
    return 1;
  }
  try {
    const result = await io.exec(parsed.command, parsed.timeoutSec);
    io.stdout(result.stdout);
    io.stderr(result.stderr);
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(message.startsWith("sandbox: ") ? `${message}\n` : `sandbox: ${message}\n`);
    return 1;
  }
}

export async function main(argv: string[]): Promise<void> {
  const code = await runCli(argv, {
    kvmPath: "/dev/kvm",
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    exec: execCommand,
  });
  process.exitCode = code;
}
```

Add at the bottom of `host/src/cli.ts`, so `node host/dist/cli.js` runs:

```ts
if (process.argv[1]?.endsWith("cli.js")) {
  void main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd host && pnpm test && pnpm build`

Expected: PASS. `dist/cli.js` exists.

- [ ] **Step 5: Commit**

```bash
git add host/src/cli.ts host/test/cli.test.ts host/package.json
git commit -m "$(cat <<'EOF'
Add the sandbox exec CLI.

EOF
)"
```

---

### Task 7: Lima host and image setup

**Files:**
- Create: `lima.yaml`
- Create: `scripts/setup-host.sh`

**Interfaces:**
- Consumes: `guest/agent.py`, `guest/sandbox-agent.service`
- Produces: Lima instance config named by `limactl start --name=fc`. `scripts/setup-host.sh` fills `~/.sandbox/bin/firecracker`, `~/.sandbox/images/vmlinux`, `~/.sandbox/images/rootfs.ext4`, and `~/.sandbox/manifest.json`.

- [ ] **Step 1: Write the script and the Lima config**

Create `lima.yaml`:

```yaml
base:
  - template:ubuntu

vmType: vz
nestedVirtualization: true
cpus: 4
memory: 4GiB
mounts:
  - location: "~"
    writable: true
```

Create `scripts/setup-host.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR="${HOME}"
BASE="${HOME_DIR}/.sandbox"
IMG="${BASE}/images"
BIN="${BASE}/bin"
WORK="${BASE}/work"
VER="v1.17.0"
SHA="e351ebe4f7a16b5873bbd51005d2e6767103cff4d5ebc829df2d3f95a93e2256"
S3="https://s3.amazonaws.com/spec.ccfc.min"
MANIFEST="${BASE}/manifest.json"

mkdir -p "$IMG" "$BIN" "$WORK"
sudo apt-get update
sudo apt-get install -y e2fsprogs squashfs-tools curl ca-certificates python3 xz-utils

if ! command -v node >/dev/null || [[ "$(node -p process.versions.node)" != 24.* ]]; then
  NODE_TAR="node-v24.22.0-linux-arm64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v24.22.0/${NODE_TAR}" -o "${WORK}/${NODE_TAR}"
  echo "fef00bb4d36e1c50104a9775a10359beee98f162b4104dd12472c75065c6a143  ${WORK}/${NODE_TAR}" | sha256sum -c -
  sudo tar -xJf "${WORK}/${NODE_TAR}" -C /usr/local --strip-components=1
fi

if [[ ! -f "$MANIFEST" ]]; then
  ARCH="$(uname -m)"
  PREFIX=$(curl -fsSL "${S3}?list-type=2&prefix=firecracker-ci/&delimiter=/" \
    | grep -oP "(?<=<Prefix>)firecracker-ci/[0-9]{8}-[^/]+/(?=</Prefix>)" \
    | sort | tail -1)
  KERNEL_KEY=$(curl -fsSL "${S3}?list-type=2&prefix=${PREFIX}${ARCH}/vmlinux-" \
    | grep -oP "(?<=<Key>)(${PREFIX}${ARCH}/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" \
    | sort -V | tail -1)
  ROOTFS_KEY=$(curl -fsSL "${S3}?list-type=2&prefix=${PREFIX}${ARCH}/ubuntu-" \
    | grep -oP "(?<=<Key>)(${PREFIX}${ARCH}/ubuntu-[0-9]+\.[0-9]+\.squashfs)(?=</Key>)" \
    | sort -V | tail -1)
  printf '{"firecracker":"%s","kernel":"%s","rootfs":"%s"}\n' \
    "$VER" "${S3}/${KERNEL_KEY}" "${S3}/${ROOTFS_KEY}" > "$MANIFEST"
fi

FC_TGZ="${WORK}/firecracker-${VER}-aarch64.tgz"
if [[ ! -x "${BIN}/firecracker" ]]; then
  curl -fsSL -o "$FC_TGZ" \
    "https://github.com/firecracker-microvm/firecracker/releases/download/${VER}/firecracker-${VER}-aarch64.tgz"
  echo "${SHA}  ${FC_TGZ}" | sha256sum -c -
  tar -xzf "$FC_TGZ" -C "$WORK"
  cp "${WORK}/release-${VER}-aarch64/firecracker-${VER}-aarch64" "${BIN}/firecracker"
  chmod 755 "${BIN}/firecracker"
fi

KERNEL_URL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["kernel"])' "$MANIFEST")
ROOTFS_URL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rootfs"])' "$MANIFEST")

if [[ ! -f "${IMG}/vmlinux" ]]; then
  curl -fsSL -o "${IMG}/vmlinux" "$KERNEL_URL"
fi
if [[ ! -f "${IMG}/ubuntu.squashfs" ]]; then
  curl -fsSL -o "${IMG}/ubuntu.squashfs" "$ROOTFS_URL"
fi

rm -rf "${WORK}/squashfs-root"
unsquashfs -d "${WORK}/squashfs-root" "${IMG}/ubuntu.squashfs"
mkdir -p "${WORK}/squashfs-root/opt/sandbox" \
  "${WORK}/squashfs-root/etc/systemd/system/multi-user.target.wants"
cp "${ROOT}/guest/agent.py" "${WORK}/squashfs-root/opt/sandbox/agent.py"
chmod 755 "${WORK}/squashfs-root/opt/sandbox/agent.py"
cp "${ROOT}/guest/sandbox-agent.service" \
  "${WORK}/squashfs-root/etc/systemd/system/sandbox-agent.service"
ln -sf /etc/systemd/system/sandbox-agent.service \
  "${WORK}/squashfs-root/etc/systemd/system/multi-user.target.wants/sandbox-agent.service"
sudo chown -R root:root "${WORK}/squashfs-root"
truncate -s 1G "${IMG}/rootfs.ext4.tmp"
sudo mkfs.ext4 -d "${WORK}/squashfs-root" -F "${IMG}/rootfs.ext4.tmp"
mv "${IMG}/rootfs.ext4.tmp" "${IMG}/rootfs.ext4"
echo "ready: ${BIN}/firecracker ${IMG}/vmlinux ${IMG}/rootfs.ext4"
```

- [ ] **Step 2: Check the script syntax**

Run: `bash -n scripts/setup-host.sh`

Expected: no output, exit 0.

Run: `python3 -c "import pathlib; text=pathlib.Path('lima.yaml').read_text(); assert 'nestedVirtualization: true' in text; assert 'vmType: vz' in text"`

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
chmod +x scripts/setup-host.sh
git add lima.yaml scripts/setup-host.sh
git commit -m "$(cat <<'EOF'
Add the Lima host and the image setup script.

EOF
)"
```

---

### Task 8: Integration script

**Files:**
- Create: `scripts/test-integration.sh`

**Interfaces:**
- Consumes: `node host/dist/cli.js exec`
- Produces: a script that skips without `/dev/kvm`, checks `echo hello`, and checks that `false` exits non-zero.

- [ ] **Step 1: Write the script**

Create `scripts/test-integration.sh`. Write stdout to a file so the trailing newline is preserved:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI=(node "${ROOT}/host/dist/cli.js")

if [[ ! -e /dev/kvm ]]; then
  echo "skip: /dev/kvm is missing. Nested virtualization did not come up."
  exit 0
fi

set +e
"${CLI[@]}" exec --timeout 30 -- echo hello > /tmp/sandbox-hello.out
status=$?
set -e
if [[ "$status" -ne 0 ]]; then
  echo "echo hello exited ${status}" >&2
  exit 1
fi
python3 -c 'import pathlib,sys; data=pathlib.Path("/tmp/sandbox-hello.out").read_bytes(); sys.exit(0 if data==b"hello\n" else 1)'

set +e
"${CLI[@]}" exec --timeout 30 -- false >/tmp/sandbox-false.out
false_status=$?
set -e
if [[ "$false_status" -eq 0 ]]; then
  echo "expected false to exit non-zero" >&2
  exit 1
fi
echo "integration ok"
```

- [ ] **Step 2: Check syntax**

Run: `bash -n scripts/test-integration.sh && chmod +x scripts/test-integration.sh`

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-integration.sh
git commit -m "$(cat <<'EOF'
Add the in-VM exec integration check.

EOF
)"
```

---

### Task 9: Ari bash tool

**Files:**
- Create: `agent/package.json`
- Create: `agent/tsconfig.json`
- Create: `agent/src/bash-tool.ts`
- Create: `agent/src/run.ts`
- Create: `agent/src/bash-tool.test.ts`

**Interfaces:**
- Consumes: `defineTool` from `ari`, the CLI path `host/dist/cli.js`
- Produces:
  - `sandboxArgs(cliPath: string, command: string): string[]`
  - `interpretControllerResult(result: { stdout: string; stderr: string; exitCode: number }): { stdout: string; stderr: string; exitCode: number }`
  - `bashTool` from `defineTool`, effect `destructive`
  - `agent/src/run.ts` calls `createAgent` and `agent.complete`

- [ ] **Step 1: Write the failing test**

Create `agent/package.json`:

```json
{
  "name": "sandbox-agent",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/run.js",
    "test": "tsc -p tsconfig.json && node --test dist/bash-tool.test.js",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@ai-sdk/openai": "^4.0.19",
    "ai": "^7.0.36",
    "ari": "file:../../ai/ari",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^26.1.1",
    "typescript": "^5.9.3"
  }
}
```

Create `agent/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

Create `agent/src/bash-tool.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run, from the Ari repo first if `dist/` is missing:

```bash
pnpm --dir /Users/owaisiqbal/code/personal/ai/ari build
cd agent && pnpm install && pnpm test
```

Expected: FAIL because `agent/src/bash-tool.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `agent/src/bash-tool.ts`:

```ts
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineTool } from "ari";
import { z } from "zod";

export interface ControllerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function cliPath(): string {
  return path.join(repoRoot, "host", "dist", "cli.js");
}

export function sandboxArgs(cli: string, command: string): string[] {
  return ["shell", "fc", "--", "node", cli, "exec", "--timeout", "10", "--", command];
}

export function interpretControllerResult(result: ControllerResult): ControllerResult {
  if (result.exitCode === 124 && result.stdout === "" && result.stderr === "timeout\n") {
    return { stdout: "", stderr: "timeout", exitCode: 124 };
  }
  if (result.stderr.startsWith("sandbox:")) {
    throw new Error(result.stderr);
  }
  return result;
}

export function runLimactl(args: string[]): Promise<ControllerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("limactl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

export const bashTool = defineTool({
  description: "Run a shell command inside the Firecracker sandbox",
  input: z.object({
    command: z.string().describe("Shell command to run inside the microVM"),
  }),
  effect: "destructive",
  async execute({ command }) {
    const result = await runLimactl(sandboxArgs(cliPath(), command));
    return interpretControllerResult(result);
  },
});
```

`cliPath()` resolves `../..` from `agent/dist/bash-tool.js`, which is the repo root, because `rootDir` is `src`.

Create `agent/src/run.ts`:

```ts
import { createOpenAI } from "@ai-sdk/openai";

import { createAgent, memorySessionStore } from "ari";

import { bashTool } from "./bash-tool.js";

const modelId = process.env["ARI_EXAMPLE_MODEL"] ?? "gpt-5.4-mini";

if (!process.env["OPENAI_API_KEY"]) {
  process.stderr.write("sandbox: OPENAI_API_KEY is missing\n");
  process.exit(1);
}

const prompt = process.argv.slice(2).join(" ");
if (prompt.length === 0) {
  process.stderr.write("usage: node dist/run.js <prompt>\n");
  process.exit(1);
}

const agent = createAgent({
  models: { main: createOpenAI()(modelId) },
  defaultModel: "main",
  store: memorySessionStore(),
  instructions:
    "You run shell commands inside a Firecracker microVM by calling the bash tool. " +
    "Report the command output.",
  tools: { bash: bashTool },
});

const { result } = await agent.complete(prompt);
process.stdout.write(`${result.text}\n`);
await agent.close();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && pnpm test`

Expected: PASS, 4 tests. This test does not start Lima or call the model.

- [ ] **Step 5: Commit**

```bash
git add agent
git commit -m "$(cat <<'EOF'
Call the sandbox from an Ari bash tool.

EOF
)"
```

---

### Task 10: README lesson

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: every command from the earlier tasks
- Produces: the lesson in the spec's section order

- [ ] **Step 1: Write the README**

Create `README.md` with this text:

````markdown
# Firecracker starter

This repo boots a microVM and runs one shell command inside it. An Ari agent on the Mac calls that command as a bash tool.

## Three places

Your Mac runs Ari. It cannot run Firecracker.

The Lima VM named `fc` is the Firecracker host. The `firecracker` process and `host/dist/cli.js` run there. Firecracker needs `/dev/kvm` in that VM.

The microVM is the guest. `guest/agent.py` runs there and executes bash. A command cannot see the Mac or the Lima VM's files.

## KVM

Firecracker opens `/dev/kvm` and asks the Linux kernel to create a virtual machine. This Mac has no `/dev/kvm`. Lima's `nestedVirtualization` setting, with `vmType: vz`, asks macOS to expose KVM inside the Ubuntu guest. The machine is an Apple M5, which Lima 2.1 supports.

```bash
limactl start --name=fc lima.yaml
limactl shell fc -- ls -l /dev/kvm
```

If `/dev/kvm` is missing, stop. Nested virtualization did not come up. Nothing later in this lesson can run.

## The API socket

`scripts/setup-host.sh` downloads Firecracker v1.17.0, a guest kernel, and an Ubuntu root disk. It installs `guest/agent.py` into that disk and enables `sandbox-agent.service`.

```bash
limactl shell fc -- ./scripts/setup-host.sh
cd host && pnpm install && pnpm build
```

`node host/dist/cli.js exec` starts `firecracker` with `--api-sock`. The socket speaks HTTP. Before the guest boots, the controller PUTs five documents, in order:

1. `/machine-config` — 1 vCPU, 256 MiB, SMT off
2. `/boot-source` — the kernel and `keep_bootcon console=ttyS0 reboot=k panic=1`
3. `/drives/rootfs` — a fresh copy of the root disk, marked as the root device
4. `/vsock` — guest context id 3, Unix socket path for the host side
5. `/actions` — `InstanceStart`

A successful PUT returns HTTP 204. The guest has no network interface.

## vsock

The guest reaches the host with a context id and a port. The host's context id is 2. This guest's context id is 3. The agent listens on port 5000.

Bytes move through a virtio ring: a shared-memory queue the guest kernel fills and Firecracker reads. Nothing is wrapped in an IP packet. The guest has no address to dial.

On the host, Firecracker exposes that device as a Unix socket. The controller connects and sends:

```text
CONNECT 5000
```

Firecracker answers:

```text
OK <port>
```

After that the socket is a byte pipe. Each message is a 4-byte big-endian length plus JSON.

```bash
limactl shell fc -- node "$PWD/host/dist/cli.js" exec --timeout 10 -- echo hello
```

Run that from the repo root on the Mac. `limactl shell` keeps the current directory when it is inside the home mount. Expected stdout is `hello`.

`scripts/test-integration.sh` runs that check and a `false` check inside the Lima VM.

## Ari

The agent package lives in this repo. It depends on the Ari checkout next door. Build Ari once, then install here:

```bash
pnpm --dir ../ai/ari build
cd agent && pnpm install && pnpm build
OPENAI_API_KEY=... node dist/run.js "Run echo hello in the sandbox and tell me what it printed."
```

The bash tool is `destructive`. Its `execute` function runs `limactl shell fc -- node … exec -- <command>`. The model never gets a shell on the Mac.

## What this slice leaves out

The jailer is a second binary shipped with Firecracker. It starts first, chroots the Firecracker process, drops root, and applies a cgroup. The microVM already walls the guest off from the host. The jailer walls a buggy Firecracker process off from the rest of the host. This slice runs `firecracker` directly.

A snapshot is a copy of the guest's memory and device state taken after boot. Restoring it starts the next command in milliseconds. The files are a memory image plus a state file, and the caller still supplies the root disk. This slice boots from the kernel every time.

A later slice can keep a pool of restored VMs so the Ari tool does not pay a full boot per call.
````

- [ ] **Step 2: Read it back**

Run: `test -f README.md && rg -n "jailer|snapshot|/dev/kvm|CONNECT|InstanceStart" README.md`

Expected: each of those strings appears at least once.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
Document the host, the API socket, and vsock.

EOF
)"
```

---

## Spec coverage

The plan implements the spec at `docs/superpowers/specs/2026-10-16-firecracker-sandbox-design.md`.

| Spec requirement | Task |
| --- | --- |
| Frame codec and the five frame tests | 1 |
| Guest agent, caps, systemd unit | 2 |
| CONNECT / OK and command timeout error | 3 |
| Five API calls, HTTP 204, CLI flags | 4 |
| Per-run rootfs copy, kill in finally, timeout result | 5 |
| `/dev/kvm` check, argv join, exit codes | 6 |
| Lima `fc`, Firecracker v1.17.0, manifest, rootfs rebuild | 7 |
| Integration `echo hello` and `false` | 8 |
| Ari package dependency and bash tool | 9 |
| README lesson, jailer and snapshots named only | 10 |

Jailer, snapshots, a guest network, and a warm pool are not tasks.
