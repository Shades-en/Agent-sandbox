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
