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
