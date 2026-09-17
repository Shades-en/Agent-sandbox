#!/usr/bin/env python3
"""Guest-side listener. This is not an AI agent.

systemd starts this at boot inside the microVM. It accepts one vsock
connection, feeds that payload to an already-running Node.js process, writes
the result back, and exits. There is no shell. The guest has no IP address.
vsock is the only way the Lima host reaches it.
"""

import json
import os
import select
import shutil
import signal
import socket
import struct
import subprocess
from pathlib import Path

MAX_FRAME = 1024 * 1024
MAX_STREAM = 256 * 1024
PORT = 5000
# /usr/local/bin is where setup-host.sh installs Node.js inside the guest.
GUEST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
_READ_CHUNK = 8192


def normalize_exit_code(code: int) -> int:
    if code < 0:
        return 128 + (-code)
    if code > 255:
        return code % 256
    return code


def _response_body_bytes(response: dict) -> bytes:
    return json.dumps(response, ensure_ascii=False).encode("utf-8")


def fit_response_to_frame(response: dict) -> dict:
    out = dict(response)
    out["truncated"] = bool(out.get("truncated"))
    while len(_response_body_bytes(out)) > MAX_FRAME:
        out["truncated"] = True
        if out.get("stdout"):
            stdout = out["stdout"]
            out["stdout"] = stdout[: max(len(stdout) // 2, 0)]
            continue
        if out.get("stderr"):
            stderr = out["stderr"]
            out["stderr"] = stderr[: max(len(stderr) // 2, 0)]
            continue
        break
    return out


def encode_frame(payload: dict) -> bytes:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
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


def _kill_process_group(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def _append_limited(buf: bytearray, chunk: bytes, limit: int) -> tuple[bool, bool]:
    """Append chunk up to limit. Returns (added_any, hit_limit)."""
    if len(buf) >= limit:
        return False, True
    room = limit - len(buf)
    if len(chunk) <= room:
        buf.extend(chunk)
        return True, False
    buf.extend(chunk[:room])
    return True, True


def _read_capped_output(proc: subprocess.Popen) -> tuple[bytes, bytes, bool]:
    stdout_fd = proc.stdout.fileno() if proc.stdout else None
    stderr_fd = proc.stderr.fileno() if proc.stderr else None
    stdout_buf = bytearray()
    stderr_buf = bytearray()
    truncated = False
    stdout_open = stdout_fd is not None
    stderr_open = stderr_fd is not None

    while stdout_open or stderr_open:
        readers: list[int] = []
        if stdout_open and stdout_fd is not None:
            readers.append(stdout_fd)
        if stderr_open and stderr_fd is not None:
            readers.append(stderr_fd)

        if readers:
            ready, _, _ = select.select(readers, [], [], 0.05)
            for fd in ready:
                chunk = os.read(fd, _READ_CHUNK)
                if not chunk:
                    if fd == stdout_fd:
                        stdout_open = False
                    else:
                        stderr_open = False
                    continue
                if fd == stdout_fd:
                    if len(stdout_buf) >= MAX_STREAM:
                        truncated = True
                    else:
                        _, hit = _append_limited(stdout_buf, chunk, MAX_STREAM)
                        if hit:
                            truncated = True
                elif len(stderr_buf) >= MAX_STREAM:
                    truncated = True
                else:
                    _, hit = _append_limited(stderr_buf, chunk, MAX_STREAM)
                    if hit:
                        truncated = True

        if truncated and proc.poll() is None:
            _kill_process_group(proc)

        if proc.poll() is not None:
            for fd, buf in ((stdout_fd, stdout_buf), (stderr_fd, stderr_buf)):
                if fd is None:
                    continue
                while True:
                    try:
                        chunk = os.read(fd, _READ_CHUNK)
                    except OSError:
                        break
                    if not chunk:
                        break
                    if len(buf) >= MAX_STREAM:
                        truncated = True
                        continue
                    _, hit = _append_limited(buf, chunk, MAX_STREAM)
                    if hit:
                        truncated = True
            if truncated and proc.poll() is None:
                _kill_process_group(proc)
            break

    proc.wait()
    if proc.stdout:
        proc.stdout.close()
    if proc.stderr:
        proc.stderr.close()
    return bytes(stdout_buf), bytes(stderr_buf), truncated


def start_runtime() -> subprocess.Popen:
    # Start Node BEFORE the snapshot, not after a tool call arrives.
    node = shutil.which("node")
    if node is None:
        raise FileNotFoundError("node is not installed")
    proc = subprocess.Popen(
        [node, str(Path(__file__).with_name("runtime.cjs"))],
        cwd="/",
        env={"PATH": GUEST_PATH, "NODE_NO_WARNINGS": "1"},
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    assert proc.stdout is not None
    # The bootstrap has registered its input handler when it writes this line.
    # Consume it here so it never appears in the user's stdout.
    readable, _, _ = select.select([proc.stdout], [], [], 30)
    if not readable or proc.stdout.readline() != b"SANDBOX_NODE_READY\n":
        _kill_process_group(proc)
        proc.wait()
        if proc.stdin:
            proc.stdin.close()
        for pipe in (proc.stdout, proc.stderr):
            if pipe:
                pipe.close()
        raise RuntimeError("Node runtime did not become ready")
    return proc


def run_command(source: str, proc: subprocess.Popen | None = None) -> dict:
    # Production passes the process saved in the snapshot. Tests may start a
    # fresh runtime here without needing a microVM.
    if proc is None:
        proc = start_runtime()
    assert proc.stdin is not None
    proc.stdin.write(source.encode("utf-8"))
    proc.stdin.close()
    raw_out, raw_err, truncated = _read_capped_output(proc)
    stdout, out_cut = cap_text(raw_out.decode("utf-8", errors="replace"))
    stderr, err_cut = cap_text(raw_err.decode("utf-8", errors="replace"))
    response = fit_response_to_frame(
        {
            "stdout": stdout,
            "stderr": stderr,
            "exitCode": normalize_exit_code(proc.returncode),
            "truncated": truncated or out_cut or err_cut,
        }
    )
    return response


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


def handle(conn: socket.socket, runtime: subprocess.Popen) -> None:
    header = _read_exact(conn, 4)
    (length,) = struct.unpack(">I", header)
    if length > MAX_FRAME:
        raise ValueError("frame too large")
    body = _read_exact(conn, length)
    request = json.loads(body)
    command = request["command"]
    if not isinstance(command, str):
        raise ValueError("command missing")
    conn.sendall(encode_frame(run_command(command, runtime)))


def main() -> None:
    # AF_VSOCK is the guest kernel's vsock socket family. VMADDR_CID_ANY
    # means "this VM". The Lima host reaches it as context id 3, port 5000.
    runtime = start_runtime()
    server = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    try:
        server.bind((socket.VMADDR_CID_ANY, PORT))
        server.listen(1)
        # Node is already waiting on stdin. Snapshotting now preserves the
        # runtime, its pipes, and the unused vsock listener together.
        os.sync()
        with open("/dev/ttyS0", "w") as console:
            console.write("SANDBOX_NODE_READY_FOR_SNAPSHOT\n")
        conn, _ = server.accept()
        try:
            handle(conn, runtime)
        finally:
            conn.close()
    finally:
        server.close()
        _kill_process_group(runtime)
        runtime.wait()
        for pipe in (runtime.stdin, runtime.stdout, runtime.stderr):
            if pipe:
                pipe.close()


if __name__ == "__main__":
    main()
