import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadState, migrateStateLock, resolveJobFile, resolveStateDir, updateState, withStateSnapshot, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { sweepDarwinWorkerLeases, verifyPublishedDarwinLeaseRecords } from "../plugins/grok/scripts/lib/darwin-lease-sweep.mjs";
import { darwinLeaseDirectory } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { withAvailableDarwinLease } from "../plugins/grok/scripts/lib/darwin-worker-lease.mjs";
import { pruneDarwinHistory, recoverDarwinPrune } from "../plugins/grok/scripts/lib/darwin-prune-transaction.mjs";

const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));

async function waitForFile(file, child) {
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(file) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(file), "worker did not reach its reservation gate: " + file);
}

function findLedger(stateDir) {
  const pending = [stateDir], matches = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = path.join(directory, item.name);
      if (item.isDirectory()) pending.push(name);
      else if (item.isFile() && fs.statSync(name).size < 1024 * 1024) {
        try {
          const value = JSON.parse(fs.readFileSync(name, "utf8"));
          if (value?.protocol === "darwin-lease-ledger-v1") matches.push({ name, value });
        } catch { /* ledger 以外。 */ }
      }
    }
  }
  assert.equal(matches.length, 1);
  return matches[0];
}

function fileSnapshot(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, bytes: fs.readFileSync(file) };
}

