/**
 * 偽の `grok agent stdio` を相手に、companion スクリプトの各コマンドを
 * 実プロセスとして走らせる統合テスト。実際の xAI API は叩かない。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, initGitRepo, removeTempFixture, run } from "./helpers.mjs";

type FixtureIdentity = { dev: bigint; ino: bigint };
type FixtureOwner = { pid: number; closed: boolean; error: boolean; exitCode: number | null; signal: NodeJS.Signals | null; child?: import('node:child_process').ChildProcess; close?: Promise<void> };
type RuntimeFixture = { roots: { file: string; identity?: FixtureIdentity }[]; links: { file: string; dev: bigint; ino: bigint; target: string }[]; owners: FixtureOwner[]; fake?: ReturnType<typeof installFakeGrok>; repo?: string; dataDir?: string; trackingLog?: string };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok", "scripts", "grok-companion.mjs");

const REVIEW_JSON = JSON.stringify({
  verdict: "needs-attention",
  summary: "One real problem.",
  findings: [
    {
      severity: "high",
      title: "Unvalidated input",
      body: "The name argument reaches the query unescaped.",
      file: "auth.js",
      line_start: 2,
      line_end: 2,
      confidence: 0.9,
      recommendation: "Use a parameterized query."
    }
  ],
  next_steps: ["Parameterize the query."]
});

const runtimeFixtures: RuntimeFixture[] = [];
const trackedPosix = process.platform === "linux" || process.platform === "darwin";
const runtimePreload = String.raw`
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
let logFailed = false;
const log = record => {
  try { fs.appendFileSync(process.env.RUNTIME_PROCESS_LOG, JSON.stringify(record) + "\n"); }
  catch (error) { logFailed = true; throw error; }
};
process.once("exit", () => {
  if (!logFailed) {
    try { log({ type: "tracking-complete", pid: process.pid }); } catch {}
  }
});
function identity(pid) {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], group: Number(fields[2]), start: fields[19] };
  } catch { return null; }
}
log({ type: "ready", pid: process.pid, identity: identity(process.pid) });
const realSpawn = childProcess.spawn, realSpawnSync = childProcess.spawnSync;
childProcess.spawn = function(file, args, options) {
  const bunSupervisor = process.versions.bun && file === process.execPath && Array.isArray(args) &&
    args.some(arg => typeof arg === "string" && arg.endsWith("/posix-agent-supervisor.mjs")) && process.env.RUNTIME_PRELOAD;
  const child = bunSupervisor
    ? realSpawn.call(this, file, ["--preload", process.env.RUNTIME_PRELOAD, ...args], options)
    : realSpawn.apply(this, arguments);
  const opts = Array.isArray(args) ? options : args;
  log({ type: "spawn", pid: child.pid ?? null, identity: child.pid ? identity(child.pid) : null, detached: opts?.detached === true });
  child.once("close", (code, signal) => log({ type: "close", pid: child.pid ?? null, code, signal }));
  return child;
};
childProcess.spawnSync = function(file) {
  const result = realSpawnSync.apply(this, arguments);
  if (file === process.env.RUNTIME_FAKE_BIN) {
    log({ type: "sync", pid: result.pid ?? null, status: result.status, signal: result.signal, error: Boolean(result.error) });
  }
  return result;
};
syncBuiltinESMExports();
`;

function fixtureIdentity(file: string) {
  const stat = fs.lstatSync(file, { bigint: true });
  assert.equal(stat.isSymbolicLink(), false, "fixture root must not be a link");
  return { dev: stat.dev, ino: stat.ino };
}
function assertFixtureIdentity(file: string, identity: FixtureIdentity) {
  assert.deepEqual(fixtureIdentity(file), identity, "fixture root identity changed: " + file);
}
function recordSyncOwner(repo, result) {
  if (!trackedPosix) return;
  const f = runtimeFixtures.find(item => item.repo === repo);
  assert.ok(f, "fixture owner is not registered");
  f.owners.push({ pid: result.pid, closed: result.status !== null || result.signal !== null, error: Boolean(result.error), exitCode: result.status, signal: result.signal });
}
function recordChildOwner(f: RuntimeFixture, child: import('node:child_process').ChildProcess) {
  const owner: FixtureOwner = { pid: child.pid, closed: false, error: false, exitCode: null, signal: null, child };
  f.owners.push(owner);
  owner.close = new Promise<void>(resolve => child.once("close", (code, signal) => { owner.closed = true; owner.exitCode = code; owner.signal = signal; resolve(); }));
  child.once("error", () => { owner.error = true; });
}
async function closeRuntimeFixture(f: RuntimeFixture) {
  const paths = [f.repo, f.dataDir, f.fake?.binDir].filter(Boolean).join("; ");
  try {
    for (const owner of f.owners) {
      if (owner.close && !owner.closed) {
        let timer;
        try {
          await Promise.race([owner.close, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("fixture owner did not close")), 15000); })]);
        } finally { clearTimeout(timer); }
      }
    }
    const records = f.trackingLog && fs.existsSync(f.trackingLog)
      ? fs.readFileSync(f.trackingLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    for (const owner of f.owners) {
      assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.closed && !owner.error, "fixture owner close was not confirmed");
      assert.ok(Number.isInteger(owner.exitCode) && owner.signal === null, "fixture owner normal exit was not confirmed");
      const ready = records.filter(record => record.type === "ready" && record.pid === owner.pid);
      assert.equal(ready.length, 1, "fixture owner tracking was not confirmed");
      assert.equal(records.filter(record => record.type === "tracking-complete" && record.pid === owner.pid).length, 1, "fixture owner tracking completion was not confirmed");
      if (process.platform === "linux") assert.ok(ready[0].identity?.start, "fixture owner start identity is missing");
    }
    for (const record of records.filter(record => record.type === "sync")) {
      assert.ok(record.pid > 0 && !record.error && (record.status !== null || record.signal !== null), "synchronous fake process exit was not confirmed");
    }
    for (const record of records.filter(record => record.type === "spawn")) {
      if (process.platform === "darwin") {
        assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0, "fixture child PID is missing");
        assert.equal(records.filter(entry => entry.type === "close" && entry.pid === record.pid).length, 1, "fixture child close was not confirmed");
        if (record.detached) {
          assert.throws(() => process.kill(-record.pid, 0), { code: "ESRCH" }, "owned process group must be absent");
        }
        continue;
      }
      assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0 && record.identity?.start, "fixture child start identity is missing");
      if (record.detached) assert.equal(record.identity.group, record.pid, "detached child group was not identified");
      else assert.equal(records.filter(entry => entry.type === "close" && entry.pid === record.pid).length, 1, "non-detached child close was not confirmed");
      const deadline = Date.now() + 15000;
      for (;;) {
        let live = false;
        try {
          const raw = fs.readFileSync("/proc/" + record.pid + "/stat", "utf8");
          const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
          live = fields[19] === record.identity.start && !["Z", "X", "x"].includes(fields[0]);
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
        let groupLive = false;
        if (record.detached) {
          try { process.kill(-record.pid, 0); groupLive = true; }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        if (!live && !groupLive) break;
        if (Date.now() >= deadline) throw new Error("fixture child or owned group did not exit: " + record.pid);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    for (const item of f.roots) assertFixtureIdentity(item.file, item.identity);
    for (const link of f.links) {
      const stat = fs.lstatSync(link.file, { bigint: true });
      assert.ok(stat.isSymbolicLink() && stat.dev === link.dev && stat.ino === link.ino, "fixture link identity changed");
      assert.equal(fs.readlinkSync(link.file), link.target, "fixture link target changed");
      fs.unlinkSync(link.file);
    }
    for (const item of f.roots) {
      assertFixtureIdentity(item.file, item.identity);
      removeTempFixture(item.file, { recursive: true, force: true });
    }
  } catch (error) {
    throw new Error("Fixture retained because ownership or shutdown could not be confirmed: " + paths, { cause: error });
  }
}

test.afterEach(async () => {
  if (!trackedPosix) return;
  const fixtures = runtimeFixtures.splice(0);
  const failures = [];
  for (const f of fixtures) {
    try { await closeRuntimeFixture(f); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "Runtime fixture cleanup could not be confirmed");
});

test("Darwin fixture cleanup retains evidence when a child close record is missing", { skip: process.platform !== "darwin" }, async () => {
  const root = makeTempDir("grok-runtime-close-evidence-");
  const trackingLog = path.join(root, "process-ownership.jsonl");
  const f: RuntimeFixture = {
    roots: [{ file: root, identity: fixtureIdentity(root) }], links: [],
    owners: [{ pid: process.pid, closed: true, error: false, exitCode: 0, signal: null }], repo: root, trackingLog
  };
  try {
    fs.writeFileSync(trackingLog, [
      { type: "ready", pid: process.pid },
      { type: "tracking-complete", pid: process.pid },
      { type: "spawn", pid: process.pid, detached: false }
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
    await assert.rejects(closeRuntimeFixture(f), error => {
      assert.ok(error instanceof Error && error.message.includes(root));
      assert.match(String(error.cause), /fixture child close was not confirmed/);
      return true;
    });
    assert.ok(fs.statSync(root).isDirectory());
    assert.ok(fs.statSync(trackingLog).isFile());
  } finally {
    assertFixtureIdentity(root, f.roots[0].identity);
    removeTempFixture(root, { recursive: true, force: true });
  }
});

test("fixture cleanup requires a normal owner exit but permits exit code one", { skip: !trackedPosix }, async () => {
  const root = makeTempDir("grok-runtime-owner-exit-");
  const trackingLog = path.join(root, "process-ownership.jsonl");
  const owner: FixtureOwner = { pid: process.pid, closed: true, error: false, exitCode: null, signal: "SIGTERM" };
  const f: RuntimeFixture = { roots: [{ file: root, identity: fixtureIdentity(root) }], links: [], owners: [owner], repo: root, trackingLog };
  let cleaned = false;
  try {
    fs.writeFileSync(trackingLog, [
      { type: "ready", pid: process.pid, identity: { start: "synthetic" } },
      { type: "tracking-complete", pid: process.pid }
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
    await assert.rejects(closeRuntimeFixture(f), error => {
      assert.ok(error instanceof Error && error.message.includes(root));
      assert.match(String(error.cause), /fixture owner normal exit was not confirmed/);
      return true;
    });
    assert.ok(fs.statSync(root).isDirectory());
    assert.ok(fs.statSync(trackingLog).isFile());
    owner.exitCode = 1;
    owner.signal = null;
    await closeRuntimeFixture(f);
    cleaned = true;
    assert.equal(fs.existsSync(root), false);
  } finally {
    if (!cleaned) {
      assertFixtureIdentity(root, f.roots[0].identity);
      removeTempFixture(root, { recursive: true, force: true });
    }
  }
});

test("fixture cleanup retains evidence when the preload cannot record a spawn", { skip: !trackedPosix }, async (t) => {
  const root = makeTempDir("grok-runtime-log-failure-");
  const trackingLog = path.join(root, "process-ownership.jsonl");
  const preload = path.join(root, "process-ownership.cjs");
  const failurePreload = path.join(root, "fail-spawn-log.cjs");
  const f: RuntimeFixture = { roots: [{ file: root, identity: fixtureIdentity(root) }], links: [], owners: [], repo: root, trackingLog };
  let stopped = false;
  try {
    fs.writeFileSync(preload, runtimePreload);
    fs.writeFileSync(failurePreload, String.raw`
const fs = require("node:fs");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const append = fs.appendFileSync;
let failed = false;
fs.appendFileSync = function(file, data) {
  if (!failed && JSON.parse(String(data)).type === "spawn") {
    failed = true;
    throw Object.assign(new Error("fixture spawn log failure"), { code: "EIO" });
  }
  return append.apply(this, arguments);
};
childProcess.spawn = () => Object.assign(new EventEmitter(), { pid: process.pid });
`);
    const preloadArgs = "bun" in process.versions
      ? ["--no-env-file", "--preload", failurePreload, "--preload", preload]
      : ["--require", failurePreload, "--require", preload];
    const result = spawnSync(process.execPath, [...preloadArgs, "-e", 'try { require("node:child_process").spawn("synthetic-child"); } catch { process.exitCode = 1; }'], {
      cwd: root, env: { ...process.env, RUNTIME_PROCESS_LOG: trackingLog }, encoding: "utf8", timeout: 5000, windowsHide: true
    });
    stopped = !result.error && Number.isInteger(result.status) && result.signal === null;
    assert.ok(stopped, "short-lived preload probe exit was not confirmed");
    assert.equal(result.status, 1, result.stderr);
    f.owners.push({ pid: result.pid, closed: true, error: false, exitCode: result.status, signal: result.signal });
    const records = fs.readFileSync(trackingLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records.filter(record => record.type === "ready" && record.pid === result.pid).length, 1);
    assert.equal(records.filter(record => record.type === "tracking-complete" && record.pid === result.pid).length, 0);
    await assert.rejects(closeRuntimeFixture(f), error => {
      assert.ok(error instanceof Error && error.message.includes(root));
      assert.match(String(error.cause), /fixture owner tracking completion was not confirmed/);
      return true;
    });
    assert.ok(fs.statSync(root).isDirectory());
    assert.ok(fs.statSync(trackingLog).isFile());
  } finally {
    if (stopped) {
      assertFixtureIdentity(root, f.roots[0].identity);
      removeTempFixture(root, { recursive: true, force: true });
    } else {
      t.diagnostic(`Fixture retained because preload probe shutdown was not confirmed: ${root}`);
    }
  }
});

/** 偽 grok と使い捨ての git リポジトリを用意する。 */
function setupWorkspace(scenario: import('./fake-grok-fixture.mjs').FakeGrokScenario) {
  const f: RuntimeFixture = { roots: [], links: [], owners: [] };
  if (trackedPosix) runtimeFixtures.push(f);
  const fake = installFakeGrok(scenario);
  f.fake = fake;
  if (trackedPosix) { const root: { file: string; identity?: FixtureIdentity } = { file: fake.binDir }; f.roots.push(root); root.identity = fixtureIdentity(root.file); }
  const repo = makeTempDir("grok-plugin-repo-");
  f.repo = repo;
  if (trackedPosix) { const root: { file: string; identity?: FixtureIdentity } = { file: repo }; f.roots.push(root); root.identity = fixtureIdentity(root.file); }
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "auth.js"), "export const a = 1;\n", "utf8");
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-m", "初期化"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "auth.js"), "export const a = 2;\n", "utf8");
  const dataDir = makeTempDir("grok-plugin-data-");
  f.dataDir = dataDir;
  if (trackedPosix) { const root: { file: string; identity?: FixtureIdentity } = { file: dataDir }; f.roots.push(root); root.identity = fixtureIdentity(root.file); }
  const env: NodeJS.ProcessEnv = { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir };
  if (trackedPosix) {
    f.trackingLog = path.join(dataDir, "process-ownership.jsonl");
    const preload = path.join(dataDir, "process-ownership.cjs");
    fs.writeFileSync(preload, runtimePreload);
    env.RUNTIME_PROCESS_LOG = f.trackingLog;
    env.RUNTIME_FAKE_BIN = fake.env.GROK_BIN;
    if ("bun" in process.versions) {
      env.RUNTIME_PRELOAD = preload;
    } else {
      env.NODE_OPTIONS = (env.NODE_OPTIONS ?? "") + " --require=" + JSON.stringify(preload);
    }
  }
  return { fake, repo, env, registerLink(file) {
    if (!trackedPosix) return;
    const stat = fs.lstatSync(file, { bigint: true });
    assert.ok(stat.isSymbolicLink());
    f.links.push({ file, dev: stat.dev, ino: stat.ino, target: fs.readlinkSync(file) });
  } };
}

