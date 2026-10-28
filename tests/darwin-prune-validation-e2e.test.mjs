import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { migrateStateLock, resolveStateDir, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { pruneDarwinHistory, recoverDarwinPrune } from "../plugins/grok/scripts/lib/darwin-prune-transaction.mjs";
import { sweepDarwinWorkerLeases } from "../plugins/grok/scripts/lib/darwin-lease-sweep.mjs";

// 故障条件: 統合前の WAL を真正 mutex capability から起動できる、
// caller が capability を偽造する、または別 job が対象 log を参照する。
const darwin = { skip: process.platform !== "darwin", timeout: 60000 };
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "grok-prune-validation-"));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(workspace); fs.mkdirSync(data);
  const children = [];
  const oldData = process.env.CLAUDE_PLUGIN_DATA, oldPluginData = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  t.after(async () => {
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
    if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldData;
    if (oldPluginData === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = oldPluginData;
    fs.rmSync(root, { recursive: true, force: true });
  });
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true });
  const stateDir = resolveStateDir(workspace);
  const epoch = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).epoch;
  return { workspace, stateDir, epoch, jobsDir: path.join(stateDir, "jobs"), children };
}

function fileEvidence(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = path.join(directory, entry.name), relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return [[relative, "directory"], ...fileEvidence(name, relative)];
    return entry.isFile() ? [[relative, fs.readFileSync(name).toString("base64")]] : [[relative, "other"]];
  });
}

