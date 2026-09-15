import path from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenAI } from "@ai-sdk/openai";

import { createAgent, memorySessionStore } from "ari";

import { javascriptTool } from "./javascript-tool.js";

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

const prompt = process.argv.slice(2).join(" ");
if (prompt.length === 0) {
  process.stderr.write("usage: node dist/run.js <prompt>\n");
  process.exit(1);
}

const agent = createAgent({
  models: { main: createOpenAI()(modelId) },
  defaultModel: "main",
  store: memorySessionStore(),
  instructions:
    "You run JavaScript inside a Firecracker microVM by calling the javascript tool. " +
    "Node.js executes the source. There is no shell and no network. Report what it printed.",
  tools: { javascript: javascriptTool },
});

const { result } = await agent.complete(prompt);
process.stdout.write(`${result.text}\n`);
await agent.close();
