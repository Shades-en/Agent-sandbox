import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { createOpenAI } from "@ai-sdk/openai";

import { createAgent, memorySessionStore } from "ari";

import { javascriptTool } from "./javascript-tool.js";
import { runConversation } from "./chat.js";
import { createTurnTimings } from "./timings.js";

// Node does not load .env by itself. This file lives next to package.json.
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
try {
  process.loadEnvFile(envPath);
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") throw error;
}

const modelId = process.env["ARI_EXAMPLE_MODEL"] ?? "gpt-5.4-mini";

if (!process.env["OPENAI_API_KEY"]) {
  process.stderr.write("sandbox: OPENAI_API_KEY is missing\n");
  process.exit(1);
}

const args = process.argv.slice(2);
let once = false;
while (args[0]?.startsWith("--")) {
  const flag = args.shift();
  if (flag === "--") break;
  if (flag === "--timings") process.env["SANDBOX_TIMINGS"] = "1";
  else if (flag === "--once") once = true;
  else {
    process.stderr.write("usage: node dist/run.js [--timings] [--once] [prompt]\n");
    process.exit(1);
  }
}
const initialPrompt = args.join(" ");
if (once && !initialPrompt) {
  process.stderr.write("--once requires a prompt\n");
  process.exit(1);
}
const timings = createTurnTimings(process.env["SANDBOX_TIMINGS"] === "1");

const agent = createAgent({
  models: { main: createOpenAI()(modelId) },
  defaultModel: "main",
  store: memorySessionStore(),
  instructions:
    "You run JavaScript inside a Firecracker microVM by calling the javascript tool. " +
    "Node.js executes the source. Outbound HTTPS fetch and public DNS work; plain HTTP, private networks, and inbound connections are blocked. Use an async function for fetch and report what it printed.",
  tools: { javascript: javascriptTool },
  hooks: timings.hooks,
});

const session = await agent.createSession();
const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const readline = once ? undefined : createInterface({
  input: process.stdin, output: process.stdout, terminal, prompt: "you> ",
});
// Subscribe immediately, before the initial model call, so piped or typed
// follow-ups are buffered while the agent is working.
const lines = readline?.[Symbol.asyncIterator]() ?? (async function* () {})();
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  process.exitCode = 130;
  readline?.close();
  void session.halt();
};
readline?.on("SIGINT", stop);
process.on("SIGINT", stop);
if (!once && terminal) {
  process.stdout.write("Agent sandbox — /exit or Ctrl+D quits. Conversation memory lasts for this process.\n");
}
try {
  await runConversation(session, lines, {
    initialPrompt, once, timings,
    shouldStop: () => stopping,
    write: (text) => { process.stdout.write(text); },
    error: (text) => { process.stderr.write(text); },
    prompt: terminal && readline ? () => { if (!stopping) readline.prompt(); } : undefined,
  });
} catch (error) {
  process.stderr.write(`agent: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  readline?.close();
  process.off("SIGINT", stop);
  await agent.close();
}
