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

// Ari runs on the Mac. Firecracker runs in the Lima VM named fc.
// limactl shell enters that VM and runs the controller there.
export function sandboxArgs(cli: string, source: string): string[] {
  return ["shell", "fc", "--", "node", cli, "exec", "--timeout", "10", "--", source];
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

export const javascriptTool = defineTool({
  description:
    "Run JavaScript inside the Firecracker microVM. Node.js executes the source. There is no shell and no network.",
  input: z.object({
    code: z.string().describe("JavaScript source to run inside the microVM"),
  }),
  effect: "destructive",
  async execute({ code }) {
    const result = await runLimactl(sandboxArgs(cliPath(), code));
    return interpretControllerResult(result);
  },
});
