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
    let socket: net.Socket | undefined;
    try {
      socket = await connectOnce(udsPath);
      socket.write(`CONNECT ${VSOCK_PORT}\n`);
      const line = await readLine(socket, deadline - Date.now());
      parseConnectAck(line);
      return socket;
    } catch (error) {
      socket?.destroy();
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