function runtimeArgs(env, args) {
  return trackedPosix && "bun" in process.versions ? ["--preload", env.RUNTIME_PRELOAD, ...args] : args;
}

function companion(args, { repo, env }) {
  const result = run(process.execPath, runtimeArgs(env, [SCRIPT, ...args]), { cwd: repo, env });
  recordSyncOwner(repo, result);
  return result;
}

// POSIX では実際の branch 差分を使い、Windows の dirty working-tree 経路は維持する。
function reviewCompanion(args, workspace) {
  if (process.platform === "win32" || !["review", "adversarial-review"].includes(args[0])) {
    return companion(args, workspace);
  }
  for (const gitArgs of [["switch", "-c", "review-fixture"], ["add", "auth.js"], ["commit", "-m", "レビュー対象"]]) {
    const result = run("git", gitArgs, { cwd: workspace.repo, env: workspace.env });
    assert.equal(result.status, 0, result.stderr);
  }
  return companion([args[0], "--base", "main", ...args.slice(1)], workspace);
}

// 失敗条件: 会話言語とfocusの不一致、Intl外の正当なBCP47、壊れたタグ、余分なJSON項目。
for (const command of ["review", "adversarial-review", "audit"]) {
  test(`BCP47 contract: ${command} preserves English focus with Japanese conversation language`, () => {
    const workspace = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
    const focus = '\n    "focus on retries"  --language en\n$HOME $(literal) `literal` and \'quotes\'  ';
    const result = reviewCompanion([command, "--language", "ja", "--", focus], workspace);
    assert.equal(result.status, 0, result.stderr);
    const prompt = workspace.fake.readState().prompts[0];
    assert.match(prompt, /BCP 47 tag "ja"/);
    assert.equal(/User focus: ([\s\S]*?)\r?\n<\/task>/.exec(prompt)?.[1], focus);
  });
}

