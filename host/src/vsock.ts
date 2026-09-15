import net from "node:net";

import { BOOT_TIMEOUT_MS, MAX_FRAME_BYTES, VSOCK_PORT } from "./constants.js";
import {
  FrameError,
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

const readLeftovers = new WeakMap<net.Socket, Buffer>();

function takeLeftover(socket: net.Socket): Buffer {
  const leftover = readLeftovers.get(socket);
  readLeftovers.set(socket, Buffer.alloc(0));
  return leftover ?? Buffer.alloc(0);
}

function stashLeftover(socket: net.Socket, extra: Buffer): void {
  if (extra.length > 0) {
    readLeftovers.set(socket, extra);
  }
}

function readExact(socket: net.Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (timeoutMs <= 0) {
      reject(new CommandTimeoutError());
      return;
    }
    socket.resume();
    const chunks: Buffer[] = [];
    let got = 0;
    const timer = setTimeout(() => {
      cleanup();
      reject(new CommandTimeoutError());
    }, timeoutMs);
    const feed = (chunk: Buffer) => {
      chunks.push(chunk);
      got += chunk.length;
      if (got >= n) {
        cleanup();
        const all = Buffer.concat(chunks);
        const extra = all.subarray(n);
        stashLeftover(socket, extra);
        resolve(all.subarray(0, n));
      }
    };
    const onData = (chunk: Buffer) => feed(chunk);
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
      socket.pause();
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    const pending = takeLeftover(socket);
    if (pending.length > 0) {
      feed(pending);
    }
  });
}

async function readLine(socket: net.Socket, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let buf = Buffer.alloc(0);
  while (!buf.includes(0x0a)) {
    const next = await readExact(socket, 1, deadline - Date.now());
    buf = Buffer.concat([buf, next]);
  }
  return buf.toString("utf8").replace(/\n$/, "");
}

function connectOnce(udsPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(udsPath);
    socket.once("connect", () => {
      socket.pause();
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

// Firecracker exposes the guest vsock device as a Unix socket. The first
// line is a handshake, not our command: "CONNECT 5000" then "OK <port>".
// The guest may still be booting, so a closed socket is retried until the
// boot deadline. That failure is not a command timeout.
async function connectGuest(udsPath: string, deadline: number): Promise<net.Socket> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    let socket: net.Socket | undefined;
    try {
      const connected = await connectOnce(udsPath);
      socket = connected;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error | null) => {
          if (settled) return;
          settled = true;
          connected.off("error", onError);
          if (error) reject(error);
          else resolve();
        };
        const onError = (error: Error) => finish(error);
        connected.once("error", onError);
        connected.write(`CONNECT ${VSOCK_PORT}\n`, (error) => finish(error));
      });
      const line = await readLine(connected, deadline - Date.now());
      parseConnectAck(line);
      return socket;
    } catch (error) {
      socket?.destroy();
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (lastError instanceof CommandTimeoutError) {
    throw new Error(`no vsock CONNECT within ${BOOT_TIMEOUT_MS}ms`);
  }
  throw lastError instanceof Error ? lastError : new Error("vsock connect failed");
}

// After the handshake the socket is a plain byte pipe. We write one
// length-prefixed JSON command and read one JSON response.
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
    const responseDeadline = Date.now() + commandTimeoutMs;
    const header = await readExact(socket, 4, responseDeadline - Date.now());
    const length = header.readUInt32BE(0);
    if (length > MAX_FRAME_BYTES) {
      throw new FrameError("frame too large");
    }
    const body = await readExact(socket, length, responseDeadline - Date.now());
    return parseExecResponse(decodeFrame(Buffer.concat([header, body])));
  } finally {
    socket.destroy();
  }
}
