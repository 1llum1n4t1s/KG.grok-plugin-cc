import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { readWindowsWorkingTreeFiles } from "../plugins/grok/scripts/lib/git.mjs";

// 先に固定する条件: missing-parent は欠落、reparse/共有違反は欠落にしない。
// 明示された専用fixture親のみ使う。削除は行わず、呼出元がPrunletで清掃する。
const parent = process.env.GROK_GIT_NATIVE_FIXTURE_ROOT;
test("Windows native reader distinguishes a missing parent from unsafe access", {
  skip: process.platform !== "win32" || !parent
}, (t) => {
  const absoluteParent = path.resolve(parent);
  assert.equal(absoluteParent, parent);
  for (let current = absoluteParent;; current = path.dirname(current)) {
    assert.equal(fs.lstatSync(current).isSymbolicLink(), false, current);
    if (current === path.dirname(current)) break;
  }
  fs.accessSync(absoluteParent, fs.constants.W_OK);
  const root = path.join(absoluteParent, `git-missing-parent-${randomUUID()}`);
  fs.mkdirSync(root);
  t.diagnostic(`Retained fixture for caller Prunlet cleanup: ${root}`);
  fs.mkdirSync(path.join(root, "present"));
  const missing = readWindowsWorkingTreeFiles(root, ["missing/file.txt", "present/missing/file.txt"]);
  assert.equal(missing.get("missing/file.txt"), null);
  assert.equal(missing.get("present/missing/file.txt"), null);
  fs.mkdirSync(path.join(root, "target"));
  fs.symlinkSync(path.join(root, "target"), path.join(root, "junction"), "junction");
  assert.throws(() => readWindowsWorkingTreeFiles(root, ["junction/file.txt"]), /Review incomplete/);
  fs.writeFileSync(path.join(root, "locked.txt"), "locked\n");
  const writer = fs.openSync(path.join(root, "locked.txt"), "r+");
  try {
    assert.throws(() => readWindowsWorkingTreeFiles(root, ["locked.txt"]), /Review incomplete/);
  } finally {
    fs.closeSync(writer);
  }
});
