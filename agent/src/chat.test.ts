import assert from "node:assert/strict";
import { test } from "node:test";
import { runConversation } from "./chat.js";

async function* lines(...messages: string[]) { yield* messages; }

test("conversation reuses one session, processes follow-ups serially, and exits", async () => {
  const history: string[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  let active = false;
  const session = { async complete(message: string) {
    assert.equal(active, false);
    active = true;
    await Promise.resolve();
    history.push(message);
    active = false;
    return { text: history.join(" -> ") };
  } };
  await runConversation(session, lines("", "second", "/exit", "ignored"), {
    initialPrompt: "first", write: (s) => output.push(s), error: (s) => errors.push(s),
  });
  assert.deepEqual(history, ["first", "second"]);
  assert.deepEqual(output, ["first\n", "first -> second\n"]);
  assert.deepEqual(errors, []);
});

test("one-shot mode does not consume follow-up input", async () => {
  const history: string[] = [];
  await runConversation({ async complete(s) { history.push(s); return { text: "ok" }; } }, lines("second"), {
    initialPrompt: "first", once: true, write() {}, error() {},
  });
  assert.deepEqual(history, ["first"]);
});

test("a failed chat turn reports its timing and allows a follow-up", async () => {
  const events: string[] = [];
  await runConversation({ async complete(s) {
    if (s === "bad") throw new Error("failed request");
    return { text: "recovered" };
  } }, lines("bad", "good"), {
    write: (s) => events.push(s), error: (s) => events.push(s),
    timings: { begin() { events.push("start"); }, end() { events.push("end"); } },
  });
  assert.deepEqual(events, ["start", "agent: failed request\n", "end", "start", "recovered\n", "end"]);
});


test("cancellation during a turn does not run buffered follow-ups", async () => {
  let stopped = false;
  const messages: string[] = [];
  await runConversation({ async complete(message) {
    messages.push(message); stopped = true; return { text: "halted" };
  } }, lines("buffered follow-up"), {
    initialPrompt: "first", shouldStop: () => stopped, write() {}, error() {},
  });
  assert.deepEqual(messages, ["first"]);
});
