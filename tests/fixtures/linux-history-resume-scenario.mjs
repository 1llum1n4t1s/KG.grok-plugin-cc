import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFixtureBroker } from "../broker-fixture-helper.mjs";
import { ensureBrokerSession, sendBrokerShutdown } from "../../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { shutdownPosixStateLockSentinel } from "../../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { migrateStateLock, resolveStateDir, updateState, writeJobFile } from "../../plugins/grok/scripts/lib/state.mjs";
import { sortJobsNewestFirst } from "../../plugins/grok/scripts/lib/job-control.mjs";
import { createHash } from "node:crypto";
import { sweepLinuxWorkerLeases } from "../../plugins/grok/scripts/lib/linux-lease-ledger.mjs";

const root = process.env.GROK_LINUX_SIM_ROOT, stateDir = process.env.GROK_LINUX_SIM_STATE_DIR;
const workspace = path.join(root, "workspace"), stateFile = path.join(stateDir, "state.json"), jobsDir = path.join(stateDir, "jobs");
const command = fileURLToPath(new URL("../../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const directAgent = fileURLToPath(new URL("./linux-history-resume-direct-agent.mjs", import.meta.url));
const brokerAgent = fileURLToPath(new URL("./linux-history-broker-agent.mjs", import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const directWrapper = path.join(root, "direct-grok"), brokerWrapper = path.join(root, "broker-grok");
for (const [wrapper, agent] of [[directWrapper, directAgent], [brokerWrapper, brokerAgent]]) {
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { flag: "wx", mode: 0o700 });
}
const endpoint = `unix:${path.join(root, "broker.sock")}`, release = path.join(root, "broker-release");
const ready = path.join(root, "broker-load-ready"), brokerExit = path.join(root, "broker-agent-exit");
const env = { ...process.env, XAI_API_KEY: "test-only", GROK_BIN: brokerWrapper, GROK_COMPANION_DISABLE_BROKER: "0",
  GROK_COMPANION_ACP_ENDPOINT: endpoint, SETTINGS_GATE: "load", SETTINGS_READY: ready, SETTINGS_RELEASE: release,
  SETTINGS_LOG: path.join(root, "broker-agent.log"), SETTINGS_EXIT: brokerExit };
const directEnv = { ...env, GROK_BIN: directWrapper, GROK_COMPANION_DISABLE_BROKER: "1", SETTINGS_GATE: "",
  SETTINGS_LOG: path.join(root, "direct-agent.log"), SETTINGS_READY: path.join(root, "direct-ready") };
const control = process.env.GROK_RESUME_CONTROL === "1";
let broker, brokerClosed, resume, resumeClosed, safeToStopSentinel = false, directStopped = true, mainError, migrationProof;
const rootStat = fs.lstatSync(root, { bigint: true });
assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink() && fs.realpathSync(root) === root);
const scenarioStarted = performance.now(), workDeadline = scenarioStarted + 100000, cleanupDeadline = scenarioStarted + 145000;
// 停止処理の inspect 5s、root lock 7.5s、stop utility 3s、exit確認 3s と余白を確保する。
const sentinelStopReserveMs = 25000, processCleanupDeadline = cleanupDeadline - sentinelStopReserveMs;
function remaining(deadline, cap) {
  const left = Math.floor(deadline - performance.now());
  if (left <= 0) throw new Error("History resume deadline expired");
  return Math.min(cap, left);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function closeWithin(promise, label, deadline, ms = 8000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} close is unconfirmed`)), remaining(deadline, ms)); })]); }
  finally { clearTimeout(timer); }
}
async function waitUntil(condition, ms, deadline = workDeadline) {
  const end = performance.now() + remaining(deadline, ms);
  while (!condition() && performance.now() < end) await delay(Math.min(20, Math.max(0, end - performance.now())));
  return condition();
}
function runTask(i, hostSession, extra = {}) {
  const exited = path.join(root, `direct-exit-${i}`), spawned = path.join(root, `direct-spawn-${i}`);
  directStopped = false;
  const result = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", "--fresh", `fill ${i}`],
    { env: { ...directEnv, ...extra, SETTINGS_EXIT: exited, GROK_LINUX_SIM_SPAWN_MARKER: spawned,
      GROK_COMPANION_SESSION_ID: hostSession }, encoding: "utf8", timeout: remaining(workDeadline, 30000) });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(spawned), `direct agent ${i} spawn must be observed`);
  assert.ok(fs.existsSync(exited), `direct agent ${i} exit must be observed`);
  const id = JSON.parse(result.stdout).jobId;
  const indexed = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === id);
  const detail = JSON.parse(fs.readFileSync(path.join(jobsDir, `${id}.json`), "utf8"));
  const attempt = JSON.parse(fs.readFileSync(`${spawned}.attempt`, "utf8"));
  const observed = JSON.parse(fs.readFileSync(spawned, "utf8"));
  assert.ok(Number.isSafeInteger(observed.pid) && observed.pid > 0);
  assert.equal(observed.group, observed.pid); assert.equal(attempt.owner, observed.owner);
  assert.equal(fs.readFileSync(path.join(root, `marker-preload-ready-${observed.owner}`), "utf8"), "ready");
  for (const record of [indexed, detail]) {
    assert.equal(record.grokDirectOwnerPid, observed.owner);
    assert.ok(record.grokDirectGeneration);
    assert.equal(record.grokDirectStopGeneration, record.grokDirectGeneration);
    assert.equal(record.grokDirectOwnerStartKey, record.processStartKey);
  }
  assert.equal(detail.grokDirectGeneration, indexed.grokDirectGeneration);
  assert.equal(indexed?.grokDirectStopKind, "posix-group-empty");
  assert.ok(indexed.grokDirectStopConfirmedAt, `direct task ${i} must confirm its agent group stopped`);
  assert.equal(detail.grokDirectStopKind, indexed.grokDirectStopKind);
  assert.equal(detail.grokDirectStopConfirmedAt, indexed.grokDirectStopConfirmedAt);
  try { process.kill(-observed.group, 0); throw new Error(`direct task ${i} group is still present`); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
  directStopped = true;
  return id;
}
function reclaim(id) {
  const indexed = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === id);
  const lease = indexed?.workerLease;
  assert.ok(lease, `task ${id} must have a lease before recovery`);
  const ledgerFile = path.join(stateDir, "worker-leases-v1", indexed.epoch, "ledger.json");
  let ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  let reclaimed = 0, examined = 0;
  for (let i = 0; i < 17 && reclaimed === 0; i++) {
    const cursor = ledger.cursor;
    const result = sweepLinuxWorkerLeases(workspace, { maxEntries: 16, timeoutMs: remaining(workDeadline, 5000), stopAfterReclaim: true });
    assert.ok(result.examined >= 1 && result.examined <= 16);
    examined += result.examined; reclaimed += result.reclaimed;
    ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    assert.equal(ledger.cursor, (cursor + result.examined) % 256);
  }
  assert.equal(reclaimed, 1, `task ${id} must be reclaimed within one bounded rotation`);
  assert.ok(examined <= 256);
  assert.equal(ledger.slots[lease.slot].state, "free");
  const after = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === id);
  const detail = JSON.parse(fs.readFileSync(path.join(jobsDir, `${id}.json`), "utf8"));
  for (const record of [after, detail]) {
    assert.equal(record.workerLease, null); assert.equal(record.workerStopProof, "linux-lease-released");
    assert.equal(record.workerStopLeaseId, lease.id);
  }
  assert.equal(fs.existsSync(lease.path), false);
  assert.equal(fs.existsSync(lease.path.replace(/\.lease$/, ".binding")), false);
}
try {
  const stateApi = { resolveStateDir, migrateStateLock(cwd, options) {
    const marker = migrateStateLock(cwd, options), markerPath = path.join(stateDir, "state.lock", "protocol.json");
    const markerStat = fs.lstatSync(markerPath, { bigint: true }), stateStat = fs.lstatSync(stateDir, { bigint: true });
    const barrierStat = fs.lstatSync(path.dirname(markerPath), { bigint: true });
    assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink() && stateStat.isDirectory() && !stateStat.isSymbolicLink() && barrierStat.isDirectory() && !barrierStat.isSymbolicLink());
    const bytes = fs.readFileSync(markerPath), saved = JSON.parse(bytes.toString("utf8"));
    assert.equal(saved.epoch, marker.epoch); assert.deepEqual(saved.sentinel, marker.sentinel);
    migrationProof = { epoch: marker.epoch, sentinel: marker.sentinel, markerDev: markerStat.dev, markerIno: markerStat.ino,
      stateDev: stateStat.dev, stateIno: stateStat.ino, barrierDev: barrierStat.dev, barrierIno: barrierStat.ino, markerBytes: bytes };
    return marker;
  } };
  const brokerApi = { ensureBrokerSession(cwd, options) {
    return ensureBrokerSession(cwd, { ...options, timeoutMs: remaining(workDeadline, 4500) });
  } };
  const started = await startFixtureBroker(workspace, env, endpoint, { state: stateApi, broker: brokerApi, onChild(child) {
    broker = child; brokerClosed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  } });
  env.GROK_COMPANION_BROKER_GENERATION = started.session.generation;
  const first = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", "--fresh", "establish broker history"],
    { env: { ...env, GROK_COMPANION_SESSION_ID: "resume-pin-session" }, encoding: "utf8", timeout: remaining(workDeadline, 30000) });
  assert.equal(first.error, undefined, first.error?.message); assert.equal(first.signal, null);
  assert.equal(first.status, 0, first.stderr);
  const pinnedId = JSON.parse(first.stdout).jobId;
  reclaim(pinnedId);
  // 50 件は履歴の保全対象としてのみ合成し、実 worker の証拠とは扱わない。
  const fillers = Array.from({ length: 50 }, (_, i) => ({ id: `synthetic-review-${i}`, jobClass: "review",
    status: "completed", createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
    sessionId: "synthetic-filler", logFile: path.join(jobsDir, `synthetic-review-${i}.log`) }));
  updateState(workspace, (state, context) => {
    for (const job of fillers) {
      job.epoch = context.epoch;
      fs.writeFileSync(job.logFile, `synthetic log ${job.id}\n`, { flag: "wx", mode: 0o600 });
      writeJobFile(workspace, job.id, job, context);
      state.jobs.push(job);
    }
  }, { timeoutMs: remaining(workDeadline, 30000) });
  const before = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const pinned = before.jobs.find(job => job.id === pinnedId);
  assert.equal(pinned?.grokTransport, "broker");
  assert.equal(pinned.grokBrokerGeneration, started.session.generation);
  assert.equal(pinned.workerStopProof, "linux-lease-released");
  const snapshot = file => { const s = fs.lstatSync(file, { bigint: true }); assert.ok(s.isFile() && !s.isSymbolicLink());
    return { dev: s.dev, ino: s.ino, bytes: fs.readFileSync(file) }; };
  const pinnedDetail = path.join(jobsDir, `${pinnedId}.json`), detailBytes = snapshot(pinnedDetail);
  assert.ok(pinned.logFile && fs.existsSync(pinned.logFile), "the original broker task log must exist");
  const logBytes = snapshot(pinned.logFile);
  const fillerEvidence = fillers.map(job => ({ job, detail: snapshot(path.join(jobsDir, `${job.id}.json`)), log: snapshot(job.logFile) }));
  const countPrompts = () => fs.readFileSync(env.SETTINGS_LOG, "utf8").split("\n").filter(line => line === "session/prompt").length;
  const priorPromptCount = countPrompts();
  assert.equal(priorPromptCount, 1, "the initial broker task must send exactly one prompt");
  resume = spawn(process.execPath, [command, "task", "--cwd", workspace, "--json", "--resume-last", "continue"],
    { env: { ...env, GROK_COMPANION_SESSION_ID: "resume-pin-session" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  resume.stdout.on("data", chunk => { stdout += chunk; }); resume.stderr.on("data", chunk => { stderr += chunk; });
  let resumeError = null; resume.once("error", error => { resumeError = error; });
  resumeClosed = new Promise(resolve => resume.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
  assert.ok(await waitUntil(() => fs.existsSync(ready) || resume.exitCode !== null, 20000), "resume did not reach session/load");
  assert.ok(fs.existsSync(ready), "broker agent must hold session/load");
  assert.equal(countPrompts(), priorPromptCount, "session/load must precede the resumed prompt");
  const replacementId = runTask("new-task", control ? "resume-control-other-session" : "resume-pin-session");
  assert.ok(replacementId && replacementId !== pinnedId);
  reclaim(replacementId);
  const after = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
  const replacement = after.find(job => job.id === replacementId);
  assert.equal(replacement?.status, "completed");
  assert.equal(replacement.grokTransport, "direct");
  assert.equal(replacement.taskSessionResumable, true);
  assert.notEqual(replacement.grokSessionId, pinned.grokSessionId);
  const replacementDetail = path.join(jobsDir, `${replacementId}.json`);
  assert.ok(replacement.logFile && fs.existsSync(replacement.logFile));
  const replacementDetailBytes = snapshot(replacementDetail), replacementLogBytes = snapshot(replacement.logFile);
  const latest = sortJobsNewestFirst(after.filter(job => job.sessionId === "resume-pin-session" && job.jobClass === "task" &&
    job.status === "completed" && job.taskSessionResumable !== false && job.grokSessionId));
  assert.equal(latest[0]?.id, control ? pinnedId : replacementId,
    "the latest candidate must reflect whether the new task shares the host session");
  function assertHistory(jobs) {
    assert.deepEqual(jobs.find(job => job.id === pinnedId), pinned);
    assert.deepEqual(snapshot(pinnedDetail), detailBytes);
    assert.deepEqual(snapshot(pinned.logFile), logBytes);
    assert.deepEqual(jobs.find(job => job.id === replacementId), replacement);
    assert.deepEqual(snapshot(replacementDetail), replacementDetailBytes);
    assert.deepEqual(snapshot(replacement.logFile), replacementLogBytes);
    for (const item of fillerEvidence) {
      assert.deepEqual(jobs.find(job => job.id === item.job.id), item.job);
      assert.deepEqual(snapshot(path.join(jobsDir, `${item.job.id}.json`)), item.detail);
      assert.deepEqual(snapshot(item.job.logFile), item.log);
    }
  }
  assertHistory(after);
  assert.equal(countPrompts(), priorPromptCount, "the resumed prompt must remain unsent while load is gated");
  fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
  const completed = await closeWithin(resumeClosed, "resume", workDeadline);
  assert.equal(resumeError, null, resumeError?.message);
  assert.equal(completed.signal, null);
  if (control) {
    assert.equal(completed.code, 0, `${completed.stderr}\n${completed.stdout}`);
    assert.equal(countPrompts(), priorPromptCount + 1, "unchanged resume must send exactly one broker prompt");
  } else {
    assert.equal(completed.code, 1, `${completed.stderr}\n${completed.stdout}`);
    const result = JSON.parse(completed.stdout);
    assert.equal(result.status, "failed");
    assert.equal(typeof result.jobId, "string");
    const indexed = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === result.jobId);
    const stored = JSON.parse(fs.readFileSync(path.join(jobsDir, `${result.jobId}.json`), "utf8"));
    const reason = `Task ${pinnedId} is not a verified broker resume candidate.`;
    for (const record of [indexed, stored]) {
      assert.equal(record.status, "failed");
      assert.equal(record.grokPromptState, "not-sent");
      assert.equal(record.summary, reason);
    }
    assert.equal(stored.rendered.trim(), reason);
    assert.equal(countPrompts(), priorPromptCount, "a stale resume must not send another broker prompt");
  }
  assertHistory(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs);
  assert.match(fs.readFileSync(env.SETTINGS_LOG, "utf8"), /(?:^|\n)session\/load(?:\n|$)/);
  safeToStopSentinel = true;
} catch (error) { mainError = error; }
const cleanupErrors = [];
try {
  if (resume && resume.exitCode === null && resume.signalCode === null) {
    if (!fs.existsSync(release)) fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
    if (!await waitUntil(() => resume.exitCode !== null || resume.signalCode !== null, 8000, processCleanupDeadline)) resume.kill("SIGTERM");
  }
  if (resume && !await waitUntil(() => resume.exitCode !== null || resume.signalCode !== null, 8000, processCleanupDeadline)) throw new Error("resume exit is unconfirmed");
  if (resumeClosed) await closeWithin(resumeClosed, "resume", processCleanupDeadline);
} catch (error) { cleanupErrors.push(error); }
try {
  if (!broker || !Number.isSafeInteger(broker.pid) || broker.pid <= 0) throw new Error("broker spawn ownership is unconfirmed");
  {
    if (broker.exitCode === null && broker.signalCode === null) {
      try { await sendBrokerShutdown(endpoint, remaining(processCleanupDeadline, 5000)); } catch { /* 確認できなければ fixture を保持する。 */ }
    }
    if (!await waitUntil(() => broker.exitCode !== null || broker.signalCode !== null, 8000, processCleanupDeadline)) broker.kill("SIGTERM");
    if (!await waitUntil(() => broker.exitCode !== null || broker.signalCode !== null, 8000, processCleanupDeadline)) throw new Error("broker exit is unconfirmed");
    if (brokerClosed) await closeWithin(brokerClosed, "broker", processCleanupDeadline);
    const groupGone = () => { try { process.kill(-broker.pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } };
    if (!await waitUntil(groupGone, 8000, processCleanupDeadline)) throw new Error("broker process group exit is unconfirmed");
  }
} catch (error) { cleanupErrors.push(error); }
try {
  const agentStopped = !fs.existsSync(env.SETTINGS_LOG) || await waitUntil(() => fs.existsSync(brokerExit), 8000, processCleanupDeadline);
  if (!directStopped || !agentStopped || cleanupErrors.length) throw new Error("worker, agent, broker, or resume exit is unconfirmed");
  if (!migrationProof) throw new Error("migration ownership is unconfirmed");
  const currentRoot = fs.lstatSync(root, { bigint: true });
  assert.ok(currentRoot.isDirectory() && !currentRoot.isSymbolicLink() && fs.realpathSync(root) === root);
  assert.equal(currentRoot.dev, rootStat.dev); assert.equal(currentRoot.ino, rootStat.ino);
  const markerPath = path.join(stateDir, "state.lock", "protocol.json");
  const markerBytes = fs.readFileSync(markerPath), markerStat = fs.lstatSync(markerPath, { bigint: true });
  assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink());
  const marker = JSON.parse(markerBytes.toString("utf8"));
  const stateStat = fs.lstatSync(stateDir, { bigint: true });
  const barrierStat = fs.lstatSync(path.dirname(markerPath), { bigint: true });
  assert.ok(stateStat.isDirectory() && !stateStat.isSymbolicLink());
  assert.equal(stateStat.dev, migrationProof.stateDev); assert.equal(stateStat.ino, migrationProof.stateIno);
  assert.ok(barrierStat.isDirectory() && !barrierStat.isSymbolicLink());
  assert.equal(barrierStat.dev, migrationProof.barrierDev); assert.equal(barrierStat.ino, migrationProof.barrierIno);
  assert.equal(markerStat.dev, migrationProof.markerDev); assert.equal(markerStat.ino, migrationProof.markerIno);
  assert.deepEqual(markerBytes, migrationProof.markerBytes);
  assert.equal(marker.epoch, migrationProof.epoch); assert.deepEqual(marker.sentinel, migrationProof.sentinel);
  if (cleanupDeadline - performance.now() < sentinelStopReserveMs) throw new Error("sentinel shutdown budget is unavailable; fixture retained");
  const stopped = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
  assert.equal(stopped.stopped, true); assert.equal(stopped.stateDir, stateDir); assert.equal(stopped.epoch, marker.epoch);
  assert.deepEqual(fs.readFileSync(markerPath), markerBytes);
  const markerAfter = fs.lstatSync(markerPath, { bigint: true });
  assert.equal(markerAfter.dev, markerStat.dev); assert.equal(markerAfter.ino, markerStat.ino);
  if (safeToStopSentinel && !mainError) console.log(JSON.stringify({ kind: "history-resume-stopped-v1", root,
    rootDev: String(rootStat.dev), rootIno: String(rootStat.ino), stateDir, epoch: marker.epoch,
    markerDev: String(markerStat.dev), markerIno: String(markerStat.ino), markerSha256: createHash("sha256").update(markerBytes).digest("hex"),
    resumeStopped: true, brokerGroupStopped: true, brokerAgentStopped: true, directGroupStopped: true, sentinelStopped: true }));
} catch (error) { cleanupErrors.push(error); }
if (mainError || cleanupErrors.length || !safeToStopSentinel) {
  process.stderr.write(`History resume fixture retained: ${root}\n`);
  throw new AggregateError([...(mainError ? [mainError] : []), ...cleanupErrors], "History resume test or cleanup failed");
}
