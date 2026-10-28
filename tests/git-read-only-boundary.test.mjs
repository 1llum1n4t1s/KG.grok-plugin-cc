import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { classifyShellCommand } from "../plugins/grok/scripts/lib/grok.mjs";
import test from "node:test";

import {
  collectReviewContext,
  getWorkingTreeFingerprint,
  getWorkingTreeState,
  resolveReviewTarget
} from "../plugins/grok/scripts/lib/git.mjs";

// 実 Git・攻撃用設定・fixture の作成と削除を使わず、spawn 境界だけを検証する。
const commands = new Set(["rev-parse", "branch", "merge-base", "diff", "status", "ls-files", "ls-tree", "log", "symbolic-ref", "show-ref"]);

function fakeGit(t, { submodule = false, diffText = "", changedFiles = "", rawOutput = null } = {}) {
  const calls = [];
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    assert.equal(command, "git");
    assert.equal(options.shell, false);
    const index = args.findIndex((arg) => commands.has(arg));
    assert.notEqual(index, -1, `Unexpected Git query: ${args.join(" ")}`);
    const query = args.slice(index);
    calls.push(query);
    let stdout = "";
    if (query[0] === "rev-parse") stdout = query.includes("--show-toplevel") ? process.cwd() : "a".repeat(40);
    if (query[0] === "branch") stdout = "feature";
    if (query[0] === "merge-base") stdout = "b".repeat(40);
    if (query[0] === "symbolic-ref") stdout = "refs/remotes/origin/main";
    if (query[0] === "ls-tree" && submodule) stdout = `160000 commit ${"c".repeat(40)}\tchild\0`;
    if (query[0] === "diff" && query.includes("--raw") && submodule) stdout = `:160000 160000 ${"c".repeat(40)} ${"d".repeat(40)} M\0child\0`;
    if (query[0] === "diff" && query.includes("--raw") && rawOutput !== null) stdout = rawOutput;
    if (query[0] === "diff" && query.includes("--binary")) stdout = diffText;
    if (query[0] === "diff" && query.includes("--name-only")) stdout = changedFiles;
    return { status: 0, stdout, stderr: "" };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

for (const [name, invoke] of [
  ["working-tree state", () => getWorkingTreeState(process.cwd())],
  ["automatic review scope", () => resolveReviewTarget(process.cwd())],
  ["working-tree review context", () => collectReviewContext(process.cwd(), { mode: "working-tree" })],
  ["stop fingerprint", () => getWorkingTreeFingerprint(process.cwd())]
]) {
  test(`Git execution boundary: ${name} fails closed before filter-capable queries`, (t) => {
    const calls = fakeGit(t);
    assert.throws(invoke, /incomplete|cannot safely|read-only.*(?:filter|work.?tree)/i);
    assert.ok(calls.every((args) => args[0] !== "status" && (args[0] !== "diff" || args.includes("--cached"))), JSON.stringify(calls));
  });
}

test("Git execution boundary: branch comparison avoids nested submodule diff", (t) => {
  const calls = fakeGit(t);
  const context = collectReviewContext(process.cwd(), { mode: "branch", baseRef: "main" });
  assert.equal(context.mode, "branch");
  assert.ok(calls.every((args) => !args.includes("--submodule=diff")), JSON.stringify(calls));
  const ranges = calls.filter(([command]) => command === "diff").map((args) => args.at(-1));
  assert.ok(ranges.length > 1);
  assert.ok(ranges.every((range) => range === `${"b".repeat(40)}..${"a".repeat(40)}`));
});

test("Git execution boundary: branch inline and lightweight collection remain available", (t) => {
  fakeGit(t, { diffText: "INLINE_MARKER".repeat(10), changedFiles: "app.js" });
  const target = { mode: "branch", baseRef: "main" };
  const inline = collectReviewContext(process.cwd(), target);
  assert.equal(inline.inputMode, "inline-diff");
  assert.match(inline.content, /INLINE_MARKER/);
  const lightweight = collectReviewContext(process.cwd(), target, { maxInlineDiffBytes: 8 });
  assert.equal(lightweight.inputMode, "self-collect");
  assert.equal(lightweight.fileCount, 1);
  assert.doesNotMatch(lightweight.content, /INLINE_MARKER/);
  const command = /Use this fixed object comparison: (git .*?)\. Put optional/.exec(lightweight.collectionGuidance)?.[1];
  assert.ok(command, lightweight.collectionGuidance);
  assert.equal(classifyShellCommand(command).allowed, true, command);
});

test("Git execution boundary: malformed raw modes do not establish a complete comparison", (t) => {
  fakeGit(t, { rawOutput: "unexpected\0app.js\0" });
  assert.throws(() => collectReviewContext(process.cwd(), { mode: "branch", baseRef: "main" }), /incomplete.*file modes/i);
});

test("Git execution boundary: a changed gitlink cannot be silently omitted", (t) => {
  fakeGit(t, { submodule: true });
  assert.throws(
    () => collectReviewContext(process.cwd(), { mode: "branch", baseRef: "main" }),
    /incomplete|submodule|gitlink/i
  );
});

test("Git execution boundary: repository inventory remains available", (t) => {
  const calls = fakeGit(t);
  const target = resolveReviewTarget(process.cwd(), { scope: "repo" });
  const context = collectReviewContext(process.cwd(), target);
  assert.equal(context.mode, "repo");
  assert.ok(calls.some(([command]) => command === "ls-files"));
  assert.ok(calls.every(([command]) => command !== "status" && command !== "diff"));
});
