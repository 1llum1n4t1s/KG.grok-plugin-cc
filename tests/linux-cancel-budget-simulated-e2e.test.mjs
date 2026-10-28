import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { linuxControlCapacityReserve, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// 実 CLI task/cancel と fake agent を使い、別記録が残量を消費しても
// 稼働中 task の取消意図が両 record に保存できることを確認する。
// 別 detail の増大は test-only state API で、同じ mutex と通常 write 経路を通す。
// procfs/mount/flock は Mac 模擬であり Linux kernel の保証ではない。
const scenarios = [
  ...["detail", "index"].flatMap(kind => [64, 24576].map(headroom => ({ kind, headroom, longWarning: false, text: false }))),
  { kind: "detail", headroom: 24576, longWarning: true, text: false },
  { kind: "detail", headroom: 24576, longWarning: true, text: true },
  { kind: "detail", headroom: 24576, longWarning: true, text: true, stderrBroken: true },
  { kind: "detail", headroom: 16384, longWarning: false, text: false, crashAfterDetail: true },
  { kind: "detail", headroom: 20480, longWarning: false, text: false, crashAfterDetail: true },
  { kind: "detail", headroom: 24576, longWarning: false, text: false, crashAfterDetail: true },
  { kind: "detail", headroom: 24576, longWarning: false, text: false, workerFailure: true }
];
for (const { kind, headroom, longWarning, text, stderrBroken, crashAfterDetail, workerFailure } of scenarios) test(`simulated Linux cancel retains control space while another ${kind} grows (headroom ${headroom}${longWarning ? ", long warnings" : ""}${text ? ", text" : ""}${stderrBroken ? ", stderr unavailable" : ""}${crashAfterDetail ? ", crash after detail" : ""}${workerFailure ? ", long worker failure" : ""})`, { skip: process.platform !== "darwin", timeout: 120000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-linux-cancel-budget-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace"), registry = path.join(root, "processes");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(registry, { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), agentPid = path.join(root, "agent.pid"), spawnMarker = path.join(root, "agent-spawned"), promptMarker = path.join(root, "prompt-sent");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const agent = fileURLToPath(new URL("./fixtures/linux-cli-simulated-agent.mjs", import.meta.url));
  const fill = fileURLToPath(new URL(kind === "detail" ? "./fixtures/linux-fill-detail-budget.mjs" : "./fixtures/linux-fill-index-budget.mjs", import.meta.url));
  const wrapper = path.join(root, "fake-grok"), quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { flag: "wx", mode: 0o700 });
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim(),
    GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_LINUX_SIM_AGENT_PID: agentPid,
    GROK_LINUX_SIM_SPAWN_MARKER: spawnMarker, GROK_LINUX_SIM_PROMPT_MARKER: promptMarker,
    GROK_LINUX_SIM_COMPLETE: "1", GROK_LINUX_SIM_HOLD_PROMPT: "1", GROK_BIN: wrapper, XAI_API_KEY: "test-only",
    ...(workerFailure ? { GROK_LINUX_SIM_FAILURE_READY: promptMarker, GROK_LINUX_SIM_FAILURE_RELEASE: path.join(root, "release-failure"), GROK_LINUX_SIM_AGGREGATE_DIAGNOSTIC: "1" } : {}),
    GROK_COMPANION_DISABLE_BROKER: "1" };
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  let migrated = false, worker, closed;
  t.after(async () => {
    try {
      if (worker) {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
        await closed;
      }
      let stopped = !fs.existsSync(spawnMarker);
      if (fs.existsSync(agentPid)) {
        const pid = Number(fs.readFileSync(agentPid, "utf8")), deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === "ESRCH") { stopped = true; break; } throw error; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      if (migrated && stopped) {
        const result = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...args], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(result.status, 0, result.stderr);
      } else if (migrated) t.diagnostic(`Retained sentinel; agent exit is unconfirmed: ${root}`);
    } finally {
      for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      t.diagnostic(`Cancel budget fixture retained: ${root}`);
    }
  });
  const migration = spawnSync(process.execPath, [command, "state-lock", "migrate", ...args], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(migration.status, 0, migration.stderr); migrated = true;
  const stateFile = path.join(stateDir, "state.json"), jobs = path.join(stateDir, "jobs"), fillerFile = path.join(jobs, "old-fill.json");
  const filler = { id: "old-fill", status: "completed", epoch: "22222222-2222-4222-8222-222222222222",
    createdAt: "2020-01-01T00:00:00.000Z", jobClass: "task", terminationPending: false };
  fs.writeFileSync(fillerFile, JSON.stringify(filler), { flag: "wx", mode: 0o600 });
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8")); state.jobs.push(filler);
  fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  worker = spawn(process.execPath, [command, "task", "--cwd", workspace, "--json", "wait for cancellation"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; worker.stderr.on("data", chunk => { stderr += chunk; });
  closed = new Promise(resolve => worker.once("close", resolve));
  const deadline = Date.now() + 40000;
  while (!fs.existsSync(promptMarker) && worker.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(promptMarker), `task did not reach its prompt: ${stderr}`);
  const active = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id !== filler.id && job.status === "running");
  assert.ok(active);
  const increased = spawnSync(process.execPath, [fill, workspace, filler.id], { env: { ...env, GROK_LINUX_SIM_BUDGET_HEADROOM: String(headroom) }, encoding: "utf8", timeout: 45000, maxBuffer: 1024 * 1024 });
  assert.equal(increased.status, 0, increased.stderr);
  const fillResult = JSON.parse(increased.stdout);
  if (!fillResult.saved) {
    assert.match(fillResult.error, /budget|capacity|limit/i);
    assert.ok(headroom === 64 || crashAfterDetail, "the full control reservation should be usable");
  }
  else {
    const total = kind === "index" ? fs.statSync(stateFile, { bigint: true }).size :
      fs.readdirSync(jobs).filter(name => name.endsWith(".json")).reduce((sum, name) => sum + fs.statSync(path.join(jobs, name), { bigint: true }).size, 0n);
    assert.equal(total, 64n * 1024n * 1024n - BigInt(headroom), "fixture did not consume the intended space");
  }
  if (workerFailure) {
    fs.writeFileSync(env.GROK_LINUX_SIM_FAILURE_RELEASE, "release", { flag: "wx", mode: 0o600 });
    let timer;
    const ended = await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000); })]);
    clearTimeout(timer);
    assert.equal(ended, true, "worker did not report the external failure");
    assert.notEqual(worker.exitCode, 0);
    assert.match(stderr, /fixture external failure: 🚨/);
    assert.ok((stderr.match(/🚨/g) ?? []).length >= 6000, "full diagnostic was not sent to stderr");
    const failed = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === active.id);
    const failedDetail = JSON.parse(fs.readFileSync(path.join(jobs, `${active.id}.json`), "utf8"));
    const aggregateCauses = stderr.match(/\[fixture aggregate causes\]\n[\s\S]{0,1600}/g)?.join("\n") ?? "none";
    assert.equal(failed.status, "failed", `worker failure was not recorded; aggregate causes: ${aggregateCauses}; stderr tail: ${stderr.slice(-1000)}`);
    assert.equal(failedDetail.status, "failed");
    assert.match(failed.errorMessage, /truncat/i);
    assert.equal(failed.errorMessage, failedDetail.errorMessage);
    assert.ok(Buffer.byteLength(JSON.stringify(failed.errorMessage), "utf8") <= 1024);
    return;
  }
  const cancelEnv = { ...env, ...(longWarning ? { GROK_LINUX_SIM_LOG_FAILURE: active.logFile } : {}),
    ...(stderrBroken ? { GROK_LINUX_SIM_STDERR_FAILURE: "1" } : {}),
    ...(crashAfterDetail ? { GROK_LINUX_SIM_RECORD_FAULT: "detail-crash" } : {}) };
  const cancelArgs = [command, "cancel", "--cwd", workspace, ...(text ? [] : ["--json"]), active.id];
  const cancel = spawnSync(process.execPath, cancelArgs, { env: cancelEnv, encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  const indexed = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === active.id);
  const detail = JSON.parse(fs.readFileSync(path.join(jobs, `${active.id}.json`), "utf8"));
  if (crashAfterDetail) {
    assert.equal(cancel.status, 72, cancel.stderr);
    assert.equal(indexed.status, "running"); assert.equal(detail.status, "cancelled");
    const total = fs.readdirSync(jobs).filter(name => name.endsWith(".json")).reduce((sum, name) => sum + fs.statSync(path.join(jobs, name), { bigint: true }).size, 0n);
    assert.ok(64n * 1024n * 1024n - total >= linuxControlCapacityReserve(indexed) - 4096n, "partial write consumed the index-side control or failure reserve");
    const beforeState = fs.readFileSync(stateFile, "utf8"), detailPath = path.join(jobs, `${active.id}.json`), beforeDetail = fs.readFileSync(detailPath, "utf8");
    const retry = spawnSync(process.execPath, cancelArgs, { env, encoding: "utf8", timeout: 20000 });
    assert.notEqual(retry.status, 0, "partial records must remain unconfirmed");
    assert.equal(fs.readFileSync(stateFile, "utf8"), beforeState); assert.equal(fs.readFileSync(detailPath, "utf8"), beforeDetail);
    return;
  }
  assert.equal(indexed.status, "cancelled", `cancellation intent was not saved: ${cancel.stderr}`);
  assert.equal(detail.status, "cancelled");
  assert.ok(indexed.cancelRequestedAt && indexed.cancelRequestedAt === detail.cancelRequestedAt);
  let waitTimer;
  const workerEnded = await Promise.race([closed.then(() => true), new Promise(resolve => { waitTimer = setTimeout(() => resolve(false), 15000); })]);
  clearTimeout(waitTimer);
  assert.equal(workerEnded, true, "fake worker did not finish after cancellation");
  const pending = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === active.id);
  let result = cancel;
  if (pending.terminationPending === true) {
    const retry = spawnSync(process.execPath, cancelArgs, { env: cancelEnv, encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(retry.status, 0, retry.stderr);
    result = retry;
  }
  const final = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === active.id);
  const finalDetail = JSON.parse(fs.readFileSync(path.join(jobs, `${active.id}.json`), "utf8"));
  assert.equal(final.terminationPending, false);
  assert.equal(final.workerStopProof, "linux-lease-released");
  assert.equal(finalDetail.workerStopProof, final.workerStopProof);
  if (longWarning) {
    if (!stderrBroken) assert.match(`${cancel.stderr}${result.stderr}`, /fixture long diagnostic: 🚨/);
    if (text) {
      assert.match(result.stdout, /warnings?:\s*2/i);
      assert.match(result.stdout, /truncat/i);
      assert.match(result.stdout, /omitt/i);
      assert.match(result.stdout, /stderr/i);
      if (stderrBroken) assert.match(result.stdout, /could not be written to stderr/i);
    } else {
      const report = JSON.parse(result.stdout);
      assert.equal(report.logWarningCount, 2);
      assert.equal(report.logWarningTruncatedCount, 1);
      assert.equal(report.logWarningOmittedCount, 1);
      assert.ok(Array.isArray(report.logWarnings) && report.logWarnings.length >= 2);
      assert.ok(report.logWarnings.some(warning => /truncat|omitt/i.test(warning)), "shortened warnings must be disclosed");
      assert.ok(Buffer.byteLength(JSON.stringify(report.logWarnings), "utf8") <= 4096, "JSON-escaped warnings must fit the control reserve");
    }
    assert.ok(Buffer.byteLength(JSON.stringify(finalDetail.logWarnings), "utf8") <= 4096);
    if (stderrBroken) assert.equal(finalDetail.logWarningStderrUnavailable, true);
  }
});
