import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineTool } from "ari";
import { z } from "zod";

export interface ControllerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function cliPath(): string {
  return path.join(repoRoot, "host", "dist", "cli.js");
}

export function sandboxArgs(cli: string, command: string): string[] {
  return ["shell", "fc", "--", "node", cli, "exec", "--timeout", "10", "--", command];
}

export function interpretControllerResult(result: ControllerResult): ControllerResult {
  if (result.exitCode === 124 && result.stdout === "" && result.stderr === "timeout\n") {
    return { stdout: "", stderr: "timeout", exitCode: 124 };
  }
  if (result.stderr.startsWith("sandbox:")) {
    throw new Error(result.stderr);
  }
  if (/^(?:FATA|ERRO)\[/m.test(result.stderr)) {
    throw new Error(result.stderr);
  }
  return result;
}

export function runLimactl(args: string[]): Promise<ControllerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("limactl", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

export const bashTool = defineTool({
  description: "Run a shell command inside the Firecracker sandbox",
  input: z.object({
    command: z.string().describe("Shell command to run inside the microVM"),
  }),
  effect: "destructive",
  async execute({ command }) {
    const result = await runLimactl(sandboxArgs(cliPath(), command));
    return interpretControllerResult(result);
  },
});
