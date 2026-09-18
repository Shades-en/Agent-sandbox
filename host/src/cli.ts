import fs from "node:fs";

import { DEFAULT_COMMAND_TIMEOUT_SEC } from "./constants.js";
import { execCommand, type ExecResult } from "./exec.js";

export function kvmMissingMessage(): string {
  return "sandbox: /dev/kvm is missing. Nested virtualization did not come up in the Lima VM.";
}

export function kvmDeniedMessage(): string {
  return "sandbox: /dev/kvm is present but not writable. Grant the Lima user access with setfacl.";
}

// Firecracker needs /dev/kvm inside the Lima VM. This Mac does not have it.
// Opening the device checks that nested virtualization came up and that
// this user can use it. We close it again; Firecracker opens it itself.
export function openKvm(kvmPath: string): void {
  const fd = fs.openSync(kvmPath, "r+");
  fs.closeSync(fd);
}

interface ExecArgs {
  timeoutSec: number;
  command: string;
  json?: boolean;
  timings?: boolean;
}

export function parseExecArgs(argv: string[]): ExecArgs {
  const usage = "usage: exec [--timeout seconds] [--timings] [--json] -- <JavaScript>";
  if (argv[0] !== "exec") throw new Error(usage);
  const options: ExecArgs = { timeoutSec: DEFAULT_COMMAND_TIMEOUT_SEC, command: "" };
  let index = 1;
  while (argv[index] !== "--") {
    const option = argv[index++];
    if (option === "--timeout") {
      const value = Number(argv[index++]);
      if (!Number.isFinite(value) || value <= 0) throw new Error(usage);
      options.timeoutSec = value;
    } else if (option === "--timings") options.timings = true;
    else if (option === "--json") options.json = true;
    else throw new Error(usage);
  }
  options.command = argv.slice(index + 1).join(" ");
  if (!options.command) throw new Error(usage);
  return options;
}

export interface CliIo {
  kvmPath: string;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  exec: (command: string, timeoutSec: number) => Promise<ExecResult>;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: ExecArgs;
  try {
    parsed = parseExecArgs(argv);
  } catch (error) {
    io.stderr(`sandbox: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  try {
    openKvm(io.kvmPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      io.stderr(`${kvmMissingMessage()}\n`);
      return 1;
    }
    if (code === "EACCES" || code === "EPERM") {
      io.stderr(`${kvmDeniedMessage()}\n`);
      return 1;
    }
    throw error;
  }
  try {
    const result = await io.exec(parsed.command, parsed.timeoutSec);
    if (parsed.json) {
      // Keep guest stderr inside the report. The tool can display diagnostics
      // separately without ever mistaking a timing line for guest output.
      io.stdout(`${JSON.stringify(result)}\n`);
    } else {
      io.stdout(result.stdout);
      io.stderr(result.stderr);
      if (parsed.timings) {
        for (const [phase, ms] of Object.entries(result.timings ?? {})) {
          io.stderr(`[timing sandbox] ${phase}: ${ms.toFixed(1)} ms\n`);
        }
      }
    }
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
