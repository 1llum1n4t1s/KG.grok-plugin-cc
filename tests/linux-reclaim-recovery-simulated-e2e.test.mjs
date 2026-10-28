import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 故障条件: detail のみ確定した回収を放置、または不正な証拠から回収する。
// Mac の実プロセスによる模擬であり、Linux kernel や電源断は検証しない。
test("Linux reclaim resumes after deadline between detail and index", {
  skip: process.platform !== "darwin", timeout: 360000
}, t => runRecovery(t, false));

test("Linux reclaim preserves changed evidence after a crash between records", {
  skip: process.platform !== "darwin", timeout: 360000
}, t => runRecovery(t, true));

test("Linux reclaim rejects index post with detail old after a crash", {
  skip: process.platform !== "darwin", timeout: 360000
}, t => runRecovery(t, "reverse"));

test("Linux reclaim preserves evidence when binding disappears before lease unlink", {
  skip: process.platform !== "darwin", timeout: 360000
}, t => runRecovery(t, "missing-binding"));

test("Linux recovers a confirmed prepared ledger cursor after a crash", {
  skip: process.platform !== "darwin", timeout: 360000
}, t => runRecovery(t, false, true));

test("Linux preserves an invalid prepared ledger after a crash", {
  skip: process.platform !== "darwin", timeout: 360000
}, t => runRecovery(t, true, true));

