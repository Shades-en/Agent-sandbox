interface ChatSession {
  complete(prompt: string): Promise<{ text: string }>;
}

interface ChatOptions {
  initialPrompt?: string;
  once?: boolean;
  write: (text: string) => void;
  error: (text: string) => void;
  prompt?: () => void;
  shouldStop?: () => boolean;
  timings?: { begin(): void; end(): void };
}

// Reuse this ONE Ari session on every iteration. Conversation history survives
// between turns; each JavaScript tool call still restores a fresh microVM.
export async function runConversation(
  session: ChatSession,
  lines: AsyncIterable<string>,
  options: ChatOptions,
): Promise<void> {
  const turn = async (message: string) => {
    options.timings?.begin();
    try {
      const result = await session.complete(message);
      options.write(`${result.text}\n`);
    } catch (error) {
      if (options.once) throw error;
      options.error(`agent: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      options.timings?.end();
    }
  };
  if (options.initialPrompt) await turn(options.initialPrompt);
  if (options.once || options.shouldStop?.()) return;
  options.prompt?.();
  for await (const line of lines) {
    if (options.shouldStop?.()) break;
    const message = line.trim();
    if (["/exit", "/quit", "exit", "quit"].includes(message.toLowerCase())) break;
    if (message) await turn(message);
    if (options.shouldStop?.()) break;
    options.prompt?.();
  }
}
