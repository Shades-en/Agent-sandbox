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
export function sandboxArgs(cli: string, source: string, timings = false): string[] {
  return ["shell", "fc", "--", "node", cli, "exec", "--timeout", "10",
    ...(timings ? ["--timings", "--json"] : []), "--", source];
}

// Timing mode uses a JSON envelope. Do not strip timing-looking lines from
// guest stderr: a program is allowed to print any text, including those lines.
export function parseTimingReport(raw: ControllerResult): {
  result: ControllerResult; timings: Record<string, number>;
} {
  if (raw.stderr) throw new Error(raw.stderr);
  let data: unknown;
  try { data = JSON.parse(raw.stdout); }
  catch { throw new Error("sandbox: invalid controller timing report"); }
  if (!data || typeof data !== "object") throw new Error("sandbox: invalid controller timing report");
  const report = data as Record<string, unknown>;
  if (typeof report.stdout !== "string" || typeof report.stderr !== "string" ||
      !Number.isInteger(report.exitCode) || report.exitCode !== raw.exitCode ||
      (report.exitCode as number) < 0 || (report.exitCode as number) > 255 ||
      !report.timings || typeof report.timings !== "object" || Array.isArray(report.timings) ||
      !Object.values(report.timings).every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    throw new Error("sandbox: invalid controller timing report");
  }
  return {
    result: { stdout: report.stdout, stderr: report.stderr, exitCode: report.exitCode as number },
    timings: report.timings as Record<string, number>,
  };
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
    "Run JavaScript inside the Firecracker microVM. Use require() for built-in Node modules " +
    "and an async function for await. There is no shell and no network.",
  input: z.object({
    code: z.string().describe("JavaScript source to run inside the microVM"),
  }),
  effect: "destructive",
  async execute({ code }) {
    const enabled = process.env["SANDBOX_TIMINGS"] === "1";
    const started = performance.now();
    try {
      const raw = await runLimactl(sandboxArgs(cliPath(), code, enabled));
      if (!enabled) return interpretControllerResult(raw);
      const { result, timings } = parseTimingReport(raw);
      for (const [phase, ms] of Object.entries(timings)) {
        process.stderr.write(`[timing sandbox] ${phase}: ${ms.toFixed(1)} ms\n`);
      }
      return interpretControllerResult(result);
    } finally {
      if (enabled) process.stderr.write(`[timing agent] lima.roundtrip: ${(performance.now() - started).toFixed(1)} ms\n`);
    }
  },
});
