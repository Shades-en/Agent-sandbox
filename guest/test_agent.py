import select
import signal
import unittest
from unittest.mock import patch

from agent import (
    MAX_FRAME,
    MAX_STREAM,
    cap_text,
    decode_frame,
    encode_frame,
    fit_response_to_frame,
    normalize_exit_code,
    run_command,
    start_runtime,
)


class AgentTest(unittest.TestCase):
    def test_round_trip(self):
        payload = {"command": "echo hello"}
        self.assertEqual(decode_frame(encode_frame(payload)), payload)

    def test_cap_text_marks_truncation(self):
        text, truncated = cap_text("x" * (MAX_STREAM + 10))
        self.assertTrue(truncated)
        self.assertLessEqual(len(text.encode("utf-8")), MAX_STREAM)

    def test_run_command_echo(self):
        result = run_command('console.log("hello")')
        self.assertEqual(result["stdout"], "hello\n")
        self.assertEqual(result["stderr"], "")
        self.assertEqual(result["exitCode"], 0)
        self.assertFalse(result["truncated"])

    def test_run_command_false(self):
        result = run_command("process.exit(1)")
        self.assertNotEqual(result["exitCode"], 0)

    def test_uses_the_already_ready_node_process_without_spawning(self):
        runtime = start_runtime()
        try:
            # The readiness line was consumed. Node is alive, with no user
            # output and no source yet. Sending source must not spawn again.
            self.assertIsNone(runtime.poll())
            self.assertEqual(select.select([runtime.stdout], [], [], 0)[0], [])
            pid = runtime.pid
            with patch("agent.subprocess.Popen", side_effect=AssertionError("unexpected spawn")):
                result = run_command("console.log(process.pid)", runtime)
            self.assertEqual(result["stdout"], f"{pid}\n")
            self.assertEqual(result["stderr"], "")
            self.assertEqual(result["exitCode"], 0)
        finally:
            if runtime.poll() is None:
                runtime.kill()
            runtime.wait()
            for pipe in (runtime.stdin, runtime.stdout, runtime.stderr):
                if pipe:
                    pipe.close()

    def test_runtime_preserves_async_output_and_require(self):
        result = run_command(
            'const fs = require("node:fs"); '
            'setTimeout(() => console.log(typeof fs.readFileSync), 5)'
        )
        self.assertEqual(result["stdout"], "function\n")
        self.assertEqual(result["stderr"], "")
        self.assertEqual(result["exitCode"], 0)

    def test_runtime_reports_syntax_errors_and_exceptions(self):
        for source, error in (("const =", "SyntaxError"), ('throw new Error("broken")', "broken")):
            with self.subTest(source=source):
                result = run_command(source)
                self.assertEqual(result["stdout"], "")
                self.assertEqual(result["exitCode"], 1)
                self.assertIn(error, result["stderr"])
                self.assertIn("/sandbox.js", result["stderr"])

    def test_large_unicode_source_can_cross_the_stdin_pipe(self):
        source = "/*" + "λ" * 100_000 + '*/ console.log("🚀")'
        result = run_command(source)
        self.assertEqual(result["stdout"], "🚀\n")
        self.assertEqual(result["stderr"], "")
        self.assertEqual(result["exitCode"], 0)

    def test_runtime_startup_failure_is_not_reported_as_readiness(self):
        with patch("agent.shutil.which", return_value="/usr/bin/false"):
            with self.assertRaisesRegex(RuntimeError, "Node runtime did not become ready"):
                start_runtime()

    def test_response_frame_fits_heavy_json_escaping(self):
        chunk = '"' * MAX_STREAM
        import json

        raw = {
            "stdout": chunk,
            "stderr": chunk,
            "exitCode": 0,
            "truncated": False,
        }
        body = json.dumps(raw, ensure_ascii=False).encode("utf-8")
        self.assertGreater(len(body), MAX_FRAME)
        fitted = fit_response_to_frame(raw)
        frame = encode_frame(fitted)
        self.assertLessEqual(len(frame) - 4, MAX_FRAME)
        self.assertTrue(fitted["truncated"])

    def test_normalize_exit_signal_nine(self):
        self.assertEqual(normalize_exit_code(-9), 137)

    def test_run_command_large_stdout_truncates(self):
        result = run_command("process.stdout.write('a'.repeat(256 * 1024 + 1))")
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["stdout"].encode("utf-8")), MAX_STREAM)
        self.assertGreaterEqual(result["exitCode"], 0)
        self.assertLessEqual(result["exitCode"], 255)
        frame = encode_frame(result)
        self.assertLessEqual(len(frame) - 4, MAX_FRAME)

    def test_run_command_infinite_output_group_kill(self):
        # Respect pipe backpressure so the writer reaches the output cap,
        # rather than failing early with EAGAIN on a nonblocking stdout pipe.
        cmd = (
            "const { once } = require('node:events'); "
            "(async () => { while (true) { "
            "if (!process.stdout.write('x'.repeat(4096))) "
            "await once(process.stdout, 'drain'); } })()"
        )
        def on_alarm(_signum, _frame):
            raise TimeoutError("run_command hung")

        old_handler = signal.signal(signal.SIGALRM, on_alarm)
        signal.alarm(5)
        try:
            result = run_command(cmd)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)

        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["stdout"].encode("utf-8")), MAX_STREAM)
        self.assertGreaterEqual(result["exitCode"], 0)
        self.assertLessEqual(result["exitCode"], 255)


if __name__ == "__main__":
    unittest.main()
