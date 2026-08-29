import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { VSOCK_PORT } from "../src/constants.js";
import { decodeFrame, encodeFrame } from "../src/frame.js";
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
      let buf = Buffer.alloc(0);
      let connectDone = false;
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (!connectDone) {
          const nl = buf.indexOf(0x0a);
          if (nl === -1) return;
          const line = buf.subarray(0, nl).toString("utf8");
          assert.equal(line, `CONNECT ${VSOCK_PORT}`);
          buf = buf.subarray(nl + 1);
          socket.write(`OK ${VSOCK_PORT}\n`);
          connectDone = true;
        }
        if (buf.length < 4) return;
        const length = buf.readUInt32BE(0);
        if (buf.length < 4 + length) return;
        const payload = decodeFrame(buf.subarray(0, 4 + length));
        assert.deepEqual(payload, { command: "echo hello" });
        socket.end(
          encodeFrame({
            stdout: "hello\n",
            stderr: "",
            exitCode: 0,
            truncated: false,
          }),
        );
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