test("macOS setup preserves all history and refuses unintegrated prune transactions", { skip: process.platform !== "darwin", timeout: 60000 }, async t => {
  const temp = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, "grok-prune-preserve-"));
  const rootIdentity = fs.lstatSync(root, { bigint: true });
  const workspace = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(workspace); fs.mkdirSync(data);
  const oldData = process.env.CLAUDE_PLUGIN_DATA, oldPluginData = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  assert.ok(path.isAbsolute(stateDir) && stateDir.startsWith(data + path.sep) && !fs.existsSync(stateDir));
  const children = [];
  let migrationStarted = false, migrationComplete = false, epoch, stateIdentity, workersVerified = true;
  t.after(async () => {
    try {
      for (const entry of children) {
        if (entry.child.exitCode === null && entry.child.signalCode === null) {
          workersVerified = false;
          entry.child.kill("SIGKILL");
        }
        await entry.closed;
      }
      assert.ok(workersVerified, "owned worker or CLI exit was not confirmed");
      if (migrationStarted) {
        assert.ok(migrationComplete && stateIdentity && epoch, "migration identity is unconfirmed");
        assert.equal(resolveStateDir(workspace), stateDir);
        const currentRoot = fs.lstatSync(root, { bigint: true }), currentState = fs.lstatSync(stateDir, { bigint: true });
        assert.ok(currentRoot.isDirectory() && !currentRoot.isSymbolicLink() && currentRoot.dev === rootIdentity.dev && currentRoot.ino === rootIdentity.ino);
        assert.ok(currentState.isDirectory() && !currentState.isSymbolicLink() && currentState.dev === stateIdentity.dev && currentState.ino === stateIdentity.ino);
        assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).epoch, epoch);
      }
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      t.diagnostic("Fixture retained because owned cleanup is unconfirmed: " + root);
      throw error;
    } finally {
      if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldData;
      if (oldPluginData === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = oldPluginData;
    }
  });
  migrationStarted = true;
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  stateIdentity = fs.lstatSync(stateDir, { bigint: true });
  epoch = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).epoch;
  assert.ok(epoch); migrationComplete = true;
  const jobsDir = path.join(stateDir, "jobs");

  async function stopQueuedWorker(id, logFile = null) {
    const job = { id, workspaceRoot: workspace, jobClass: "review", title: "Review", sessionId: "prune-preserve", grokPromptState: "not-sent", logFile };
    const ready = path.join(root, id + "-ready"), release = path.join(root, id + "-release");
    const child = fork(new URL("./fixtures/darwin-worker-lease-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    children.push({ child, closed });
    workersVerified = false;
    child.send({ job, delayClaim: true, gateReady: ready, gateRelease: release });
    await waitForFile(ready, child);
    const lease = JSON.parse(fs.readFileSync(ready, "utf8"));
    assert.equal(child.kill("SIGKILL"), true);
    assert.equal((await closed).signal, "SIGKILL");
    withStateSnapshot(workspace, (state, context) => {
      const indexed = state.jobs.find(entry => entry.id === id);
      const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspace, id), "utf8"));
      assert.equal(context.epoch, epoch);
      const available = withAvailableDarwinLease(lease, darwinLeaseDirectory(context), () => {
        verifyPublishedDarwinLeaseRecords({ context, indexed, stored, lease });
        return true;
      });
      assert.equal(available.status, "available", "stopped worker lease was not released");
    });
    workersVerified = true;
    return lease;
  }

  const lease = await stopQueuedWorker("dead-worker");
  const log = path.join(jobsDir, "history-0.log"), proof = path.join(jobsDir, "history-0.worker-stop-proof");
  fs.writeFileSync(log, "history evidence", { mode: 0o600 });
  const historyLease = await stopQueuedWorker("history-0", log);
  let ledger = findLedger(stateDir);
  ledger.value.cursor = historyLease.slot;
  fs.writeFileSync(ledger.name, JSON.stringify(ledger.value), { mode: 0o600 });
  let ledgerFd = fs.openSync(ledger.name, "r");
  try { fs.fsyncSync(ledgerFd); } finally { fs.closeSync(ledgerFd); }
  assert.equal(sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }).reclaimed, 1);
  assert.ok(fs.existsSync(proof), "real worker stop certificate was not recorded");

  const histories = Array.from({ length: 50 }, (_, i) => ({ id: "history-" + (i + 1), status: "completed", createdAt: "2099-01-01",
    updatedAt: "2099-" + String(i + 1).padStart(2, "0"), epoch, terminationPending: false, grokPromptState: "not-sent",
    pid: null, workerStopConfirmed: true, workerStopProof: "never-started", logFile: path.join(jobsDir, "history-" + (i + 1) + ".log") }));
  for (const history of histories) fs.writeFileSync(history.logFile, "history evidence", { mode: 0o600 });
  updateState(workspace, state => {
    for (const history of histories) { writeJobFile(workspace, history.id, history); state.jobs.push(history); }
  });
  ledger = findLedger(stateDir);
  ledger.value.cursor = lease.slot;
  fs.writeFileSync(ledger.name, JSON.stringify(ledger.value), { mode: 0o600 });
  ledgerFd = fs.openSync(ledger.name, "r");
  try { fs.fsyncSync(ledgerFd); } finally { fs.closeSync(ledgerFd); }

  const before = loadState(workspace);
  assert.equal(before.jobs.filter(job => job.id.startsWith("history-")).length, 51);
  const protectedFiles = [lease.path, ledger.name, proof, ...before.jobs.map(job => resolveJobFile(workspace, job.id)),
    ...before.jobs.filter(job => job.logFile).map(job => job.logFile)];
  const snapshots = protectedFiles.map(fileSnapshot);
  const pruneArtifacts = () => fs.readdirSync(stateDir, { recursive: true }).filter(name => /darwin-prune/i.test(name));
  assert.deepEqual(pruneArtifacts(), []);

  const env = { ...process.env, GROK_BIN: path.join(root, "missing-grok") };
  delete env.GROK_COMPANION_ACP_ENDPOINT;
  const child = spawn(process.execPath, [cli, "setup", "--enable-review-gate", "--cwd", workspace, "--json"],
    { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  children.push({ child, closed });
  const outcome = await closed;
  assert.equal(outcome.code, 0, stderr);
  assert.equal(outcome.signal, null);
  const report = JSON.parse(stdout);
  assert.equal(report.reviewGateEnabled, true);
  assert.equal(report.auth.reason, "grok-missing");
  const after = loadState(workspace);
  assert.equal(after.config.stopReviewGate, true);
  assert.deepEqual(after.jobs, before.jobs, "normal state update changed retained history");
  assert.deepEqual(protectedFiles.map(fileSnapshot), snapshots, "history, lease, ledger or stop certificate changed");
  assert.deepEqual(pruneArtifacts(), [], "normal state update created a prune transaction artifact");

  withStateSnapshot(workspace, (_state, context) => {
    assert.throws(() => pruneDarwinHistory(context), /Darwin prune: transaction is disabled pending integration/);
    assert.throws(() => recoverDarwinPrune(context), /Darwin prune: transaction is disabled pending integration/);
  });
  assert.throws(() => updateState(workspace, state => { state.jobs = state.jobs.filter(job => job.id !== "history-0"); }),
    /POSIX job history cannot be removed without a verified history transaction/);
  assert.deepEqual(loadState(workspace).jobs, before.jobs);
  assert.deepEqual(protectedFiles.map(fileSnapshot), snapshots);
  assert.deepEqual(pruneArtifacts(), []);
});
