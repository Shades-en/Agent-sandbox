import type { Hooks } from "ari";

// Observe Ari's real model/tool boundaries. These logs contain durations only,
// never prompts, source code, API keys, or model/tool output.
export function createTurnTimings(
  enabled: boolean,
  write = (line: string) => { process.stderr.write(line); },
  now = () => performance.now(),
) {
  let turnStarted = 0;
  const models = new Map<number, number>();
  const tools = new Map<string, { name: string; started: number }>();
  const report = (label: string, started: number) => {
    write(`[timing agent] ${label}: ${(now() - started).toFixed(1)} ms\n`);
  };
  const hooks: Hooks = enabled ? {
    preModel: [(event) => { models.set(event.stepIndex, now()); return undefined; }],
    postModel: [(event) => {
      const start = models.get(event.stepIndex);
      if (start !== undefined) report(`model.${event.stepIndex + 1}`, start);
      models.delete(event.stepIndex);
      return undefined;
    }],
    preTool: [(event) => {
      tools.set(event.toolCallId, { name: event.toolName, started: now() });
      return undefined;
    }],
    postTool: [(event) => {
      const tool = tools.get(event.toolCallId);
      if (tool) report(`tool.${tool.name}`, tool.started);
      tools.delete(event.toolCallId);
      return undefined;
    }],
  } : {};
  return {
    hooks,
    begin() { turnStarted = now(); models.clear(); tools.clear(); },
    end() {
      if (!enabled) return;
      for (const [index, start] of models) report(`model.${index + 1}.incomplete`, start);
      for (const tool of tools.values()) report(`tool.${tool.name}.incomplete`, tool.started);
      report("turn.total", turnStarted);
      models.clear(); tools.clear();
    },
  };
}
