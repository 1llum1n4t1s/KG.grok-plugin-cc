import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { loadState, migrateStateLock, resolveStateDir, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { sweepDarwinWorkerLeases } from "../plugins/grok/scripts/lib/darwin-lease-sweep.mjs";
import { appendLogBlock, createProgressReporter } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { makeTempDir } from "./helpers.mjs";

// 故障条件: 旧 log の hardlink・symlink・緩い権限への追記、
// 新規空 log の生成失敗、通常の進捗・最終出力・キャンセルログの欠落。
const darwin = { skip: process.platform !== "darwin", timeout: 45000 };
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const flagsWorker = fileURLToPath(new URL("./fixtures/darwin-log-flags-worker.mjs", import.meta.url));

for (const flag of ["O_NOFOLLOW", "O_NONBLOCK"]) for (const value of ["missing", "zero"]) for (const existing of [true, false]) {
  test(`log rejects ${value} ${flag} before opening ${existing ? "existing" : "new"} file`, darwin, () => {
    const directory = fs.realpathSync(makeTempDir("grok-log-flags-"));
    const logFile = path.join(directory, "job.log");
    if (existing) fs.writeFileSync(logFile, "unchanged\n", { mode: 0o600 });
    const result = spawnSync(process.execPath, [flagsWorker, flag, value, logFile], { encoding: "utf8", timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.accepted, false, JSON.stringify(outcome));
    assert.equal(outcome.opens, 0, "log open must not run without both safety flags");
    if (existing) assert.equal(fs.readFileSync(logFile, "utf8"), "unchanged\n");
    else assert.equal(fs.existsSync(logFile), false);
  });
}

function fixture(t) {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  t.after(() => { for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  process.env.CLAUDE_PLUGIN_DATA = fs.realpathSync(makeTempDir("grok-log-state-"));
  delete process.env.PLUGIN_DATA;
  const workspace = fs.realpathSync(makeTempDir("grok-log-workspace-"));
  const stateDir = resolveStateDir(workspace), jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(jobsDir, "legacy-queued.log");
  const job = { id: "legacy-queued", status: "queued", createdAt: "2024-01-01T00:00:00.000Z",
    workspaceRoot: workspace, title: "Legacy", grokPromptState: "not-sent", logFile };
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ jobs: [job] }), { mode: 0o600 });
  fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), JSON.stringify(job), { mode: 0o600 });
  fs.writeFileSync(logFile, "legacy log\n", { mode: 0o600 });
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  return { workspace, jobsDir, logFile, job };
}

function fileIdentity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink, size: stat.size };
}

