import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const BTRFS_MAGIC = 0x9123683e;

// Check before creating run directories. An unmounted directory would be on
// ext4 again, so do not hide that problem with an ordinary disk copy.
export async function assertBtrfsStorage(
  directory: string,
  inspect: (directory: string) => Promise<{ type: number }> = statfs,
): Promise<void> {
  try {
    if ((await inspect(directory)).type === BTRFS_MAGIC) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  throw new Error(`Btrfs storage is not mounted at ${directory}. Run scripts/setup-storage.sh inside fc.`);
}

// All disk clones must share blocks. Refuse unsupported/cross-filesystem
// copies instead of falling back to the slow path that this strategy replaces.
export async function copyRootfs(
  base: string,
  dest: string,
  run: (file: string, args: string[]) => Promise<unknown> = runFile,
): Promise<void> {
  try {
    await run("cp", ["--reflink=always", "--", base, dest]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot reflink ${base} to ${dest}. Both disks must be on the sandbox Btrfs volume. ${message}`);
  }
}