test("legacy single argv review arguments retain automatic splitting", () => {
  const workspace = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
  const result = companion(["audit", '--language ja --wait "legacy focus"'], workspace);
  assert.equal(result.status, 0, result.stderr);
  const prompt = workspace.fake.readState().prompts[0];
  assert.match(prompt, /BCP 47 tag "ja"/);
  assert.equal(/User focus: ([\s\S]*?)\r?\n<\/task>/.exec(prompt)?.[1], "legacy focus");
});

for (const [tag, normalized] of [
  ["en-GB-oed", "en-gb-oed"], ["i-klingon", "i-klingon"],
  ["zh-min", "zh-min"], ["x-kagayoi", "x-kagayoi"],
  ["zh-cmn-Hans-CN", "zh-cmn-hans-cn"], ["ja-jp", "ja-JP"],
  ["en-u-ca-gregory-x-local", "en-u-ca-gregory-x-local"], ["en-a-example", "en-a-example"]
]) {
  test(`BCP47 contract: review accepts ${tag}`, () => {
    const workspace = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
    const result = reviewCompanion(["review", "--language", tag, "Inspect retries"], workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(workspace.fake.readState().prompts[0].includes(`BCP 47 tag "${normalized}"`));
  });
}

for (const tag of ["en--US", "x", "en-a-foo-a-bar", "en-1901-1901", 'en\" do something']) {
  test(`BCP47 contract: review rejects malformed tag ${JSON.stringify(tag)}`, () => {
    const workspace = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
    const result = reviewCompanion(["review", "--language", tag], workspace);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid BCP 47 language tag/);
    assert.equal(workspace.fake.readState(), null, "invalid language must be rejected before the agent starts");
  });
}

for (const location of ["top-level", "finding"]) {
  test(`review schema contract: rejects extra ${location} property in the direct result`, () => {
    const data = JSON.parse(REVIEW_JSON);
    if (location === "top-level") data.extra = "dummy";
    else data.findings[0].extra = "dummy";
    const workspace = setupWorkspace({ replies: [{ text: JSON.stringify(data) }] });
    const result = reviewCompanion(["review", "--json"], workspace);
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.parseError, /unexpected property/i);
    assert.equal(payload.result, null);
    assert.equal(payload.reviewText, JSON.stringify(data));
  });
}