for (const kind of ["hardlink", "unsafe-mode", "write-only", "regular"]) test(`legacy cancel rejects unverified worker and preserves ${kind} log`, darwin, t => {
  const f = fixture(t);
  const external = path.join(f.workspace, "external");
  if (kind === "hardlink") fs.linkSync(f.logFile, external);
  if (kind === "unsafe-mode") fs.chmodSync(f.logFile, 0o644);
  if (kind === "write-only") fs.chmodSync(f.logFile, 0o200);
  const before = kind === "write-only" ? Buffer.from("legacy log\n") : fs.readFileSync(f.logFile);
  const identity = fileIdentity(f.logFile);
  const externalIdentity = kind === "hardlink" ? fileIdentity(external) : null;
  const stateFile = path.join(path.dirname(f.jobsDir), "state.json");
  const detailFile = path.join(f.jobsDir, f.job.id + ".json");
  const stateBefore = fs.readFileSync(stateFile), detailBefore = fs.readFileSync(detailFile);
  const result = spawnSync(process.execPath, [cli, "cancel", "--cwd", f.workspace, "--json", f.job.id], {
    env: process.env, encoding: "utf8", timeout: 30000
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /no verified current worker lease; cancellation remains pending/i);
  assert.equal(result.stdout, "");
  assert.deepEqual(fs.readFileSync(stateFile), stateBefore);
  assert.deepEqual(fs.readFileSync(detailFile), detailBefore);
  assert.deepEqual(fileIdentity(f.logFile), identity);
  if (kind === "hardlink") assert.deepEqual(fileIdentity(external), externalIdentity);
  if (kind === "write-only") fs.chmodSync(f.logFile, 0o600);
  assert.deepEqual(fs.readFileSync(f.logFile), before);
  if (kind === "hardlink") assert.deepEqual(fs.readFileSync(external), before);
});

test("legacy cancel preserves an external regular file named by both job records", darwin, t => {
  const f = fixture(t), external = path.join(f.workspace, "external.log");
  fs.writeFileSync(external, "external contents\n", { mode: 0o600 });
  const stateFile = path.join(path.dirname(f.jobsDir), "state.json");
  const detailFile = path.join(f.jobsDir, `${f.job.id}.json`);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const detail = JSON.parse(fs.readFileSync(detailFile, "utf8"));
  state.jobs[0].logFile = external;
  detail.logFile = external;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(detailFile, JSON.stringify(detail));
  const stateBefore = fs.readFileSync(stateFile), detailBefore = fs.readFileSync(detailFile);
  const externalBefore = fs.readFileSync(external), externalIdentity = fileIdentity(external);
  const localBefore = fs.readFileSync(f.logFile), localIdentity = fileIdentity(f.logFile);
  const result = spawnSync(process.execPath, [cli, "cancel", "--cwd", f.workspace, "--json", f.job.id], {
    env: process.env, encoding: "utf8", timeout: 30000
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /no verified current worker lease; cancellation remains pending/i);
  assert.equal(result.stdout, "");
  assert.deepEqual(fs.readFileSync(stateFile), stateBefore);
  assert.deepEqual(fs.readFileSync(detailFile), detailBefore);
  assert.deepEqual(fileIdentity(external), externalIdentity);
  assert.deepEqual(fs.readFileSync(external), externalBefore);
  assert.deepEqual(fileIdentity(f.logFile), localIdentity);
  assert.deepEqual(fs.readFileSync(f.logFile), localBefore);
});

for (const kind of ["hardlink", "symlink", "unsafe-mode", "write-only", "regular", "missing"]) test(`progress and final output protect ${kind} log`, darwin, t => {
  const f = fixture(t), target = path.join(f.workspace, "target");
  if (kind === "hardlink") fs.linkSync(f.logFile, target);
  if (kind === "symlink") {
    fs.writeFileSync(target, "external\n", { mode: 0o600 });
    fs.unlinkSync(f.logFile);
    fs.symlinkSync(target, f.logFile);
  }
  if (kind === "unsafe-mode") fs.chmodSync(f.logFile, 0o644);
  if (kind === "write-only") fs.chmodSync(f.logFile, 0o200);
  if (kind === "missing") fs.unlinkSync(f.logFile);
  const before = kind === "missing" ? null : kind === "write-only" ? Buffer.from("legacy log\n") : fs.readFileSync(f.logFile);
  const progress = createProgressReporter({ logFile: f.logFile });
  if (["hardlink", "symlink", "unsafe-mode", "write-only"].includes(kind)) {
    assert.throws(() => progress("progress"));
    assert.throws(() => appendLogBlock(f.logFile, "Final output", "result"));
    if (kind === "write-only") fs.chmodSync(f.logFile, 0o600);
    assert.deepEqual(fs.readFileSync(f.logFile), before);
    if (["hardlink", "symlink"].includes(kind)) assert.deepEqual(fs.readFileSync(target), before);
  } else {
    progress("progress");
    appendLogBlock(f.logFile, "Final output", "result");
    const contents = fs.readFileSync(f.logFile, "utf8");
    assert.match(contents, /progress/);
    assert.match(contents, /Final output\nresult/);
    assert.equal(fs.statSync(f.logFile).mode & 0o077, 0);
  }
});

for (const mode of ["normal", "missing-progress", "missing-final", "unwritable-final"]) test(`leased worker preserves log evidence: ${mode}`, darwin, async t => {
  const f = fixture(t);
  const job = { id: "leased-worker", workspaceRoot: f.workspace, title: "Review", jobClass: "review", grokPromptState: "not-sent" };
  const worker = fork(new URL("./fixtures/darwin-log-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const closed = new Promise(resolve => worker.once("close", resolve));
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    await closed;
  });
  worker.send({ job });
  const [ready] = await once(worker, "message");
  assert.equal(ready.type, "ready", JSON.stringify(ready));
  const before = fs.readFileSync(ready.logFile, "utf8");
  assert.match(before, /initial progress/);
  if (mode.startsWith("missing")) fs.renameSync(ready.logFile, path.join(f.workspace, "saved-log"));
  if (mode === "unwritable-final") fs.chmodSync(ready.logFile, 0o400);
  worker.send(mode === "missing-progress" ? "progress" : "finish");
  const [result] = await once(worker, "message");
  if (mode === "normal") {
    assert.equal(result.type, "completed", JSON.stringify(result));
    assert.match(fs.readFileSync(ready.logFile, "utf8"), /final result/);
  } else {
    assert.equal(result.type, "rejected", JSON.stringify(result));
    if (mode.startsWith("missing")) {
      assert.equal(fs.existsSync(ready.logFile), false);
      assert.equal(fs.readFileSync(path.join(f.workspace, "saved-log"), "utf8"), before);
    } else assert.equal(fs.readFileSync(ready.logFile, "utf8"), before);
    if (mode !== "missing-progress") {
      const stored = loadState(f.workspace).jobs.find(entry => entry.id === job.id);
      assert.equal(stored.status, "completed", "afterSave failure must not imply rollback");
    }
  }
});

test("cancel reports an omitted log when a released lease is swept after state commit", { ...darwin, timeout: 90000 }, async t => {
  const f = fixture(t);
  const job = { id: "sweep-cancel", workspaceRoot: f.workspace, title: "Review", jobClass: "review", grokPromptState: "not-sent" };
  const worker = fork(new URL("./fixtures/darwin-log-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const workerClosed = new Promise(resolve => worker.once("close", resolve));
  t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); await workerClosed; });
  worker.send({ job });
  const [ready] = await once(worker, "message");
  assert.equal(ready.type, "ready", JSON.stringify(ready));
  const gate = path.join(f.workspace, "cancel-gate");
  const env = { ...process.env, GROK_TEST_STATE_DIR: path.dirname(f.jobsDir), GROK_TEST_SWEEP_GATE: gate, GROK_TEST_SWEEP_JOB: job.id };
  const preload = fileURLToPath(new URL("./fixtures/darwin-cancel-sweep-gate.mjs", import.meta.url));
  const cancel = spawn(process.execPath, ["--import", preload, cli, "cancel", "--cwd", f.workspace, "--json", job.id], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  cancel.stdout.on("data", data => { stdout += data; });
  cancel.stderr.on("data", data => { stderr += data; });
  const cancelClosed = new Promise(resolve => cancel.once("close", resolve));
  t.after(async () => { if (cancel.exitCode === null && cancel.signalCode === null) cancel.kill("SIGKILL"); await cancelClosed; });
  const waitFor = async predicate => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`cancel sweep test gate timed out: ${stderr}`);
  };
  await waitFor(() => withStateSnapshot(f.workspace, state => state.jobs.find(entry => entry.id === job.id)?.status === "cancelled"));
  worker.send("finish");
  await workerClosed;
  await waitFor(() => fs.existsSync(gate));
  const before = withStateSnapshot(f.workspace, state => state.jobs.find(entry => entry.id === job.id));
  assert.ok(before.workerLease);
  // 走査 cursor だけを mutex 下で回収対象に合わせ、回収自体は実装を通す。
  withStateSnapshot(f.workspace, () => {
    const ledgerFile = path.join(path.dirname(f.jobsDir), "darwin-lease-ledger.json");
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    ledger.cursor = before.workerLease.slot;
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    const fd = fs.openSync(ledgerFile, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  });
  const sweep = sweepDarwinWorkerLeases(f.workspace, { maxEntries: 1, timeoutMs: 5000 });
  assert.equal(sweep.reclaimed, 1, JSON.stringify(sweep));
  assert.equal(withStateSnapshot(f.workspace, state => state.jobs.find(entry => entry.id === job.id).workerLease), null);
  fs.writeFileSync(`${gate}.release`, "release");
  await cancelClosed;
  assert.equal(cancel.exitCode, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "cancelled");
  assert.ok(result.logWarningCount > 0, "omitted cancellation log must be reported");
});