function runRecovery(t, altered, prepared = false) {
  const root = fs.realpathSync(makeTempDir("grok-linux-reclaim-recovery-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const prior = process.env.CLAUDE_PLUGIN_DATA, priorPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const faultPreload = fileURLToPath(new URL("./fixtures/linux-reclaim-index-fault-preload.mjs", import.meta.url));
  const sweep = fileURLToPath(new URL("./fixtures/linux-reclaim-recovery-sweep.mjs", import.meta.url));
  const agent = fileURLToPath(new URL("./fixtures/linux-settings-agent.mjs", import.meta.url));
  const wrapper = path.join(root, "fake-grok"), exited = path.join(root, "agent-exited");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700, flag: "wx" });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_BIN: wrapper, XAI_API_KEY: "test-only",
    GROK_COMPANION_DISABLE_BROKER: "1", GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    SETTINGS_LOG: path.join(root, "settings.log"), SETTINGS_READY: path.join(root, "agent-ready"),
    SETTINGS_RELEASE: path.join(root, "agent-release"), SETTINGS_EXIT: exited,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA; delete env.SETTINGS_GATE;
  let migrated = false, agentStopped = false, finished = false;
  t.after(() => {
    try {
      if (migrated && agentStopped && finished) {
        const stop = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", "--offline-confirmed", "--local-only",
          "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stop.status, 0, stop.stderr);
        removeTempFixture(root, { recursive: true, force: true });
      } else if (migrated) t.diagnostic(`Retained fixture for inspection: ${root}`);
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prior;
      if (priorPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = priorPlugin;
    }
  });
  const migrate = spawnSync(process.execPath, [command, "state-lock", "migrate", "--offline-confirmed", "--local-only",
    "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migrate.status, 0, migrate.stderr); migrated = true;
  const task = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", "reclaim recovery fixture"],
    { env, encoding: "utf8", timeout: 30000 });
  assert.equal(task.status, 0, task.stderr);
  assert.ok(fs.existsSync(exited), "the agent exit must be observed");
  const stateFile = path.join(stateDir, "state.json");
  const original = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.status === "completed");
  assert.ok(original?.workerLease && original.grokDirectStopKind === "posix-group-empty");
  agentStopped = true;
  const detailFile = path.join(stateDir, "jobs", `${original.id}.json`);
  const originalDetail = fs.readFileSync(detailFile);
  const leaseFile = original.workerLease.path, bindingFile = leaseFile.replace(/\.lease$/, ".binding");
  const ledgerFile = path.join(path.dirname(leaseFile), "ledger.json"), marker = path.join(root, "index-inventory-fault");
  // 完了 worker の停止を確認した隔離 fixture で、次の sweep 対象をその slot に固定する。
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  assert.equal(ledger.slots[original.workerLease.slot].state, "published");
  ledger.cursor = original.workerLease.slot;
  fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger)}\n`);
  if (prepared) {
    const faultPreload = fileURLToPath(new URL("./fixtures/linux-ledger-prepared-fault-preload.mjs", import.meta.url));
    const preparedFile = path.join(path.dirname(leaseFile), "ledger.prepared");
    const marker = path.join(root, "prepared-ledger-fault");
    const beforeLedger = fs.readFileSync(ledgerFile);
    const crash = spawnSync(process.execPath, [sweep, workspace, "1", "60000"], {
      env: { ...env, GROK_LEDGER_FAULT_MARKER: marker, NODE_OPTIONS: `${env.NODE_OPTIONS} --import ${JSON.stringify(faultPreload)}` },
      encoding: "utf8", timeout: 75000
    });
    assert.equal(crash.status, 75, crash.stderr);
    assert.ok(fs.existsSync(marker));
    assert.deepEqual(fs.readFileSync(ledgerFile), beforeLedger);
    const pending = JSON.parse(fs.readFileSync(preparedFile, "utf8"));
    assert.equal(pending.cursor, (original.workerLease.slot + 1) % 256);
    assert.deepEqual(pending.slots, ledger.slots);
    assert.ok(fs.existsSync(leaseFile) && fs.existsSync(bindingFile));
    if (altered) fs.writeFileSync(preparedFile, "invalid prepared ledger\n");
    const savedPrepared = fs.readFileSync(preparedFile), savedState = fs.readFileSync(stateFile);
    const savedDetail = fs.readFileSync(detailFile);
    const retry = spawnSync(process.execPath, [sweep, workspace, "256", "180000"], { env, encoding: "utf8", timeout: 200000 });
    if (altered) {
      assert.notEqual(retry.status, 0, "invalid prepared evidence must block recovery");
      assert.deepEqual(fs.readFileSync(preparedFile), savedPrepared);
      assert.deepEqual(fs.readFileSync(ledgerFile), beforeLedger);
      assert.deepEqual(fs.readFileSync(stateFile), savedState);
      assert.deepEqual(fs.readFileSync(detailFile), savedDetail);
      assert.ok(fs.existsSync(leaseFile) && fs.existsSync(bindingFile));
    } else {
      assert.equal(retry.status, 0, retry.stderr);
      assert.equal(JSON.parse(retry.stdout).reclaimed, 1, "confirmed cursor update must recover");
      assert.equal(fs.existsSync(preparedFile), false);
      assert.equal(JSON.parse(fs.readFileSync(ledgerFile, "utf8")).slots[original.workerLease.slot].state, "free");
    }
    finished = true;
    return;
  }
  const faultEnv = { ...env, GROK_RECLAIM_FAULT_JOB: original.id, GROK_RECLAIM_FAULT_MARKER: marker,
    GROK_RECLAIM_FAULT_MODE: altered ? "crash" : "deadline",
    NODE_OPTIONS: `${env.NODE_OPTIONS} --import ${JSON.stringify(faultPreload)}` };
  const failed = spawnSync(process.execPath, [sweep, workspace, "1", "5000"], { env: faultEnv, encoding: "utf8", timeout: 30000 });
  if (altered) assert.equal(failed.status, 74, failed.stderr);
  else {
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /State commit outcome is unknown.*Timed out acquiring Grok state lock/);
  }
  assert.ok(fs.existsSync(marker), "failure must occur in index inventory after detail publication");
  const indexed = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === original.id);
  const detail = JSON.parse(fs.readFileSync(detailFile, "utf8"));
  assert.deepEqual(indexed.workerLease, original.workerLease);
  assert.equal(detail.workerLease, null);
  assert.equal(detail.workerStopProof, "linux-lease-released");
  assert.equal(detail.workerStopLeaseId, original.workerLease.id);
  assert.equal(JSON.parse(fs.readFileSync(ledgerFile, "utf8")).slots[original.workerLease.slot].state, "reclaiming");
  assert.ok(fs.existsSync(leaseFile) && fs.existsSync(bindingFile));
  if (altered === "reverse") {
    // detail→index の順では到達しない組合せを意図的に作り、保全を確認する。
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const target = state.jobs.find(job => job.id === original.id);
    for (const key of ["workerLease", "workerStopProof", "workerStopLeaseId", "workerStopConfirmed", "workerStopProcessStartKey"]) {
      target[key] = detail[key];
    }
    fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`);
    fs.writeFileSync(detailFile, originalDetail);
  } else if (altered) {
    if (altered === "missing-binding") {
      // 別 fixture 内に退避し、lease より先に binding が消えた観測を作る。
      fs.renameSync(bindingFile, path.join(root, "held-binding"));
    } else {
      detail.workerStopLeaseId = randomUUID();
      fs.writeFileSync(detailFile, `${JSON.stringify(detail)}\n`);
    }
  }
  const preservedState = fs.readFileSync(stateFile), preservedDetail = fs.readFileSync(detailFile);
  const retry = spawnSync(process.execPath, [sweep, workspace, "256", "180000"], { env, encoding: "utf8", timeout: 200000 });
  if (altered) {
    if (retry.status === 0) assert.equal(JSON.parse(retry.stdout).reclaimed, 0);
    assert.deepEqual(fs.readFileSync(stateFile), preservedState);
    assert.deepEqual(fs.readFileSync(detailFile), preservedDetail);
    assert.ok(fs.existsSync(leaseFile));
    if (altered === "missing-binding") {
      assert.equal(fs.existsSync(bindingFile), false);
      assert.ok(fs.existsSync(path.join(root, "held-binding")));
    } else assert.ok(fs.existsSync(bindingFile));
    assert.equal(JSON.parse(fs.readFileSync(ledgerFile, "utf8")).slots[original.workerLease.slot].state, "reclaiming");
  } else {
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(JSON.parse(retry.stdout).reclaimed, 1, "confirmed interrupted reclaim must resume");
    assert.equal(JSON.parse(fs.readFileSync(ledgerFile, "utf8")).slots[original.workerLease.slot].state, "free");
    const latestIndex = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === original.id);
    const latestDetail = JSON.parse(fs.readFileSync(detailFile, "utf8"));
    for (const record of [latestIndex, latestDetail]) {
      assert.equal(record.workerLease, null);
      assert.equal(record.workerStopLeaseId, original.workerLease.id);
    }
    assert.equal(fs.existsSync(leaseFile), false);
    assert.equal(fs.existsSync(bindingFile), false);
  }
  assert.equal(fs.readFileSync(path.join(root, "settings.log"), "utf8").split("\n").filter(line => line === "session/prompt").length, 1);
  finished = true;
}