test("setup reports a ready runtime and the detected model", () => {
  const { repo, env } = setupWorkspace({ replies: [{ text: "ok" }] });
  const result = companion(["setup", "--json"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.availability.available, true);
  assert.match(payload.availability.version, /grok 9\.9\.9 \(fake\)/);
  assert.equal(payload.authenticated, true);
  assert.equal(payload.method, "api-key");
});

test("setup reports not-authenticated instead of crashing", () => {
  const { repo, env } = setupWorkspace({ authError: true });
  const result = companion(["setup", "--json"], { repo, env });

  assert.equal(result.status, 1, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.authenticated, false);
  assert.equal(payload.reason, "not-authenticated");
  assert.match(payload.guidance, /grok login/);
  assert.match(payload.guidance, /XAI_API_KEY/);
});

test("review renders structured findings and asks for the reasoning model", () => {
  const { fake, repo, env } = setupWorkspace({
    availableModels: ["grok-fake-nonreasoning", "grok-4.7"],
    replies: [{ text: REVIEW_JSON, tools: ["read_file"], thoughts: ["Looking", " at", " the", " diff."] }]
  });

  if (process.platform !== "win32") {
    const config = run("git", ["config", "core.filemode", "false"], { cwd: repo, env });
    assert.equal(config.status, 0, config.stderr);
    const unsupported = companion(["review", "--scope", "working-tree"], { repo, env });
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /Review incomplete: cannot safely read the working tree snapshot/i);
    assert.equal(fake.readState()?.prompts?.length ?? 0, 0);
    assert.doesNotMatch(unsupported.stdout, /Verdict: approve/i);
  }

  const result = reviewCompanion(["review", "--wait"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /# Grok Review/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /\[high\] Unvalidated input \(auth\.js:2\)/);
  assert.match(result.stdout, /Parameterize the query\./);

  // API キー認証時の既定は非推論モデルなので、明示的に差し替えていること。
  const state = fake.readState();
  assert.deepEqual(state.models, ["grok-4.7"]);
});

test("review joins streamed thought chunks into readable sentences", () => {
  // 思考ストリームは診断目的でパース失敗時にだけ描画されるので、失敗経路で確認する。
  const { repo, env } = setupWorkspace({
    replies: [
      { text: "not json at all", thoughts: ["Check", "ing ", "the ", "diff ", "care", "fully."] },
      { text: "still not json" }
    ]
  });

  const result = reviewCompanion(["review", "--wait"], { repo, env });
  assert.match(result.stdout, /Checking the diff carefully\./);
  // 断片が 1 行ずつに分解されていないこと。
  assert.doesNotMatch(result.stdout, /^- Check$/m);
});

test("review omits the thought stream when the structured result parsed", () => {
  // 思考ストリームは応答言語指定が効かず英語のまま出るので、成功時は出さない。
  const { repo, env } = setupWorkspace({
    replies: [{ text: REVIEW_JSON, thoughts: ["Let me dig deeper into the diff."] }]
  });

  const result = reviewCompanion(["review", "--wait"], { repo, env });
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.doesNotMatch(result.stdout, /^Reasoning:$/m);
  assert.doesNotMatch(result.stdout, /Let me dig deeper/);
});

test("review asks Grok to re-emit when the first reply is not valid JSON", () => {
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: 'Here you go: {"verdict":"approve","summary":"broken " quote"}' }, { text: REVIEW_JSON }]
  });

  const result = reviewCompanion(["review", "--wait"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /Verdict: needs-attention/);

  const state = fake.readState();
  assert.equal(state.prompts.length, 2, "expected one repair round-trip");
  assert.match(state.prompts[1], /could not be parsed as JSON/);
});

test("review surfaces a parse failure when the repair round also fails", () => {
  const { repo, env } = setupWorkspace({
    replies: [{ text: "not json at all" }, { text: "still not json" }]
  });

  const result = reviewCompanion(["review", "--wait"], { repo, env });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /did not return valid structured JSON|unexpected review shape/i);
  assert.match(result.stdout, /Raw final message:/);
  assert.match(result.stdout, /still not json/);
  assert.doesNotMatch(result.stdout, /not json at all/);
});

for (const replies of [[{ text: "" }], [{ text: "not json" }, { text: "" }]]) {
  test(`review fails when ${replies.length === 1 ? "the initial" : "the repair"} response is empty`, () => {
    const workspace = setupWorkspace({ replies });
    const result = reviewCompanion(["review", "--json"], workspace);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.result, null);
    assert.match(payload.parseError, /did not return a final structured message/i);
  });
}

const APPROVE_JSON = JSON.stringify({
  verdict: "approve",
  summary: "No material findings.",
  findings: [],
  next_steps: []
});

const INCOMPLETE_JSON = JSON.stringify({
  verdict: "incomplete",
  summary: "A required repository read could not be completed.",
  findings: [],
  next_steps: ["Retry the review with repository read access."]
});

for (const command of ["review", "audit", "adversarial-review"]) {
  test(`${command} preserves the latest malformed repair and completion state`, () => {
    const latestText = `${REVIEW_JSON}\n}`;
    const workspace = setupWorkspace({
      replies: [
        { text: "Starting the audit.", stopReason: "end_turn" },
        { text: latestText, stopReason: "end_turn" }
      ]
    });
    const result = reviewCompanion([command, "--json"], workspace);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "completed");
    assert.equal(payload.stopReason, "end_turn");
    assert.equal(payload.reviewText, latestText);
    assert.ok(payload.parseError);
    assert.equal(payload.result, null);
    assert.equal(workspace.fake.readState().prompts.length, 2);
  });
}

for (const command of ["review", "audit", "adversarial-review"]) {
  test(`${command} reports a denied, cancelled turn without repairing its progress text`, () => {
    const workspace = setupWorkspace({
      replies: [
        {
          requestPermissionFor: {
            title: "Extract source-info hashes from snapshot",
            rawInput: { command: `python -c "import json; d=json.load(open('evidence.json'));\n[print(x['path'], x['sha256']) for x in d]"` }
          },
          onDenied: { text: "Review in progress.", stopReason: "cancelled" }
        },
        { text: APPROVE_JSON }
      ]
    });

    const result = reviewCompanion([command, "--json"], workspace);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "cancelled");
    assert.equal(payload.stopReason, "cancelled");
    assert.equal(payload.result, null);
    assert.equal(payload.reviewText, "Review in progress.");
    assert.match(payload.permissionDenials.join("\n"), /unsupported shell control/i);
    const prompts = workspace.fake.readState().prompts;
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Do not run Python.*Node\.js, Bun/);
    assert.match(prompts[0], /Read JSON and verification evidence with read_file/);
    assert.match(prompts[0], /For multiline files, read_file offset\/limit select lines; they cannot split a single long line\. If you cannot fully inspect the required content, report that evidence as unverified\./);
    assert.match(prompts[0], /permission denial can terminate the entire Grok turn/);
  });
}

