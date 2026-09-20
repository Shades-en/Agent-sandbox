import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);
export const NETWORK_HELPER = "/usr/local/libexec/agent-sandbox-network";
export const GUEST_MAC = "02:fc:00:00:00:01";
export interface NetworkHandle {
  id: string;
  hostDevName: string;
  release(): Promise<void>;
}

// Privileged work is scoped to this VM's namespace and interfaces. The VMM
// itself runs as the regular user inside that namespace.
export async function createNetwork(): Promise<NetworkHandle> {
  const id = randomBytes(4).toString("hex");
  try {
    await run("sudo", ["-n", NETWORK_HELPER, "create", id], { timeout: 15_000 });
  } catch (error) {
    // A timeout can interrupt the helper after it reserved a lease.
    await run("sudo", ["-n", NETWORK_HELPER, "delete", id], { timeout: 15_000 }).catch(() => {});
    throw new Error(`Network setup failed; run scripts/setup-network.sh inside fc. ${error instanceof Error ? error.message : error}`);
  }
  return {
    id, hostDevName: "tap0",
    async release() {
      await run("sudo", ["-n", NETWORK_HELPER, "delete", id], { timeout: 15_000 });
    },
  };
}
