import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadState, migrateStateLock, resolveJobFile, resolveStateDir, resolveStateFile, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { sweepDarwinWorkerLeases } from "../plugins/grok/scripts/lib/darwin-lease-sweep.mjs";

// 故障条件: 索引確定後の SIGKILL で detail または log が孤立し、
// 無関係な停止済み worker の回収が阻まれる、または成果物が残り続ける。
const darwin = { skip: process.platform !== "darwin", timeout: 60000 };
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const gate = fileURLToPath(new URL("./fixtures/darwin-prune-crash-gate.cjs", import.meta.url));

async function waitForFile(file, child) {
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(file) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(file), `child did not reach gate: ${file}`);
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

for (const boundary of ["detail", "log", "proof", "marker", "phase", "index", "prepared-enospc", "marker-partial", "phase-partial"]) {
  test(`macOS CLI preserves or recovers interrupted history pruning at ${boundary}`, darwin, async t => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "grok-prune-crash-"));
    const workspace = path.join(root, "workspace"), data = path.join(root, "data");
    fs.mkdirSync(workspace); fs.mkdirSync(data);
    const oldData = process.env.CLAUDE_PLUGIN_DATA, oldPluginData = process.env.PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
    const children = [];
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
    const stateDir = resolveStateDir(workspace), stateFile = resolveStateFile(workspace), jobsDir = path.join(stateDir, "jobs");
    async function stopQueuedWorker(id, logFile = null) {
      const job = { id, workspaceRoot: workspace, jobClass: "review", title: "Review", sessionId: "prune-crash", grokPromptState: "not-sent", logFile };
      const ready = path.join(root, `${id}-ready`), release = path.join(root, `${id}-release`);
      const child = fork(new URL("./fixtures/darwin-worker-lease-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      const closed = new Promise(resolve => child.once("close", resolve));
      children.push({ child, closed });
      child.send({ job, delayClaim: true, gateReady: ready, gateRelease: release });
      await waitForFile(ready, child);
      const result = JSON.parse(fs.readFileSync(ready, "utf8"));
      child.kill("SIGKILL");
      await closed;
      return result;
    }
    const lease = await stopQueuedWorker("dead-worker");
    const detail = path.join(jobsDir, "history-0.json"), log = path.join(jobsDir, "history-0.log");
    fs.writeFileSync(log, "history evidence", { mode: 0o600 });
    const historyLease = await stopQueuedWorker("history-0", log);
    let ledger = findLedger(stateDir);
    ledger.value.cursor = historyLease.slot;
    fs.writeFileSync(ledger.name, JSON.stringify(ledger.value), { mode: 0o600 });
    let ledgerFd = fs.openSync(ledger.name, "r");
    try { fs.fsyncSync(ledgerFd); } finally { fs.closeSync(ledgerFd); }
    assert.equal(sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 }).reclaimed, 1);
    assert.ok(fs.existsSync(path.join(jobsDir, "history-0.worker-stop-proof")), "real worker stop certificate was not recorded");

    const epoch = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).epoch;
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const jobs = Array.from({ length: 50 }, (_, i) => ({ id: `history-${i + 1}`, status: "completed", createdAt: "2099-01-01",
      updatedAt: `2099-${String(i + 1).padStart(2, "0")}`, epoch, terminationPending: false, grokPromptState: "not-sent",
      pid: null, workerStopConfirmed: true, workerStopProof: "never-started",
      logFile: path.join(jobsDir, `history-${i + 1}.log`) }));
    for (const history of jobs) {
      fs.writeFileSync(resolveJobFile(workspace, history.id), JSON.stringify(history), { mode: 0o600 });
      fs.writeFileSync(history.logFile, "history evidence", { mode: 0o600 });
    }
    state.jobs.push(...jobs);
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    ledger = findLedger(stateDir);
    ledger.value.cursor = lease.slot;
    fs.writeFileSync(ledger.name, JSON.stringify(ledger.value), { mode: 0o600 });
    ledgerFd = fs.openSync(ledger.name, "r");
    try { fs.fsyncSync(ledgerFd); } finally { fs.closeSync(ledgerFd); }

    const ready = path.join(root, "prune-ready");
    const targets = { detail, log, proof: path.join(jobsDir, "history-0.worker-stop-proof"),
      marker: path.join(stateDir, "darwin-prune-v1.json"), phase: path.join(stateDir, "darwin-prune-proof-removing-v1.json"),
      index: path.join(stateDir, "darwin-prune-index.prepared"), "prepared-enospc": path.join(stateDir, "darwin-prune-index.prepared"),
      "marker-partial": path.join(stateDir, "darwin-prune-v1.json"), "phase-partial": path.join(stateDir, "darwin-prune-proof-removing-v1.json") };
    const child = spawn(process.execPath, ["--require", gate, cli, "setup", "--enable-review-gate", "--cwd", workspace, "--json"], {
      cwd: workspace, env: { ...process.env, GROK_PRUNE_TEST_TARGET: targets[boundary], GROK_PRUNE_TEST_READY: ready,
        ...(boundary === "prepared-enospc" ? { GROK_PRUNE_TEST_ENOSPC: "1" } : {}),
        ...(boundary.endsWith("-partial") ? { GROK_PRUNE_TEST_PARTIAL: "1" } : {}) },
      stdio: ["ignore", "ignore", "inherit"]
    });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    children.push({ child, closed });
    await waitForFile(ready, child);
    if (boundary === "prepared-enospc" || boundary.endsWith("-partial")) await closed;
    else {
      child.kill("SIGKILL");
      assert.equal((await closed).signal, "SIGKILL");
    }
    assert.equal(loadState(workspace).jobs.some(entry => entry.id === "history-0"), ["index", "prepared-enospc", "marker-partial"].includes(boundary), "unexpected index at crash boundary");
    assert.equal(fs.existsSync(detail), ["detail", "index", "prepared-enospc", "marker-partial"].includes(boundary));
    assert.equal(fs.existsSync(log), ["detail", "log", "index", "prepared-enospc", "marker-partial"].includes(boundary));

    if (boundary.endsWith("-partial")) {
      assert.ok(fs.existsSync(targets[boundary]));
      assert.throws(() => withStateSnapshot(workspace, () => {}));
      assert.ok(fs.existsSync(targets[boundary]), "partial marker was not preserved");
      assert.ok(fs.existsSync(path.join(jobsDir, "history-0.worker-stop-proof")));
      return;
    }

    if (boundary === "prepared-enospc") {
      assert.ok(fs.existsSync(path.join(stateDir, "darwin-prune-index.prepared")));
      assert.equal(fs.existsSync(path.join(stateDir, "darwin-prune-v1.json")), false);
      assert.throws(() => withStateSnapshot(workspace, () => {}));
      assert.ok(fs.existsSync(detail));
      assert.equal(fs.readFileSync(log, "utf8"), "history evidence");
      assert.ok(fs.existsSync(path.join(jobsDir, "history-0.worker-stop-proof")));
      return;
    }

    if (boundary === "index") {
      fs.appendFileSync(log, " delayed diagnostic");
      withStateSnapshot(workspace, state => assert.ok(state.jobs.some(entry => entry.id === "history-0")));
      assert.equal(fs.readFileSync(log, "utf8"), "history evidence delayed diagnostic");
      assert.ok(fs.existsSync(detail));
      assert.ok(fs.existsSync(path.join(jobsDir, "history-0.worker-stop-proof")));
      assert.equal(fs.existsSync(path.join(stateDir, "darwin-prune-index.prepared")), false);
      assert.equal(fs.existsSync(path.join(stateDir, "darwin-prune-v1.json")), false);
      return;
    }

    const result = sweepDarwinWorkerLeases(workspace, { maxEntries: 1, timeoutMs: 5000 });
    assert.equal(result.reclaimed, 1, JSON.stringify(result));
    assert.equal(fs.existsSync(lease.path), false, "unrelated stopped worker lease remains allocated");
    assert.equal(fs.existsSync(detail), false, "committed prune detail was not recovered");
    assert.equal(fs.existsSync(log), false, "committed prune log was not recovered");
    assert.equal(fs.existsSync(path.join(jobsDir, "history-0.worker-stop-proof")), false, "committed prune proof was not recovered");
    assert.equal(loadState(workspace).jobs.filter(entry => entry.id.startsWith("history-")).length, 50);
  });
}
