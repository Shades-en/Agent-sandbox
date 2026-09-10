import { createOpenAI } from "@ai-sdk/openai";

import { createAgent, memorySessionStore } from "ari";

import { bashTool } from "./bash-tool.js";

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
    "You run shell commands inside a Firecracker microVM by calling the bash tool. " +
    "Report the command output.",
  tools: { bash: bashTool },
});

const { result } = await agent.complete(prompt);
process.stdout.write(`${result.text}\n`);
await agent.close();
