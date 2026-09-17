import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBtrfsStorage, copyRootfs } from "../src/storage.js";

test("accepts Btrfs and rejects an unmounted directory on ext4", async () => {
  await assertBtrfsStorage("/storage", async () => ({ type: 0x9123683e }));
  await assert.rejects(
    assertBtrfsStorage("/storage", async () => ({ type: 0xef53 })),
    /Btrfs storage is not mounted.*setup-storage.sh/,
  );
});

test("a missing storage directory has setup guidance; other failures are preserved", async () => {
  await assert.rejects(
    assertBtrfsStorage("/missing", async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
    /setup-storage.sh/,
  );
  await assert.rejects(
    assertBtrfsStorage("/denied", async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }),
    /denied/,
  );
});

test("unsupported reflinks fail without retrying an ordinary copy", async () => {
  const calls: string[][] = [];
  await assert.rejects(copyRootfs("/base", "/run", async (file, args) => {
    calls.push([file, ...args]);
    throw new Error("Operation not supported");
  }), /Cannot reflink.*Btrfs.*Operation not supported/);
  assert.deepEqual(calls, [["cp", "--reflink=always", "--", "/base", "/run"]]);
});
