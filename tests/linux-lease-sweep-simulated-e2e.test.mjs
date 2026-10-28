import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 故障条件: 生存中の worker を回収する、worker 終了だけで turn の停止を
// 推測する。Mac の実プロセスを使用するが procfs・mount・flock は模擬であり、
// Linux kernel の namespace・flock や電源断時の耐久性を実証しない。
test("Linux sweep retains a live owner and an unconfirmed turn after its crash", {
  skip: process.platform !== "darwin", timeout: 180000
}, async t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-sweep-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const prior = process.env.CLAUDE_PLUGIN_DATA, priorPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data;
  delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const sweep = fileURLToPath(new URL("./fixtures/linux-lease-sweep-cli.mjs", import.meta.url));
  const agent = fileURLToPath(new URL("./fixtures/linux-cli-simulated-agent.mjs", import.meta.url));
  const wrapper = path.join(root, "fake-grok"), agentPidFile = path.join(root, "agent.pid");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700, flag: "wx" });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_BIN: wrapper, XAI_API_KEY: "test-only",
    GROK_COMPANION_DISABLE_BROKER: "1", GROK_LINUX_SIM_AGENT_PID: agentPidFile,
    GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA;
  let worker, closed, migrated = false;
  t.after(async () => {
    try {
      if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
      if (closed) await closed;
      let stopped = !fs.existsSync(agentPidFile);
      const pid = stopped ? null : Number(fs.readFileSync(agentPidFile, "utf8"));
      const deadline = Date.now() + 8000;
      while (!stopped && Date.now() < deadline) {
        try { process.kill(pid, 0); }
        catch (error) { if (error.code === "ESRCH") { stopped = true; break; } throw error; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (migrated && stopped) {
        const result = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", "--offline-confirmed", "--local-only",
          "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(result.status, 0, result.stderr);
        removeTempFixture(root, { recursive: true, force: true });
      } else if (migrated) t.diagnostic(`Retained fixture: agent termination unconfirmed: ${root}`);
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prior;
      if (priorPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = priorPlugin;
    }
  });
  const migrate = spawnSync(process.execPath, [command, "state-lock", "migrate", "--offline-confirmed", "--local-only",
    "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migrate.status, 0, migrate.stderr);
  migrated = true;
  worker = spawn(process.execPath, [command, "task", "--cwd", workspace, "--json", "sweep fixture"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  worker.stderr.on("data", chunk => { stderr += chunk; });
  closed = new Promise(resolve => worker.once("close", resolve));
  const stateFile = path.join(stateDir, "state.json");
  let job;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(stateFile)) {
      job = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(item => item.status === "running");
      if (job && fs.existsSync(agentPidFile)) break;
    }
    if (worker.exitCode !== null || worker.signalCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(job && fs.existsSync(agentPidFile), `worker did not start: ${stderr}`);
  const runSweep = (maxEntries = 256) => {
    const result = spawnSync(process.execPath, [sweep, workspace, String(maxEntries)], { env, encoding: "utf8", timeout: 75000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const ledgerPath = path.join(path.dirname(job.workerLease.path), "ledger.json");
  const cursor = JSON.parse(fs.readFileSync(ledgerPath, "utf8")).cursor;
  assert.equal(runSweep(1).examined, 1);
  assert.equal(JSON.parse(fs.readFileSync(ledgerPath, "utf8")).cursor, (cursor + 1) % 256);
  const before = runSweep();
  assert.equal(before.reclaimed, 0);
  assert.ok(fs.existsSync(job.workerLease.path));
  worker.kill("SIGKILL");
  await closed;
  const after = runSweep();
  assert.equal(after.reclaimed, 0);
  assert.ok(fs.existsSync(job.workerLease.path), "turn stop must not be inferred from worker exit");
  const indexed = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(item => item.id === job.id);
  const detail = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${job.id}.json`), "utf8"));
  assert.deepEqual(indexed.workerLease, job.workerLease);
  assert.deepEqual(detail.workerLease, job.workerLease);
});

test("Linux sweep removes only lease references after a separately confirmed terminal turn", {
  skip: process.platform !== "darwin", timeout: 600000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-sweep-terminal-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const prior = process.env.CLAUDE_PLUGIN_DATA, priorPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const sweep = fileURLToPath(new URL("./fixtures/linux-lease-sweep-cli.mjs", import.meta.url));
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
  let migrated = false, workerStarted = false, workerStopped = false, controlStarted = false, controlStopped = false;
  t.after(() => {
    try {
      if (migrated && (!workerStarted || workerStopped) && (!controlStarted || controlStopped)) {
        const result = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", "--offline-confirmed", "--local-only",
          "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(result.status, 0, result.stderr);
        removeTempFixture(root, { recursive: true, force: true });
      } else if (migrated) t.diagnostic(`Retained fixture: agent termination unconfirmed: ${root}`);
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prior;
      if (priorPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = priorPlugin;
    }
  });
  const migrate = spawnSync(process.execPath, [command, "state-lock", "migrate", "--offline-confirmed", "--local-only",
    "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migrate.status, 0, migrate.stderr); migrated = true;
  workerStarted = true;
  const task = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", "terminal sweep fixture"],
    { env, encoding: "utf8", timeout: 30000 });
  assert.equal(task.status, 0, task.stderr);
  assert.ok(fs.existsSync(exited), "agent exit must be independently observed");
  const stateFile = path.join(stateDir, "state.json");
  const job = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(item => item.status === "completed");
  assert.ok(job?.workerLease, "completed job must initially retain its lease");
  assert.equal(job.grokDirectStopKind, "posix-group-empty");
  workerStopped = true;
  // 同じ snapshot で旧 epoch のない対照 slot を通常経路から作り、
  // mutex と observer lock を通した回収が先に成立することを確認する。
  const controlExit = path.join(root, "control-agent-exited");
  controlStarted = true;
  const controlTask = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", "sweep control fixture"],
    { env: { ...env, SETTINGS_EXIT: controlExit }, encoding: "utf8", timeout: 30000 });
  assert.equal(controlTask.status, 0, controlTask.stderr);
  assert.ok(fs.existsSync(controlExit));
  const control = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(item => item.status === "completed" && item.id !== job.id);
  assert.ok(control?.workerLease && control.grokDirectStopKind === "posix-group-empty");
  controlStopped = true;
  const ledgerFile = path.join(path.dirname(control.workerLease.path), "ledger.json");
  const controlLedger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  controlLedger.cursor = control.workerLease.slot;
  fs.writeFileSync(ledgerFile, `${JSON.stringify(controlLedger)}\n`);
  const controlSweep = spawnSync(process.execPath, [sweep, workspace, "1"], { env, encoding: "utf8", timeout: 75000 });
  assert.equal(controlSweep.status, 0, controlSweep.stderr);
  assert.equal(JSON.parse(controlSweep.stdout).reclaimed, 1, "the control slot must be reclaimable without old history");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(item => item.id === control.id).workerLease, null);
  const detailFile = path.join(stateDir, "jobs", `${job.id}.json`);
  const originalState = fs.readFileSync(stateFile);
  const originalDetail = fs.readFileSync(detailFile);
  const runSweep = () => {
    const result = spawnSync(process.execPath, [sweep, workspace], { env, encoding: "utf8", timeout: 75000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const partiallyRemoved = JSON.parse(originalDetail);
  partiallyRemoved.workerLease = null;
  fs.writeFileSync(detailFile, `${JSON.stringify(partiallyRemoved)}\n`);
  assert.equal(runSweep().reclaimed, 0, "one-sided reference removal must remain protected");
  assert.ok(fs.existsSync(job.workerLease.path));
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(item => item.id === job.id).workerLease, job.workerLease);
  fs.writeFileSync(detailFile, originalDetail);
  const mismatched = JSON.parse(originalDetail);
  mismatched.grokDirectStopConfirmedAt = "fixture-mismatched-evidence";
  fs.writeFileSync(detailFile, `${JSON.stringify(mismatched)}\n`);
  assert.equal(runSweep().reclaimed, 0, "mismatched turn-stop evidence must remain protected");
  assert.ok(fs.existsSync(job.workerLease.path));
  fs.writeFileSync(detailFile, originalDetail);
  const mismatchedTime = JSON.parse(originalDetail);
  mismatchedTime.completedAt = "fixture-mismatched-completion";
  fs.writeFileSync(detailFile, `${JSON.stringify(mismatchedTime)}\n`);
  assert.equal(runSweep().reclaimed, 0, "mismatched completion times must remain protected");
  fs.writeFileSync(detailFile, originalDetail);
  const wrongProof = { workerStopConfirmed: true, workerStopProof: "linux-lease-released",
    workerStopLeaseId: job.workerLease.id === "11111111-1111-4111-8111-111111111111"
      ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111",
    workerStopProcessStartKey: job.processStartKey ?? null };
  const alteredState = JSON.parse(originalState);
  Object.assign(alteredState.jobs.find(item => item.id === job.id), wrongProof);
  fs.writeFileSync(stateFile, `${JSON.stringify(alteredState)}\n`);
  fs.writeFileSync(detailFile, `${JSON.stringify({ ...JSON.parse(originalDetail), ...wrongProof })}\n`);
  assert.equal(runSweep().reclaimed, 0, "evidence naming another lease must remain protected");
  fs.writeFileSync(stateFile, originalState);
  fs.writeFileSync(detailFile, originalDetail);
  const orphan = path.join(stateDir, "jobs", "foreign.json");
  fs.writeFileSync(orphan, `${JSON.stringify({ ...job, id: "foreign" })}\n`, { flag: "wx", mode: 0o600 });
  assert.equal(runSweep().reclaimed, 0, "an unindexed reverse reference must prevent reclamation");
  assert.ok(fs.existsSync(job.workerLease.path));
  fs.unlinkSync(orphan);
  // 旧 v4 epoch の evidence は保全し、slot 番号が同じでも現 epoch の
  // lease と ID・path・inode が異なれば、現在の回収を妨げない。
  const oldEpoch = randomUUID(), oldClaim = randomUUID(), oldId = randomUUID();
  const oldDirectory = path.join(stateDir, "worker-leases-v1", oldEpoch);
  fs.mkdirSync(oldDirectory, { mode: 0o700 });
  const oldPath = path.join(oldDirectory, path.basename(job.workerLease.path));
  fs.writeFileSync(oldPath, oldId, { flag: "wx", mode: 0o600 });
  const oldStat = fs.lstatSync(oldPath, { bigint: true });
  const oldLease = { id: oldId, path: oldPath, dev: String(oldStat.dev), ino: String(oldStat.ino),
    stateGeneration: oldEpoch, slot: job.workerLease.slot };
  const oldRecord = { ...job, id: "old-v4-history", epoch: oldEpoch, claimToken: oldClaim, workerLease: oldLease, logFile: null };
  const oldBinding = oldPath.replace(/\.lease$/, ".binding");
  fs.writeFileSync(oldBinding, `${JSON.stringify({ jobId: oldRecord.id, claimToken: oldClaim, epoch: oldEpoch,
    slot: oldLease.slot, lease: oldLease })}\n`, { flag: "wx", mode: 0o600 });
  const bindingIno = String(fs.lstatSync(oldBinding, { bigint: true }).ino);
  const oldSlots = Array.from({ length: 256 }, (_, slot) => ({ slot, state: "free" }));
  oldSlots[oldLease.slot] = { slot: oldLease.slot, state: "published", jobId: oldRecord.id,
    claimToken: oldClaim, createdAt: oldRecord.createdAt, lease: oldLease, bindingIno };
  fs.writeFileSync(path.join(oldDirectory, "ledger.json"), `${JSON.stringify({ protocol: "linux-lease-ledger-v1",
    epoch: oldEpoch, cursor: 0, slots: oldSlots })}\n`, { flag: "wx", mode: 0o600 });
  const stateWithHistory = JSON.parse(originalState);
  stateWithHistory.jobs.push(oldRecord);
  fs.writeFileSync(stateFile, `${JSON.stringify(stateWithHistory)}\n`);
  const oldDetail = path.join(stateDir, "jobs", `${oldRecord.id}.json`);
  fs.writeFileSync(oldDetail, `${JSON.stringify(oldRecord)}\n`, { flag: "wx", mode: 0o600 });
  const oldHeld = `${oldPath}.fixture-held`;
  fs.renameSync(oldPath, oldHeld);
  assert.equal(runSweep().reclaimed, 0, "a missing old epoch lease must remain uncertain");
  fs.renameSync(oldHeld, oldPath);
  const crashPreload = fileURLToPath(new URL("./fixtures/linux-lease-sweep-crash-preload.mjs", import.meta.url));
  const crashed = spawnSync(process.execPath, [sweep, workspace], { encoding: "utf8", timeout: 75000,
    env: { ...env, GROK_SWEEP_CRASH_AFTER_LEASE_UNLINK: "1", NODE_OPTIONS: `${env.NODE_OPTIONS} --import ${JSON.stringify(crashPreload)}` } });
  assert.equal(crashed.status, 73, `${crashed.stderr}\n${crashed.stdout}`);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(item => item.id === job.id).workerLease, null);
  assert.equal(JSON.parse(fs.readFileSync(detailFile, "utf8")).workerLease, null);
  assert.equal(fs.existsSync(job.workerLease.path), false);
  assert.ok(fs.existsSync(job.workerLease.path.replace(/\.lease$/, ".binding")));
  assert.equal(runSweep().reclaimed, 1);
  const indexed = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(item => item.id === job.id);
  const detail = JSON.parse(fs.readFileSync(detailFile, "utf8"));
  assert.equal(indexed.status, "completed");
  assert.equal(indexed.workerLease, null);
  assert.equal(detail.workerLease, null);
  assert.equal(fs.existsSync(job.workerLease.path), false);
  assert.equal(fs.existsSync(job.workerLease.path.replace(/\.lease$/, ".binding")), false);
  assert.ok(fs.existsSync(oldPath), "old epoch lease evidence must be retained");
  assert.ok(fs.existsSync(oldBinding), "old epoch binding evidence must be retained");
  assert.deepEqual(JSON.parse(fs.readFileSync(oldDetail, "utf8")).workerLease, oldLease);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(item => item.id === oldRecord.id).workerLease, oldLease);
});
