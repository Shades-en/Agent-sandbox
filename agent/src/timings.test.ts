import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnTimings } from "./timings.js";

const context = { sessionId: "s", turnId: "t", userId: "u", metadata: {}, abortSignal: new AbortController().signal };

test("model, tool, and whole-turn timings use their own boundaries and omit payloads", async () => {
  let clock = 100;
  const output: string[] = [];
  const timings = createTurnTimings(true, (s) => output.push(s), () => clock);
  timings.begin();
  clock = 110;
  await timings.hooks.preModel![0]({ ...context, stepIndex: 0, records: [] });
  clock = 160;
  await timings.hooks.postModel![0]({ ...context, stepIndex: 0, text: "PRIVATE", reasoning: "", toolCalls: [] });
  clock = 170;
  const tool = { ...context, toolCallId: "c", toolName: "javascript", input: { code: "PRIVATE" } };
  await timings.hooks.preTool![0](tool);
  clock = 200;
  await timings.hooks.postTool![0]({ ...tool, output: "PRIVATE", isError: false });
  clock = 210;
  timings.end();
  assert.deepEqual(output, [
    "[timing agent] model.1: 50.0 ms\n",
    "[timing agent] tool.javascript: 30.0 ms\n",
    "[timing agent] turn.total: 110.0 ms\n",
  ]);
  timings.begin();
  clock = 220;
  timings.end();
  assert.equal(output.at(-1), "[timing agent] turn.total: 10.0 ms\n");
});

test("timings are silent when disabled", () => {
  const timings = createTurnTimings(false, () => { assert.fail("unexpected log"); });
  timings.begin(); timings.end();
  assert.deepEqual(timings.hooks, {});
});
