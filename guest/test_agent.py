import signal
import unittest

from agent import (
    MAX_FRAME,
    MAX_STREAM,
    cap_text,
    decode_frame,
    encode_frame,
    fit_response_to_frame,
    normalize_exit_code,
    run_command,
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
        result = run_command("echo hello")
        self.assertEqual(result["stdout"], "hello\n")
        self.assertEqual(result["stderr"], "")
        self.assertEqual(result["exitCode"], 0)
        self.assertFalse(result["truncated"])

    def test_run_command_false(self):
        result = run_command("false")
        self.assertNotEqual(result["exitCode"], 0)

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
        result = run_command("python3 -c \"import sys; sys.stdout.write('a' * (256 * 1024 + 1))\"")
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["stdout"].encode("utf-8")), MAX_STREAM)
        self.assertGreaterEqual(result["exitCode"], 0)
        self.assertLessEqual(result["exitCode"], 255)
        frame = encode_frame(result)
        self.assertLessEqual(len(frame) - 4, MAX_FRAME)

    def test_run_command_pipeline_group_kill(self):
        cmd = (
            "python3 -c 'import sys\nwhile True:\n sys.stdout.buffer.write(b\"x\"*4096)' | cat"
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
