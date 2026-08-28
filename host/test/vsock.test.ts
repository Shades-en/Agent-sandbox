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