async function certifiedHistory(f) {
  const logFile = path.join(f.jobsDir, "history-0.log");
  fs.mkdirSync(f.jobsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(logFile, "evidence", { mode: 0o600 });
  const ready = path.join(f.workspace, "history-ready"), release = path.join(f.workspace, "history-release");
  const child = fork(new URL("./fixtures/darwin-worker-lease-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  f.children.push({ child, closed });
  child.send({ job: { id: "history-0", workspaceRoot: f.workspace, jobClass: "review", title: "Review",
    sessionId: "prune-validation", grokPromptState: "not-sent", logFile }, delayClaim: true, gateReady: ready, gateRelease: release });
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(ready), "worker did not reach published reservation");
  const lease = JSON.parse(fs.readFileSync(ready, "utf8"));
  child.kill("SIGKILL");
  await closed;
  const ledgerPath = path.join(f.stateDir, "darwin-lease-ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  ledger.cursor = lease.slot;
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger), { mode: 0o600 });
  const fd = fs.openSync(ledgerPath, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  assert.equal(sweepDarwinWorkerLeases(f.workspace, { maxEntries: 1, timeoutMs: 5000 }).reclaimed, 1);
  assert.ok(fs.existsSync(path.join(f.jobsDir, "history-0.worker-stop-proof")));
}

test("prune rejects forged and expired state mutex capabilities", darwin, t => {
  const f = fixture(t);
  const stat = fs.lstatSync(f.stateDir, { bigint: true });
  const fake = { stateDir: f.stateDir, epoch: f.epoch, protocol: "posix-local-v4",
    directoryIdentity: { dev: String(stat.dev), ino: String(stat.ino) }, check() {} };
  const before = fileEvidence(f.stateDir);
  assert.throws(() => recoverDarwinPrune(fake));
  assert.throws(() => pruneDarwinHistory(fake));
  const poisoned = Object.defineProperty({}, "protocol", { get() { throw new Error("untrusted getter was evaluated"); } });
  assert.throws(() => recoverDarwinPrune(poisoned), /transaction is disabled pending integration/);
  assert.throws(() => pruneDarwinHistory(poisoned), /transaction is disabled pending integration/);
  assert.throws(() => recoverDarwinPrune({ ...fake, protocol: "posix-local-v3" }));
  assert.throws(() => pruneDarwinHistory({ ...fake, protocol: "posix-local-v3" }));
  assert.deepEqual(fileEvidence(f.stateDir), before);
  let expired, snapshotEvidence;
  withStateSnapshot(f.workspace, (_state, context) => {
    expired = context;
    assert.equal(context.protocol, "posix-local-v4");
    snapshotEvidence = fileEvidence(f.stateDir);
    assert.throws(() => recoverDarwinPrune({ ...context, check() {} }));
    assert.throws(() => pruneDarwinHistory({ ...context, check() {} }));
    assert.deepEqual(fileEvidence(f.stateDir), snapshotEvidence);
  });
  assert.throws(() => recoverDarwinPrune(expired));
  assert.throws(() => pruneDarwinHistory(expired));
  assert.deepEqual(fileEvidence(f.stateDir), snapshotEvidence);
});

test("pending integration rejects recovery even with a genuine v4 capability", darwin, t => {
  const f = fixture(t);
  let before;
  withStateSnapshot(f.workspace, (_state, context) => {
    assert.equal(context.protocol, "posix-local-v4");
    before = fileEvidence(f.stateDir);
    assert.throws(() => recoverDarwinPrune(context), /transaction is disabled pending integration/);
    assert.deepEqual(fileEvidence(f.stateDir), before);
  });
  assert.deepEqual(fileEvidence(f.stateDir), before);
});

test("pending integration rejects pruning with a genuine v4 capability", darwin, t => {
  const f = fixture(t);
  fs.mkdirSync(f.jobsDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(f.stateDir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  for (let i = 0; i <= 50; i += 1) {
    const job = { id: `history-${i}`, status: "completed", createdAt: "2099-01-01",
      updatedAt: `2099-${String(i).padStart(2, "0")}`, epoch: f.epoch, terminationPending: false,
      grokPromptState: "not-sent", pid: null, workerStopConfirmed: true, workerStopProof: "never-started",
      logFile: path.join(f.jobsDir, `history-${i}.log`) };
    fs.writeFileSync(path.join(f.jobsDir, `${job.id}.json`), JSON.stringify(job), { mode: 0o600 });
    fs.writeFileSync(job.logFile, "evidence", { mode: 0o600 });
    state.jobs.push(job);
  }
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  let before;
  withStateSnapshot(f.workspace, (_state, context) => {
    assert.equal(context.protocol, "posix-local-v4");
    before = fileEvidence(f.stateDir);
    assert.throws(() => pruneDarwinHistory(context), /transaction is disabled pending integration/);
    assert.deepEqual(fileEvidence(f.stateDir), before);
  });
  assert.deepEqual(fileEvidence(f.stateDir), before);
});

for (const reference of ["index", "detail", "case-alias", "orphan", "shared-lease"]) {
  test(`CLI retains certified history when reverse references contain ${reference}`, darwin, async t => {
    const f = fixture(t);
    await certifiedHistory(f);
    const history = Array.from({ length: 50 }, (_, i) => ({ id: `history-${i + 1}`, status: "completed", createdAt: "2099-01-01",
      updatedAt: `2099-${String(i + 1).padStart(2, "0")}`, epoch: f.epoch, terminationPending: false, grokPromptState: "not-sent",
      pid: null, workerStopConfirmed: true, workerStopProof: "never-started", logFile: path.join(f.jobsDir, `history-${i + 1}.log`) }));
    const targetLog = path.join(f.jobsDir, "history-0.log");
    const other = { id: "other", status: "running", createdAt: "2021-01-01", updatedAt: "2021-01-01", epoch: f.epoch };
    const indexed = { ...other }, stored = { ...other };
    if (reference === "index") indexed.logFile = targetLog;
    if (reference === "detail") stored.logFile = targetLog;
    if (reference === "shared-lease") {
      const proof = JSON.parse(fs.readFileSync(path.join(f.jobsDir, "history-0.worker-stop-proof"), "utf8"));
      indexed.workerLease = proof.lease;
      stored.workerLease = proof.lease;
    }
    for (const job of history) {
      fs.writeFileSync(path.join(f.jobsDir, `${job.id}.json`), JSON.stringify(job), { mode: 0o600 });
      fs.writeFileSync(job.logFile, "evidence", { mode: 0o600 });
    }
    fs.writeFileSync(path.join(f.jobsDir, "other.json"), JSON.stringify(stored), { mode: 0o600 });
    if (reference === "orphan") fs.writeFileSync(path.join(f.jobsDir, "unowned.json"), JSON.stringify({ id: "unowned" }), { mode: 0o600 });
    const stateFile = path.join(f.stateDir, "state.json");
    const before = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    before.jobs.push(...history, indexed);
    if (reference === "case-alias") before.jobs.push({ id: "HISTORY-0", status: "running", createdAt: "2021-01-01" });
    fs.writeFileSync(stateFile, JSON.stringify(before), { mode: 0o600 });
    const result = spawnSync(process.execPath, [cli, "setup", "--enable-review-gate", "--cwd", f.workspace, "--json"],
      { cwd: f.workspace, env: process.env, encoding: "utf8", timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(f.stateDir, "state.json"), "utf8"));
    assert.ok(state.jobs.some(job => job.id === "history-0"));
    assert.ok(fs.existsSync(path.join(f.jobsDir, "history-0.json")));
    assert.equal(fs.readFileSync(targetLog, "utf8"), "evidence");
    assert.ok(fs.existsSync(path.join(f.jobsDir, "history-0.worker-stop-proof")));
  });
}

test("CLI preserves a release claim without durable worker ownership evidence", darwin, t => {
  const f = fixture(t);
  fs.mkdirSync(f.jobsDir, { recursive: true, mode: 0o700 });
  const history = Array.from({ length: 51 }, (_, i) => ({ id: `history-${i}`, status: "completed", createdAt: "2020-01-01",
    updatedAt: `2020-${String(i + 1).padStart(2, "0")}`, epoch: f.epoch, terminationPending: false, grokPromptState: "not-sent",
    pid: null, workerStopConfirmed: true, workerStopProof: "never-started", logFile: path.join(f.jobsDir, `history-${i}.log`) }));
  Object.assign(history[0], { startedAt: "2020-01-01", processStartKey: null, grokPromptState: "terminal",
    workerStopProof: "darwin-lease-released", workerStopLeaseId: "6f594c37-70c5-44cc-9bac-5d2164d050ed", workerStopProcessStartKey: null });
  for (const job of history) {
    fs.writeFileSync(path.join(f.jobsDir, `${job.id}.json`), JSON.stringify(job), { mode: 0o600 });
    fs.writeFileSync(job.logFile, "evidence", { mode: 0o600 });
  }
  fs.writeFileSync(path.join(f.stateDir, "state.json"), JSON.stringify({ version: 1, jobs: history }), { mode: 0o600 });
  const result = spawnSync(process.execPath, [cli, "setup", "--enable-review-gate", "--cwd", f.workspace, "--json"],
    { cwd: f.workspace, env: process.env, encoding: "utf8", timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(f.stateDir, "state.json"), "utf8"));
  assert.ok(state.jobs.some(job => job.id === "history-0"));
  assert.ok(fs.existsSync(path.join(f.jobsDir, "history-0.json")));
  assert.equal(fs.readFileSync(history[0].logFile, "utf8"), "evidence");
});