for (const stopReason of ["cancelled", "refusal", "max_tokens", "max_turn_requests", "unknown_reason"]) {
  test(`review never approves structured output from an unfinished ${stopReason} turn`, () => {
    const workspace = setupWorkspace({ replies: [{ text: APPROVE_JSON, stopReason }] });
    const result = reviewCompanion(["review", "--json"], workspace);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.notEqual(payload.status, "completed");
    assert.equal(payload.stopReason, stopReason);
    assert.equal(payload.result.verdict, "incomplete");
    assert.equal(payload.reviewText, APPROVE_JSON);
    assert.equal(workspace.fake.readState().prompts.length, 1);

  });
}

test("review preserves an unknown reason from the latest repair without confirming its stop", () => {
  const workspace = setupWorkspace({
    replies: [{ text: "not json" }, { text: APPROVE_JSON, stopReason: "unknown_reason" }]
  });
  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.notEqual(payload.status, "completed");
  assert.equal(payload.stopReason, "unknown_reason");
  assert.equal(payload.result.verdict, "incomplete");
  assert.equal(payload.reviewText, APPROVE_JSON);
  assert.equal(workspace.fake.readState().prompts.length, 2);
  assert.equal(payload.turnStopUnconfirmed, true);
});

test("review never approves a valid JSON repair from a cancelled turn", () => {
  const workspace = setupWorkspace({
    replies: [{ text: "not json" }, { text: APPROVE_JSON, stopReason: "cancelled" }]
  });
  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.result.verdict, "incomplete");
  assert.equal(payload.reviewText, APPROVE_JSON);
  assert.equal(workspace.fake.readState().prompts.length, 2);
});

