import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectReviewContext,
  ensureGitRepository,
  resolveReviewTarget
} from "../plugins/grok/scripts/lib/git.mjs";
import { initGitRepo as initBaseGitRepo, makeTempDir, run } from "./helpers.mjs";

function initGitRepo(cwd) {
  initBaseGitRepo(cwd);
  // snapshot の対応範囲を fixture 自身で指定し、利用者の global 設定に依存させない。
  run("git", ["config", "core.autocrlf", "false"], { cwd });
  run("git", ["config", "core.filemode", "false"], { cwd });
}

function workingTreeValue(operation) {
  if (process.platform === "win32") return operation();
  assert.throws(operation, /Review incomplete/);
  return null;
}

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = workingTreeValue(() => resolveReviewTarget(cwd, {}));
  if (target) assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = workingTreeValue(() => resolveReviewTarget(cwd, {}));
  if (target) assert.equal(target.mode, "branch");
});

test("default branch names with special characters are passed to git literally", () => {
  const cwd = makeTempDir();
  const branchName = "main&branch-helper&x";
  const helperOutputPath = path.join(cwd, "branch-helper-output");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "branch-helper.cmd"), "@echo branch-helper>branch-helper-output\r\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js", "branch-helper.cmd"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["branch", "-m", branchName], { cwd, shell: false });
  run("git", ["update-ref", `refs/remotes/origin/${branchName}`, branchName], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branchName}`], {
    cwd,
    shell: false
  });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, { scope: "branch" });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, branchName);
  assert.match(context.content, /Branch Diff/);
  assert.equal(fs.existsSync(helperOutputPath), false);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, { scope: "branch" }),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("repo scope audits the whole source even when the working tree is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('DIRTY_DIFF_MARKER');\n");
  fs.writeFileSync(path.join(cwd, "notes.txt"), "untracked\n");

  const target = resolveReviewTarget(cwd, { scope: "repo" });
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "repo");
  assert.equal(context.inputMode, "self-collect");
  assert.match(context.content, /## Tracked Files/);
  assert.match(context.content, /^app\.js$/m);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /^notes\.txt$/m);
  assert.match(context.collectionGuidance, /ignore the current uncommitted diff/i);
  // 監査コンテキストには差分もファイル内容も入れない。中身は Grok が自分で読む。
  assert.doesNotMatch(context.content, /DIRTY_DIFF_MARKER/);
  assert.doesNotMatch(context.content, /Unstaged Diff/);
});

test("repo scope rejects --base because an audit is not a diff", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  assert.throws(() => resolveReviewTarget(cwd, { scope: "repo", base: "main" }), /--base does not apply to --scope repo/);
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = workingTreeValue(() => collectReviewContext(cwd, target));
  if (context) { assert.equal(context.inputMode, "inline-diff"); assert.match(context.content, /INLINE_MARKER/); }
});

test("collectReviewContext skips untracked directories in working tree review (fails closed while worktree filters cannot be isolated)", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  assert.throws(() => collectReviewContext(cwd, target), /Review incomplete/);
});

test("collectReviewContext skips untracked symlinks instead of crashing (fails closed while worktree filters cannot be isolated)", (t) => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  try {
    fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));
  } catch (error) {
    // Windows は開発者モードか管理者権限が無いとシンボリックリンクを作れない。
    // テスト対象の挙動ではなく前提条件が満たせないだけなので、飛ばして通す。
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("creating symlinks requires elevated permissions on this platform");
      return;
    }
    throw error;
  }

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  assert.throws(() => collectReviewContext(cwd, target), /Review incomplete/);
});

test("collectReviewContext provides complete inline evidence for larger supported working tree reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = workingTreeValue(() => collectReviewContext(cwd, target));
  if (context) {
    assert.equal(context.inputMode, "inline-diff");
    for (const marker of ["SELF_COLLECT_MARKER_A", "SELF_COLLECT_MARKER_B", "SELF_COLLECT_MARKER_C"]) assert.match(context.content, new RegExp(marker));
  }
});

test("collectReviewContext falls back to lightweight context for oversized single-file diffs (fails closed while worktree filters cannot be isolated)", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  assert.throws(() => collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 }), /Review incomplete/);
});

test("collectReviewContext includes complete tracked and untracked working tree evidence", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = workingTreeValue(() => collectReviewContext(cwd, target));
  if (context) {
    assert.equal(context.inputMode, "inline-diff");
    for (const marker of ["TRACKED_MARKER_A", "TRACKED_MARKER_B", "UNTRACKED_RISK_MARKER"]) assert.match(context.content, new RegExp(marker));
  }
});

test("collectReviewContext caps aggregate untracked file content (fails closed while worktree filters cannot be isolated)", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "tracked.js"), "export const tracked = true;\n");
  run("git", ["add", "tracked.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(cwd, `untracked-${String(index).padStart(2, "0")}.txt`), `${index}: ${"x".repeat(23 * 1024)}\n`);
  }

  assert.throws(() => collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" })), /Review incomplete/);
});

test("Git safety: every internal call suppresses config execution and diff drivers", (t) => {
  const calls = [];
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    assert.equal(command, "git");
    calls.push({ args, options });
    return { status: 0, stdout: args.includes("--show-toplevel") ? process.cwd() : args.includes("--verify") || args.includes("merge-base") ? "a".repeat(40) : "", stderr: "" };
  });
  syncBuiltinESMExports();
  try {
    for (const mode of ["repo", "branch"]) {
      for (const includeDiff of [true, false]) {
        collectReviewContext(process.cwd(), { mode, baseRef: "main" }, { includeDiff });
      }
    }
    assert.throws(() => collectReviewContext(process.cwd(), { mode: "working-tree" }), /Review incomplete/);
    assert.ok(calls.length > 20);
    for (const { args, options } of calls) {
      assert.deepEqual(args.slice(0, 13), ["--no-pager", "--no-optional-locks", "--no-lazy-fetch", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "format.pretty=medium", "-c", "log.diffMerges=off", "-c", "diff.submodule=short"]);
      assert.equal(options.shell, false);
      if (["diff", "show", "log", "whatchanged"].includes(args[13])) {
        assert.deepEqual(args.slice(14, 16), ["--no-ext-diff", "--no-textconv"]);
      }
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("Git compatibility: unsupported no-lazy-fetch fails explicitly on every review entry", (t) => {
  const calls = [];
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 129, stdout: "", stderr: "unknown option: --no-lazy-fetch" };
  });
  syncBuiltinESMExports();
  try {
    for (const invoke of [
      () => ensureGitRepository(process.cwd()),
      () => collectReviewContext(process.cwd(), { mode: "repo" }),
      () => resolveReviewTarget(process.cwd(), {})
    ]) {
      const start = calls.length;
      assert.throws(invoke, /Git 2\.45 or newer.*--no-lazy-fetch/);
      assert.equal(calls.length - start, 2);
      assert.deepEqual(calls.at(-1).args, ["--no-pager", "--no-lazy-fetch", "--version"]);
    }
    assert.ok(calls.every(({ options }) => options.shell === false));
    assert.ok(calls.every(({ args }) => args.includes("--no-lazy-fetch")));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("Git compatibility: startup, capability and repository failures remain distinct", (t) => {
  const cases = [
    { result: { error: Object.assign(new Error("missing"), { code: "ENOENT" }) }, expected: /git is not installed/ },
    { result: { error: Object.assign(new Error("denied"), { code: "EACCES" }) }, expected: /Unable to start Git.*EACCES/ },
    { result: { status: null, signal: "SIGTERM" }, expected: /Git.*terminated.*SIGTERM/ },
    { result: { status: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" }, expected: /must run inside a Git repository/ },
    { result: { status: 128, stderr: "fatal: detected dubious ownership in repository" }, expected: /Git repository lookup failed/ },
    { result: { status: 129, stderr: "unknown option: --no-lazy-fetch" }, probe: { status: 1, stderr: "capability unavailable" }, expected: /Git capability check failed/ }
  ];
  for (const { result, probe, expected } of cases) {
    const calls = [];
    t.mock.method(childProcess, "spawnSync", (command, args, options) => {
      calls.push({ args, options });
      return args.includes("--version") ? (probe ?? { status: 0, stdout: "git version 2.55.0", stderr: "" }) : { stdout: "", stderr: "", ...result };
    });
    syncBuiltinESMExports();
    try { assert.throws(() => ensureGitRepository(process.cwd()), expected); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }
});

test("Git compatibility: successful queries need no extra capability process", (t) => {
  let count = 0;
  t.mock.method(childProcess, "spawnSync", () => { count++; return { status: 0, stdout: process.cwd(), stderr: "" }; });
  syncBuiltinESMExports();
  try { assert.equal(ensureGitRepository(process.cwd()), process.cwd()); assert.equal(count, 1); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
