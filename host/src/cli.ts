import fs from "node:fs";

import { DEFAULT_COMMAND_TIMEOUT_SEC } from "./constants.js";
import { execCommand, type ExecResult } from "./exec.js";

export function kvmMissingMessage(): string {
  return "sandbox: /dev/kvm is missing. Nested virtualization did not come up in the Lima VM.";
}

export function parseExecArgs(argv: string[]): { timeoutSec: number; command: string } {
  if (argv[0] !== "exec") {
    throw new Error("usage: exec [--timeout seconds] -- <command>");
  }
  let timeoutSec = DEFAULT_COMMAND_TIMEOUT_SEC;
  let index = 1;
  if (argv[index] === "--timeout") {
    const value = argv[index + 1];
    if (value === undefined || Number.isNaN(Number(value))) {
      throw new Error("usage: exec [--timeout seconds] -- <command>");
    }
    timeoutSec = Number(value);
    index += 2;
  }
  if (argv[index] !== "--") {
    throw new Error("usage: exec [--timeout seconds] -- <command>");
  }
  const command = argv.slice(index + 1).join(" ");
  if (command.length === 0) {
    throw new Error("usage: exec [--timeout seconds] -- <command>");
  }
  return { timeoutSec, command };
}

export interface CliIo {
  kvmPath: string;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  exec: (command: string, timeoutSec: number) => Promise<ExecResult>;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: { timeoutSec: number; command: string };
  try {
    parsed = parseExecArgs(argv);
  } catch (error) {
    io.stderr(`sandbox: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!fs.existsSync(io.kvmPath)) {
    io.stderr(`${kvmMissingMessage()}\n`);
    return 1;
  }
  try {
    const result = await io.exec(parsed.command, parsed.timeoutSec);
    io.stdout(result.stdout);
    io.stderr(result.stderr);
    return result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(message.startsWith("sandbox: ") ? `${message}\n` : `sandbox: ${message}\n`);
    return 1;
  }
}

export async function main(argv: string[]): Promise<void> {
  const code = await runCli(argv, {
    kvmPath: "/dev/kvm",
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
    exec: execCommand,
  });
  process.exitCode = code;
}

if (process.argv[1]?.endsWith("cli.js")) {
  void main(process.argv.slice(2));
}