for (const invalidJson of ["null", "false", "0", '""']) {
  test(`review rejects the invalid top-level JSON value ${invalidJson}`, () => {
    const workspace = setupWorkspace({ replies: [{ text: invalidJson }] });
    const result = reviewCompanion(["review", "--json"], workspace);
    assert.equal(result.status, 1);
    assert.ok(result.stdout.trim(), `Expected JSON output; stderr: ${result.stderr}; spawn error: ${result.error?.message ?? "none"}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result, null);
    assert.match(payload.parseError, /top-level JSON object/i);
    assert.equal(payload.reviewText, invalidJson);
  });
}

test("review does not expose an invalid partial approval as a structured result", () => {
  const partial = JSON.stringify({ verdict: "approve", summary: "Partial review" });
  const workspace = setupWorkspace({ replies: [{ text: partial, stopReason: "cancelled" }] });
  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, null);
  assert.equal(payload.reviewText, partial);
  assert.match(payload.parseError, /findings/i);
});

for (const text of ["", "partial review", APPROVE_JSON]) {
  test(`review preserves ACP failures with ${text ? "partial" : "no"} text (${text.length})`, () => {
    const workspace = setupWorkspace({ replies: [{ text, rpcError: "Review connection failed" }] });
    const result = reviewCompanion(["review", "--json"], workspace);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "failed");
    assert.equal(payload.error?.message, "Review connection failed");
    assert.equal(payload.reviewText, text);
    assert.notEqual(payload.result?.verdict, "approve");
  });
}

test("review preserves an empty cancelled repair instead of the initial reply", () => {
  const workspace = setupWorkspace({
    replies: [{ text: "Initial malformed reply" }, { text: "", stopReason: "cancelled" }]
  });
  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.reviewText, "");
  assert.equal(payload.result, null);
  assert.doesNotMatch(payload.parseError, /Initial malformed reply/);
});

test("review denies write-capable shell commands but allows read-only ones", () => {
  const denied = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Execute `rm -rf build`", rawInput: { command: "rm -rf build" } },
        text: REVIEW_JSON,
        onDenied: { text: '{"verdict":"approve","summary":"blocked","findings":[],"next_steps":[]}' }
      }
    ]
  });
  const deniedResult = reviewCompanion(["review", "--wait"], denied);
  assert.equal(deniedResult.status, 1);
  assert.match(deniedResult.stdout, /Verdict: incomplete/);
  assert.match(deniedResult.stdout, /rm -rf build/);
  assert.match(deniedResult.stdout, /must not be treated as approval/i);

  const allowed = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Execute safe Git diff", rawInput: { command: "git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c log.showSignature=false -c format.pretty=medium -c log.diffMerges=off -c diff.submodule=short diff --no-ext-diff --no-textconv --cached -- auth.js" } },
        text: REVIEW_JSON,
        onDenied: { text: '{"verdict":"approve","summary":"blocked","findings":[],"next_steps":[]}' }
      }
    ]
  });
  const allowedResult = reviewCompanion(["review", "--wait"], allowed);
  assert.equal(allowedResult.status, 0);
  assert.match(allowedResult.stdout, /Verdict: needs-attention/);
});

test("audit permits guided date-filtered history through the ACP permission path", () => {
  const command = 'git --no-pager --no-optional-locks --no-lazy-fetch -c core.fsmonitor=false -c log.showSignature=false -c format.pretty=medium -c log.diffMerges=off -c diff.submodule=short log --no-ext-diff --no-textconv --since="2026-09-28" --oneline';
  const workspace = setupWorkspace({ replies: [{
    requestPermissionFor: { title: "Read recent Git history", rawInput: { command } },
    text: APPROVE_JSON,
    onDenied: { text: APPROVE_JSON }
  }] });
  const result = companion(["audit", "--json", "review the last month of commits"], workspace);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.permissionDenials, []);
  assert.equal(payload.result.verdict, "approve");
  const prompt = workspace.fake.readState().prompts[0];
  assert.match(prompt, /--since=YYYY-MM-DD/);
  assert.match(prompt, /--since=2026-09-28 --oneline/);
});

test("review marks a denied subagent request as incomplete even when Grok returns approve", () => {
  const workspace = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Delegate to subagent", rawInput: { agent: "explorer" } },
        text: REVIEW_JSON,
        onDenied: { text: APPROVE_JSON }
      }
    ]
  });

  const result = companion(["audit", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "incomplete");
  assert.equal(payload.reviewText, APPROVE_JSON);
  assert.match(payload.permissionDenials.join("\n"), /Delegate to subagent/);
});

test("review keeps permission denials across JSON repair and cannot repair into approve", () => {
  const workspace = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Delegate to subagent", rawInput: { agent: "explorer" } },
        text: REVIEW_JSON,
        onDenied: { text: "not json" }
      },
      { text: APPROVE_JSON }
    ]
  });

  const result = companion(["audit", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "incomplete");
  assert.equal(payload.reviewText, APPROVE_JSON);
  assert.match(payload.permissionDenials.join("\n"), /Delegate to subagent/);
  assert.equal(workspace.fake.readState().prompts.length, 2);
});

test("review rejects a read-only permission request when allow_once is unavailable", () => {
  const workspace = setupWorkspace({
    replies: [
      {
        requestPermissionFor: {
          title: "Execute `git diff auth.js`",
          rawInput: { command: "git diff auth.js" },
          options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }]
        },
        text: REVIEW_JSON,
        onDenied: { text: APPROVE_JSON }
      }
    ]
  });

  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "incomplete");
  assert.match(payload.permissionDenials.join("\n"), /no one-time read-only permission option|git diff/i);
});

test("review treats an explicit incomplete verdict as a failed review result", () => {
  const workspace = setupWorkspace({ replies: [{ text: INCOMPLETE_JSON }] });

  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "incomplete");
  assert.deepEqual(payload.permissionDenials, []);
  assert.equal(payload.status, "completed");
  assert.equal(payload.stopReason, "end_turn");
});

test("review still completes for an approve verdict without permission denials", () => {
  const workspace = setupWorkspace({ replies: [{ text: APPROVE_JSON }] });

  const result = reviewCompanion(["review", "--json"], workspace);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "approve");
  assert.deepEqual(payload.permissionDenials, []);
});

for (const phase of ["initialize", "session/new"] as const) {
  for (const command of ["review", "task", "setup"]) {
    test(`${command} denies and records writes requested during ${phase}`, () => {
      const workspace = setupWorkspace({ earlyWritePhase: phase, replies: [{ text: APPROVE_JSON }] });
      const args = command === "task" ? [command, "--json", "inspect"] : [command, "--json"];
      const result = reviewCompanion(args, workspace);
      assert.equal(result.status, 1, result.stderr);
      const state = workspace.fake.readState();
      assert.equal(state.earlyRequests.length, 2);
      assert.notEqual(state.earlyRequests[0].result?.outcome?.optionId, "allow");
      assert.equal(state.earlyRequests[1].error?.code, -32601);
      assert.equal(fs.existsSync(path.join(workspace.repo, "early-write.txt")), false);
      const payload = JSON.parse(result.stdout);
      if (command === "setup") {
        assert.equal(payload.authenticated, false);
        assert.equal(payload.reason, "check-failed");
        assert.match(payload.detail, /ACP file write request was denied/);
      } else {
        assert.equal(payload.permissionDenials.length, 2);
        assert.match(payload.permissionDenials.join(" "), /ACP file write request was denied/);
        assert.equal(payload.stopReason, "end_turn");
        if (command === "review") assert.equal(payload.result.verdict, "incomplete");
      }
    });
  }
}

test("review rejects an unsolicited ACP file write", () => {
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: REVIEW_JSON, requestClientFileWrite: { path: "unexpected.txt", content: "written" } }]
  });
  const result = reviewCompanion(["review", "--json"], { repo, env });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(path.join(repo, "unexpected.txt")), false);
  assert.equal(fake.readState().clientWriteResponse?.code, -32601);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "incomplete");
  assert.match(payload.permissionDenials.join(" "), /ACP file write request was denied/);
});

test("adversarial review uses its own prompt template", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  const result = reviewCompanion(["adversarial-review", "--wait", "focus on retries"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /# Grok Adversarial Review/);

  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /adversarial software review/i);
  assert.match(prompt, /focus on retries/);
});

test("review passes focus text through to the standard review prompt", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  reviewCompanion(["review", "--wait", "focus on the retry logic"], { repo, env });

  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /focus on the retry logic/);
  assert.match(prompt, /read-only review/i);
  assert.match(prompt, /prefer.*file.reading tools/i);
  assert.match(prompt, /PowerShell.*script blocks/i);
  assert.doesNotMatch(prompt, /Do not modify files, run commands, or write anything to disk/i);
});

test("review writes findings in the language requested via --language", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  reviewCompanion(["review", "--wait", "--language", "ja", "リトライ処理を重点的に"], { repo, env });

  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /BCP 47 tag "ja"/);
  assert.match(prompt, /リトライ処理を重点的に/);
});

test("review falls back to the focus language, then English, when --language is absent", () => {
  const withFocus = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
  const focus = " \nfocus on retries\n ";
  reviewCompanion(["review", "--wait", "--", focus], withFocus);
  const focusedPrompt = withFocus.fake.readState().prompts[0];
  assert.match(focusedPrompt, /same language as the user focus/);
  assert.equal(/User focus: ([\s\S]*?)\r?\n<\/task>/.exec(focusedPrompt)?.[1], focus);

  const bare = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });
  reviewCompanion(["review", "--wait"], bare);
  const prompt = bare.fake.readState().prompts[0];
  assert.match(prompt, /in English\./);
  assert.doesNotMatch(prompt, /BCP 47 tag/);
});

test("audit uses the repository-audit template and skips the diff", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  const result = companion(["audit", "--wait", "focus on auth"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /# Grok Audit/);
  assert.match(result.stdout, /Verdict: needs-attention/);

  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /full-repository audit/i);
  assert.match(prompt, /ignore any uncommitted diff/i);
  assert.match(prompt, /focus on auth/);
  assert.match(prompt, /Weight the user's focus area heavily[\s\S]*still report any other material issue/i);
  assert.match(prompt, /## Tracked Files/);
  // setupWorkspace は auth.js を書き換えて working tree を汚しているが、
  // 監査プロンプトにその差分が混入しないこと。
  assert.doesNotMatch(prompt, /Unstaged Diff/);
  assert.doesNotMatch(prompt, /export const a = 2;/);
});

for (const focus of [undefined, " \n  "]) {
test(`audit applies a risk-directed deep investigation when focus is ${focus === undefined ? "omitted" : "whitespace only"}`, () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  const result = companion(["audit", "--json", ...(focus === undefined ? [] : ["--", focus])], { repo, env });

  assert.equal(result.status, 0, result.stderr);
  const prompt = fake.readState().prompts[0];
  assert.match(prompt, /highest-risk execution paths/i);
  assert.match(prompt, /concrete callers and consumers/i);
  assert.match(prompt, /state transitions and invariants, trust and persistence boundaries/i);
  assert.match(prompt, /failure and cleanup behavior, retries and timeouts, concurrency and ordering/i);
  assert.match(prompt, /relevant tests or documented contracts/i);
  assert.match(prompt, /Perform all review perspectives yourself in this session/i);
  assert.match(prompt, /do not call spawn_subagent/i);
  assert.match(prompt, /<depth_gate>/);
  assert.doesNotMatch(prompt, /No extra focus provided\./);
  assert.match(prompt, /in English\./);
  assert.doesNotMatch(prompt, /same language as the user focus/);
});
}

test("JSON audit keeps progress silent and returns its direct review result", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  const result = companion(["audit", "--json"], { repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "completed");
  assert.equal(payload.stopReason, "end_turn");
  assert.equal(payload.reviewText, REVIEW_JSON);
  assert.equal(payload.result.verdict, "needs-attention");
  assert.equal(fake.readState().prompts.length, 1);
});

test("review and task commands reject background execution", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: REVIEW_JSON }] });

  for (const args of [
    ["audit", "--background", "focus on auth"],
    ["task", "--background", "investigate auth"]
  ]) {
    const result = companion(args, { repo, env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--background.*no longer supported/i);
  }

  assert.equal(fake.readState(), null, "background rejection must happen before starting Grok");
});

test("task accepts legacy --wait as a foreground no-op", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: "done" }] });

  const result = companion(["task", "--wait", "investigate auth"], { repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(fake.readState().prompts[0], /investigate auth/);
  assert.doesNotMatch(fake.readState().prompts[0], /--wait/);
});

test("removed job controls and task resumption reject without reading legacy state", () => {
  const workspace = setupWorkspace({ replies: [{ text: "unexpected" }] });
  const legacy = path.join(workspace.env.CLAUDE_PLUGIN_DATA, "state.json");
  fs.writeFileSync(legacy, "invalid legacy state");
  for (const args of [["status"], ["result"], ["cancel"], ["state-lock", "migrate"],
    ["task-resume-candidate"], ["task", "--resume", "continue"], ["task", "--resume-last"],
    ["task", "--stop-gate", "review"]]) {
    const result = companion(args, workspace);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /no longer supported/i);
    assert.equal(fs.readFileSync(legacy, "utf8"), "invalid legacy state");
    assert.equal(workspace.fake.readState(), null);
  }
});

for (const mode of ["split stdin", "empty stdin", "positional priority", "prompt file priority"]) {
  test(`task reads piped input and preserves prompt priority: ${mode}`, { timeout: 45000 }, async () => {
    const { fake, repo, env } = setupWorkspace({ replies: [{ text: "done" }] });
    const piped = "日本語🌸の依頼";
    const positional = "positional request";
    const filePrompt = "prompt file request";
    const promptFile = path.join(repo, "prompt.txt");
    if (mode === "prompt file priority") fs.writeFileSync(promptFile, filePrompt, "utf8");
    const args = [SCRIPT, "task", "--json", "--fresh"];
    if (mode === "prompt file priority") args.push("--prompt-file", promptFile);
    if (mode === "positional priority" || mode === "prompt file priority") args.push(positional);
    const child = spawn(process.execPath, runtimeArgs(env, args), { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    if (trackedPosix) recordChildOwner(runtimeFixtures.find(f => f.repo === repo), child);
    let stdout = "", stderr = "", inputError;
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") inputError = error; });
    const closed = new Promise<{ code: number; signal: NodeJS.Signals }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let timer;
    try {
      if (mode === "split stdin") {
        const bytes = Buffer.from(piped, "utf8");
        // 3-byte と 4-byte UTF-8 のそれぞれ途中で区切り、EOF より前には task を開始しない。
        const emoji = bytes.indexOf(Buffer.from("🌸"));
        await new Promise(resolve => setTimeout(resolve, 300));
        for (const chunk of [bytes.subarray(0, 1), bytes.subarray(1, emoji + 2), bytes.subarray(emoji + 2)]) {
          child.stdin.write(chunk);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(child.exitCode, null, "task must wait for stdin EOF");
        assert.equal(fake.readState()?.prompts?.length ?? 0, 0, "prompt must not be sent before EOF");
        child.stdin.end();
      } else child.stdin.end(mode === "empty stdin" ? "" : piped);
      const outcome = await Promise.race([closed, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("task did not exit after stdin EOF")), 30000);
      })]);
      assert.equal(inputError, undefined);
      if (mode === "empty stdin") {
        assert.equal(outcome.code, 1, stderr);
        assert.match(stderr, /A prompt is required/i);
        assert.equal(fake.readState()?.prompts?.length ?? 0, 0);
      } else {
        assert.equal(outcome.code, 0, `signal=${outcome.signal} stdout=${stdout} stderr=${stderr}`);
        const expected = mode === "split stdin" ? piped : mode === "positional priority" ? positional : filePrompt;
        assert.deepEqual(fake.readState().prompts, [expected], "exactly one complete prompt must reach the fake agent");
      }
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  });
}

test("task rejects an omitted rescue request before starting Grok", () => {
  const workspace = setupWorkspace({ replies: [{ text: "should not run" }] });

  const result = companion(["task"], workspace);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /A prompt is required/i);
  assert.equal(workspace.fake.readState(), null);

});

test("schema-invalid review JSON fails in the direct result", () => {
  const malformedShape = JSON.stringify({
    verdict: "approve",
    summary: "Looks fine.",
    findings: [{ severity: "urgent", title: "Bad enum" }],
    next_steps: []
  });
  const { repo, env } = setupWorkspace({ replies: [{ text: malformedShape }] });

  const result = reviewCompanion(["review", "--json"], { repo, env });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.parseError);
  assert.equal(payload.result, null);
});

test("task without --write denies write permission requests", () => {
  const { repo, env } = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Write `notes.txt`", rawInput: { command: "echo hi > notes.txt" } },
        text: "wrote the file",
        onDenied: { text: "permission denied" }
      }
    ]
  });

  const result = companion(["task", "add a note"], { repo, env });

  assert.equal(result.status, 1, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /permission denied/);
});

test("read-only rescue permits built-in WebFetch but denies ambiguous or write-capable requests", { timeout: 45000 }, () => {
  // 実障害と同じ ACP 要求を再生し、未知ツール・追加引数・非 HTTP URL の過剰許可も検出する。
  const url = "https://raw.githubusercontent.com/ip7z/7zip/26.03/C/LzmaEnc.c";
  const fetchCall = { title: `Fetch: ${url}`, kind: "fetch", rawInput: { variant: "WebFetch", url } };
  const cases = [
    { name: "builtin", call: fetchCall, allowed: true },
    { name: "http", call: { ...fetchCall, rawInput: { variant: "WebFetch", url: "http://example.com/" } }, allowed: true },
    { name: "title-only", call: { title: fetchCall.title, rawInput: fetchCall.rawInput } },
    { name: "other-variant", call: { ...fetchCall, rawInput: { variant: "Upload", url } } },
    { name: "post", call: { ...fetchCall, rawInput: { ...fetchCall.rawInput, method: "POST" } } },
    { name: "output-file", call: { ...fetchCall, rawInput: { ...fetchCall.rawInput, output: "notes.txt" } } },
    { name: "command", call: { ...fetchCall, rawInput: { ...fetchCall.rawInput, command: "echo hi > notes.txt" } } },
    { name: "file-url", call: { ...fetchCall, rawInput: { variant: "WebFetch", url: "file:///secret" } } },
    { name: "invalid-url", call: { ...fetchCall, rawInput: { variant: "WebFetch", url: "not a URL" } } },
    { name: "credentials", call: { ...fetchCall, rawInput: { variant: "WebFetch", url: "https://user:password@example.com/" } } },
    { name: "no-once-option", call: { ...fetchCall, options: [{ optionId: "always", kind: "allow_always" }] } }
  ];
  for (const scenario of cases) {
    const workspace = setupWorkspace({ replies: [{
      requestPermissionFor: scenario.call,
      text: "FETCH_OK",
      onDenied: { text: "FETCH_DENIED", stopReason: "cancelled" }
    }] });
    const result = companion(["task", "--json", "--fresh", "Read the public source without changing files."], workspace);
    const payload = JSON.parse(result.stdout);
    assert.equal(result.status, scenario.allowed ? 0 : 1, `${scenario.name}: ${result.stderr}`);
    assert.equal(payload.finalMessage, scenario.allowed ? "FETCH_OK" : "FETCH_DENIED", scenario.name);
    assert.equal(payload.permissionDenials.length, scenario.allowed ? 0 : 1, scenario.name);
    assert.equal(fs.existsSync(path.join(workspace.repo, "notes.txt")), false);
  }
});

test("read-only task confines Test-Path to its repository", () => {
  for (const scenario of ["inside", "outside", "linked-outside", "home-path", "ambiguous-segment", "alternate-stream", "command-suffix", "chained-command"]) {
    const workspace = setupWorkspace({});
    const outsideDir = workspace.fake.binDir;
    const linkPath = path.join(workspace.repo, "linked-outside");
    if (scenario === "linked-outside") {
      fs.symlinkSync(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
      workspace.registerLink(linkPath);
    }
    const target = scenario === "outside"
      ? path.join(outsideDir, "candidate")
      : scenario === "linked-outside"
        ? path.join(linkPath, "candidate")
        : scenario === "ambiguous-segment"
          ? path.join(workspace.repo, ".. ", "candidate")
          : scenario === "alternate-stream"
            ? `${path.join(workspace.repo, "auth.js")}:stream`
        : path.join(workspace.repo, "build", "candidate");
    const command = `${scenario === "command-suffix" ? "Test-Path.cmd" : "Test-Path"} -LiteralPath "${scenario === "home-path" ? "~/secret" : target}"${scenario === "chained-command" ? " && git checkout ." : ""}`;
    fs.writeFileSync(workspace.env.FAKE_GROK_SCENARIO, JSON.stringify({
      replies: [{
        requestPermissionFor: { title: command, rawInput: { command } },
        text: "permission allowed",
        onDenied: { text: "permission denied" }
      }]
    }), "utf8");

    const result = companion(["task", "--json", "check build directory"], workspace);
    const payload = JSON.parse(result.stdout);
    assert.equal(result.status, scenario === "inside" ? 0 : 1, result.stderr);
    assert.match(payload.finalMessage, scenario === "inside" ? /permission allowed/ : /permission denied/);
    assert.equal(payload.permissionDenials.length, scenario === "inside" ? 0 : 1);
  }
});

test("task with --write allows write permission requests", () => {
  const { repo, env } = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Write `notes.txt`", rawInput: { command: "echo hi > notes.txt" } },
        text: "wrote the file",
        onDenied: { text: "permission denied" }
      }
    ]
  });

  const result = companion(["task", "--write", "add a note"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /wrote the file/);
});

test("task does not treat --write inside the prompt text as a flag", () => {
  const { repo, env } = setupWorkspace({
    replies: [
      {
        requestPermissionFor: { title: "Write `notes.txt`", rawInput: { command: "echo hi > notes.txt" } },
        text: "wrote the file",
        onDenied: { text: "permission denied" }
      }
    ]
  });

  const result = companion(["task", "explain what the --write flag does"], { repo, env });

  assert.equal(result.status, 1, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.match(result.stdout, /permission denied/);
});

test("task forwards the requested model to the session", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: "done" }] });

  const result = companion(["task", "--model", "grok-4.5", "do a thing"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.deepEqual(fake.readState().models, ["grok-4.5"]);
});

test("task asks for grok-4.7 when the model is omitted", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: "done" }] });

  const result = companion(["task", "do a thing"], { repo, env });

  assert.equal(result.status, 0, `stdout:
${result.stdout}
stderr:
${result.stderr}`);
  assert.deepEqual(fake.readState().models, ["grok-4.7"]);
});

test("task resolves the latest alias to grok-4.7", () => {
  const { fake, repo, env } = setupWorkspace({ replies: [{ text: "done" }] });

  const result = companion(["task", "--model", "latest", "do a thing"], { repo, env });

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(fake.readState().models, ["grok-4.7"]);
});

const THOUGHT_LEVEL_OPTION = {
  id: "thought-level",
  name: "Thought level",
  category: "thought_level",
  type: "select",
  currentValue: "high",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" }
  ]
};

test("task leaves reasoning effort alone when --effort is absent", () => {
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: "done" }],
    configOptions: [THOUGHT_LEVEL_OPTION]
  });

  const result = companion(["task", "do a thing"], { repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fake.readState().configs, []);
});

test("task applies --effort through session/set_config_option", () => {
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: "done" }],
    configOptions: [THOUGHT_LEVEL_OPTION]
  });

  const result = companion(["task", "--effort", "low", "do a thing"], { repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fake.readState().configs, [{ configId: "thought-level", value: "low" }]);
});

test("task falls back to set_config_option when session/set_model is gone", () => {
  const { fake, repo, env } = setupWorkspace({
    replies: [{ text: "done" }],
    setModelUnsupported: true,
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "grok-fake-nonreasoning",
        options: [{ value: "grok-fake-nonreasoning", name: "fast" }, { value: "grok-4.5", name: "4.5" }]
      }
    ]
  });

  const result = companion(["task", "--model", "grok-4.5", "do a thing"], { repo, env });

  assert.equal(result.status, 0, result.stderr);
  const state = fake.readState();
  assert.deepEqual(state.models, []);
  assert.deepEqual(state.configs, [{ configId: "model", value: "grok-4.5" }]);
});
