import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { startFixtureBroker } from "./broker-fixture-helper.mjs";
import { createBrokerEndpoint } from "../plugins/grok/scripts/lib/broker-endpoint.mjs";
import { sendBrokerShutdown } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { migrateStateLock, resolveStateDir, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { reserveLinuxTrackedJob } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { releaseLinuxWorkerLease, validateOwnedLinuxWorkerLease, withAvailableLinuxLease } from "../plugins/grok/scripts/lib/linux-worker-lease.mjs";
import { verifyPublishedLinuxLeaseRecords } from "../plugins/grok/scripts/lib/linux-lease-ledger.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { fileURLToPath } from "node:url";
import { fixture as resumeFixture, stopFixtureChild, until } from "./cancel-repair-fixture.mjs";
import { initGitRepo } from "./helpers.mjs";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { createLinuxEpochRecovery } from "../plugins/grok/scripts/lib/linux-epoch-recovery.mjs";
import { updateState, readJobFile, resolveJobFile, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";

// 実装と同じ private な通常ファイルとして旧 epoch の fixture を作る。
function writePrivate(file, value) {
  fs.writeFileSync(file, value, { mode: 0o600 });
  const stat = fs.lstatSync(file);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o077, 0);
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.nlink, 1);
}

// 先行失敗条件: 旧・欠落・不一致 epoch の cancel/SessionEnd が原本を変更、
// resume が旧 session を選択、旧 gate の pending 判定を新ターンへ継承する。
test("Linux command and hook entries preserve prior epoch records", { skip: process.platform !== "linux" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-entry-epoch-"));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(workspace); fs.mkdirSync(data);
  const previous = { claude: process.env.CLAUDE_PLUGIN_DATA, plugin: process.env.PLUGIN_DATA };
  process.env.CLAUDE_PLUGIN_DATA = data; process.env.PLUGIN_DATA = data;
  const stateDir = resolveStateDir(workspace);
  let migrated = false, childUnconfirmed = false;
  t.after(() => {
    try {
      if (!migrated) { t.diagnostic(`Retained unconfirmed sentinel fixture: ${root}`); return; }
      if (childUnconfirmed) { t.diagnostic(`Retained fixture with unconfirmed child exit: ${root}`); return; }
      assert.equal(shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir }).stopped, true);
    } finally {
      if (previous.claude === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous.claude;
      if (previous.plugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previous.plugin;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { epoch } = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  migrated = true;
  const jobsDir = path.join(stateDir, "jobs"), stateFile = path.join(stateDir, "state.json");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  const command = path.resolve("plugins/grok/scripts/grok-companion.mjs");
  const sessionHook = path.resolve("plugins/grok/scripts/session-lifecycle-hook.mjs");
  const gateHook = path.resolve("plugins/grok/scripts/stop-review-gate-hook.mjs");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_SESSION_ID: "session" };
  delete env.GROK_COMPANION_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  const run = (script, args, input) => spawnSync(process.execPath, [script, ...args], { cwd: workspace, env, input, encoding: "utf8", timeout: 15000 });
  const detail = job => path.join(jobsDir, `${job.id}.json`);
  const base = { id: "old-active", sessionId: "session", jobClass: "task", status: "queued", createdAt: "2000-01-01T00:00:00.000Z", grokPromptState: "not-sent", epoch: randomUUID() };
  for (const variant of ["old", "missing", "mismatch"]) {
    const indexed = { ...base, id: `active-${variant}` };
    if (variant === "missing") delete indexed.epoch;
    if (variant === "mismatch") indexed.epoch = epoch;
    const stored = { ...indexed, ...(variant === "mismatch" ? { epoch: randomUUID() } : {}) };
    writePrivate(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [indexed], reviewGateSessions: [] }));
    writePrivate(detail(indexed), JSON.stringify(stored));
    const before = fs.readFileSync(stateFile, "utf8"), beforeDetail = fs.readFileSync(detail(indexed), "utf8");
    const cancel = run(command, ["cancel", indexed.id, "--cwd", workspace]);
    t.diagnostic(`cancel ${variant}: status=${cancel.status}; stdout=${JSON.stringify(cancel.stdout)}; stderr=${JSON.stringify(cancel.stderr)}; stateChanged=${fs.readFileSync(stateFile, "utf8") !== before}; detailChanged=${fs.readFileSync(detail(indexed), "utf8") !== beforeDetail}`);
    assert.notEqual(cancel.status, 0, `cancel ${variant} must refuse`);
    assert.equal(fs.readFileSync(stateFile, "utf8"), before);
    assert.equal(fs.readFileSync(detail(indexed), "utf8"), beforeDetail);
    const end = run(sessionHook, ["SessionEnd"], JSON.stringify({ cwd: workspace, session_id: "session" }));
    assert.equal(end.status, 0, end.stderr);
    assert.equal(fs.readFileSync(stateFile, "utf8"), before);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs, [indexed]);
    assert.equal(fs.readFileSync(detail(indexed), "utf8"), beforeDetail);
  }
  // 実際に接続できる broker endpoint を置き、旧 job による接続自体を観測する。
  let connections = 0;
  const socketPath = path.join(root, "broker.sock");
  const server = net.createServer(socket => { connections++; socket.destroy(); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await new Promise((resolve, reject) => { const probe = net.connect(socketPath); probe.once("connect", () => { probe.destroy(); resolve(); }); probe.once("error", reject); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connections, 1);
  env.GROK_COMPANION_ACP_ENDPOINT = `unix:${socketPath}`;
  const oldBroker = { ...base, id: "old-broker", status: "running", pid: 2147483647,
    processStartKey: `${randomUUID()}:1`, grokTransport: "broker", grokBrokerGeneration: randomUUID(),
    grokSessionId: "old-broker-session", grokPromptState: "pending" };
  writePrivate(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [oldBroker], reviewGateSessions: [] }));
  writePrivate(detail(oldBroker), JSON.stringify(oldBroker));
  const runAsync = (script, args, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", data => { stderr += data; }); child.stdout.resume();
    child.once("error", reject); child.once("close", status => resolve({ status, stderr })); child.stdin.end(input);
  });
  try {
    const cancel = await runAsync(command, ["cancel", oldBroker.id, "--cwd", workspace]);
    assert.notEqual(cancel.status, 0);
    const end = await runAsync(sessionHook, ["SessionEnd"], JSON.stringify({ cwd: workspace, session_id: "session" }));
    assert.equal(end.status, 0, end.stderr);
    const barrier = new Promise(resolve => server.once("connection", resolve));
    await new Promise((resolve, reject) => { const probe = net.connect(socketPath); probe.once("connect", () => { probe.destroy(); resolve(); }); probe.once("error", reject); });
    await barrier;
    assert.equal(connections, 2, "old job must not connect to the broker");
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs, [oldBroker]);
    assert.deepEqual(JSON.parse(fs.readFileSync(detail(oldBroker), "utf8")), oldBroker);
  } finally {
    delete env.GROK_COMPANION_ACP_ENDPOINT;
    await new Promise(resolve => server.close(resolve));
  }
  const current = { ...base, id: "current-queued", workspaceRoot: workspace };
  writePrivate(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [], reviewGateSessions: [] }));
  const reservation = reserveLinuxTrackedJob(current);
  let inspectionFailed = true;
  try {
    withStateSnapshot(workspace, (state, context) => {
      const indexed = state.jobs.find(job => job.id === current.id);
      const stored = JSON.parse(fs.readFileSync(detail(current), "utf8"));
      assert.equal(context.epoch, epoch);
      assert.equal(indexed.epoch, epoch);
      assert.equal(stored.epoch, epoch);
      assert.equal(indexed.claimToken, reservation.claimToken);
      assert.equal(stored.claimToken, reservation.claimToken);
      assert.equal(indexed.workerLease.id, reservation.lease.id);
      assert.equal(stored.workerLease.id, reservation.lease.id);
      validateOwnedLinuxWorkerLease({ owner: reservation.owner, lease: reservation.lease, context, claimToken: reservation.claimToken });
      verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: reservation.lease });
    });
    inspectionFailed = false;
  } finally {
    const released = releaseLinuxWorkerLease(reservation.owner);
    if (!released) childUnconfirmed = true;
    if (!inspectionFailed) assert.equal(released, true, "fixture releases its owned worker lease");
  }
  const currentCancel = run(command, ["cancel", current.id, "--json", "--cwd", workspace]);
  if (currentCancel.status === null) childUnconfirmed = true;
  assert.notEqual(currentCancel.status, null, "cancellation CLI must exit");
  assert.equal(currentCancel.status, 0, currentCancel.stderr);
  const cancellation = JSON.parse(currentCancel.stdout);
  assert.equal(cancellation.status, "cancelled");
  assert.equal(cancellation.workerStopConfirmed, true);
  assert.equal(cancellation.turnStopConfirmed, true);
  const currentIndex = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === current.id);
  const currentDetail = JSON.parse(fs.readFileSync(detail(current), "utf8"));
  for (const record of [currentIndex, currentDetail]) {
    assert.equal(record.status, "cancelled");
    assert.equal(record.terminationPending, false);
    assert.equal(record.workerStopProof, "linux-lease-released");
    assert.equal(record.workerStopLeaseId, reservation.lease.id);
    assert.equal(record.epoch, epoch);
  }
  const fake = installFakeGrok({ replies: [{ text: "first" }, { text: "resumed" }] });
  const endpoint = createBrokerEndpoint(fake.binDir);
  const brokerEnv = { ...env, GROK_BIN: fake.env.GROK_BIN, FAKE_GROK_SCENARIO: fake.env.FAKE_GROK_SCENARIO,
    FAKE_GROK_STATE: fake.env.FAKE_GROK_STATE, XAI_API_KEY: "fake-key-for-tests", GROK_COMPANION_DISABLE_BROKER: "0",
    GROK_COMPANION_ACP_ENDPOINT: endpoint, TMPDIR: fake.binDir, TMP: fake.binDir, TEMP: fake.binDir };
  writePrivate(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [currentIndex], reviewGateSessions: [] }));
  childUnconfirmed = true;
  const { child: broker, exited, session } = await startFixtureBroker(workspace, brokerEnv, endpoint,
    { state: { migrateStateLock: () => {}, resolveStateDir } });
  brokerEnv.GROK_COMPANION_BROKER_GENERATION = session.generation;
  let taskUnconfirmed = false;
  try {
    const invoke = args => spawnSync(process.execPath, [command, ...args], { cwd: workspace, env: brokerEnv, encoding: "utf8", timeout: 15000 });
    const first = invoke(["task", "--json", "--cwd", workspace, "start work"]);
    if (first.status === null) { taskUnconfirmed = true; throw new Error("Initial task did not exit; fixture retained."); }
    assert.equal(first.status, 0, first.stderr);
    const firstJobId = JSON.parse(first.stdout).jobId;
    assert.ok(firstJobId, "completed task must report its job id");
    const firstJob = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === firstJobId);
    assert.ok(firstJob, "completed task must be present in the state index");
    const firstDetail = JSON.parse(fs.readFileSync(detail(firstJob), "utf8"));
    for (const record of [firstJob, firstDetail]) {
      assert.equal(record.epoch, epoch);
      assert.equal(record.status, "completed");
      assert.equal(record.grokTransport, "broker");
      assert.equal(record.grokBrokerGeneration, session.generation);
      assert.equal(record.grokPromptState, "terminal");
      assert.equal(record.terminationPending, false);
      assert.equal(record.taskSessionResumable, true);
      assert.ok(record.grokSessionId && record.workerLease?.id);
    }
    assert.equal(firstDetail.grokSessionId, firstJob.grokSessionId);
    assert.deepEqual(firstDetail.workerLease, firstJob.workerLease);
    assert.equal(fake.readState()?.prompts.length, 1, "the completed candidate must have sent a real broker prompt");
    withStateSnapshot(workspace, (state, context) => {
      const indexed = state.jobs.find(job => job.id === firstJobId);
      const released = withAvailableLinuxLease(indexed.workerLease, context, () => {
        verifyPublishedLinuxLeaseRecords({ context, indexed, stored: firstDetail, lease: indexed.workerLease });
        return true;
      });
      assert.equal(released.status, "available", "candidate worker lease must be released");
    });
    const currentCandidate = run(command, ["task-resume-candidate", "--json", "--cwd", workspace]);
    assert.equal(currentCandidate.status, 0, currentCandidate.stderr);
    const candidate = JSON.parse(currentCandidate.stdout);
    assert.equal(candidate.available, true);
    assert.equal(candidate.candidate.id, firstJobId);
    assert.equal(candidate.candidate.grokSessionId, firstJob.grokSessionId);
    const resumed = invoke(["task", "--resume", "--json", "--cwd", workspace, "continue"]);
    if (resumed.status === null) { taskUnconfirmed = true; throw new Error("Resume task did not exit; fixture retained."); }
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.deepEqual(fake.readState()?.loads, [firstJob.grokSessionId]);
  } finally {
    if (broker.exitCode === null && broker.signalCode === null) await sendBrokerShutdown(endpoint);
    const stopped = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
    if (stopped) {
      childUnconfirmed = taskUnconfirmed;
      assert.equal(stopped.code, 0, `Broker exit: ${JSON.stringify(stopped)}`);
      if (!taskUnconfirmed) fs.rmSync(fake.binDir, { recursive: true, force: true });
    } else t.diagnostic(`Retained live broker fixture: ${fake.binDir}`);
  }
  // セッション ID がある場合、旧 epoch のみなら hostless session/list へ進まない。
  env.GROK_COMPANION_SESSION_ID = "session";
  const oldTask = { ...base, id: "old-terminal", status: "completed", grokSessionId: "old-session", taskSessionResumable: true };
  writePrivate(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [oldTask, currentIndex], reviewGateSessions: [] }));
  writePrivate(detail(oldTask), JSON.stringify(oldTask));
  const candidate = run(command, ["task-resume-candidate", "--json", "--cwd", workspace]);
  assert.equal(candidate.status, 0, candidate.stderr);
  const candidatePayload = JSON.parse(candidate.stdout);
  assert.equal(candidatePayload.sessionId, "session");
  assert.equal(candidatePayload.available, false);
  assert.equal(candidatePayload.candidate, null);
  const invocation = path.join(root, "grok-invoked"), fakeGrok = path.join(root, "fake-grok");
  fs.writeFileSync(fakeGrok, '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.FAKE_INVOCATION, "called\\n");\nprocess.exit(1);\n', { mode: 0o700 });
  env.GROK_BIN = fakeGrok; env.FAKE_INVOCATION = invocation;
  const resume = run(command, ["task", "--resume", "--cwd", workspace]);
  assert.notEqual(resume.status, 0);
  assert.match(resume.stderr, /No previous Grok task thread/);
  assert.equal(fs.existsSync(invocation), false, "old session fallback must not start Grok");
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.id === oldTask.id), oldTask);
  assert.deepEqual(JSON.parse(fs.readFileSync(detail(oldTask), "utf8")), oldTask);
  delete env.GROK_BIN; delete env.FAKE_INVOCATION; delete env.GROK_COMPANION_SESSION_ID;
  const gate = { sessionId: "session", epoch: randomUUID(), turnKey: "old", baselineNonce: "old", pendingReason: "stale blocker", retryWithoutChanges: true };
  writePrivate(stateFile, JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [currentIndex], reviewGateSessions: [gate] }));
  const prompt = run(gateHook, [], JSON.stringify({ cwd: workspace, session_id: "session", hook_event_name: "UserPromptSubmit", turn_id: "new" }));
  assert.equal(prompt.status, 0, prompt.stderr);
  const gates = JSON.parse(fs.readFileSync(stateFile, "utf8")).reviewGateSessions;
  assert.deepEqual(gates.find(x => x.epoch === gate.epoch), gate);
  const nextGate = gates.find(x => x.sessionId === "session" && x.epoch === epoch);
  assert.equal(nextGate.epoch, epoch);
  assert.equal(nextGate.pendingReason, null);
  assert.equal(nextGate.retryWithoutChanges, false);
});

for (const variant of ["current direct", "current broker candidate with different execution", "current malformed direct", "old direct"]) {
  test(`Linux resume rejects ${variant} despite another broker terminal for the same session`,
    { skip: process.platform !== "linux", timeout: 60000 }, async t => {
      const sessionId = "session-1";
      const f = await resumeFixture(t, { CANCEL_LIST_SESSIONS: JSON.stringify([
        { sessionId, title: "Grok Companion Task existing conversation" }
      ]) });
      initGitRepo(f.cwd);
      fs.writeFileSync(f.env.CANCEL_REVIEW_GATE, "release");
      const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
      const env = { ...f.env, GROK_COMPANION_SESSION_ID: "", CODEX_THREAD_ID: "" };
      const cli = (args, overrides = {}) => spawnSync(process.execPath, [command, ...args], {
        cwd: f.cwd, env: { ...env, ...overrides }, encoding: "utf8", timeout: 20000
      });
      const direct = cli(["task", "--json", "establish direct candidate"], {
        GROK_COMPANION_DISABLE_BROKER: "1", GROK_COMPANION_ACP_ENDPOINT: ""
      });
      assert.equal(direct.status, 0, direct.stderr);
      const task = JSON.parse(direct.stdout);
      assert.equal(task.grokSessionId, sessionId);
      const readBoth = () => withStateSnapshot(f.cwd, (state) => [
        state.jobs.find(job => job.id === task.jobId), readJobFile(resolveJobFile(f.cwd, task.jobId))
      ]);
      const original = readBoth();
      let oldEpoch;
      withStateSnapshot(f.cwd, (_state, context) => {
        oldEpoch = context.epoch;
        for (const entry of original) {
          assert.equal(entry.epoch, oldEpoch);
          assert.equal(entry.status, "completed");
          assert.equal(entry.grokTransport, "direct");
          assert.equal(entry.grokSessionId, sessionId);
          assert.equal(entry.grokPromptState, "terminal");
          assert.equal(entry.terminationPending, false);
          assert.equal(entry.taskSessionResumable, true);
          assert.equal(entry.grokDirectStopKind, "posix-group-empty");
          assert.ok(entry.grokDirectGeneration && entry.grokDirectStopConfirmedAt);
          assert.equal(entry.grokDirectStopGeneration, entry.grokDirectGeneration);
          assert.equal(entry.grokDirectOwnerStartKey, entry.processStartKey);
        }
        verifyPublishedLinuxLeaseRecords({ context, indexed: original[0], stored: original[1], lease: original[0].workerLease });
        assert.equal(withAvailableLinuxLease(original[0].workerLease, context, () => true).status, "available");
      });
      if (variant === "current malformed direct" || variant === "current broker candidate with different execution") {
        updateState(f.cwd, (state, context) => {
          const indexed = state.jobs.find(job => job.id === task.jobId);
          const stored = readJobFile(resolveJobFile(f.cwd, task.jobId));
          verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
          const released = withAvailableLinuxLease(indexed.workerLease, context, () => {
            // 整合するが候補自身の broker terminal を持たない保存記録を模擬する。
            const patch = variant === "current malformed direct" ? { grokDirectStopKind: null } : {
              grokTransport: "broker", grokBrokerGeneration: f.brokerIdentity.brokerGeneration,
              grokDirectGeneration: null, grokDirectStopGeneration: null, grokDirectStopKind: null,
              grokDirectStopConfirmedAt: null, grokDirectOwnerPid: null, grokDirectOwnerStartKey: null
            };
            writeJobFile(f.cwd, task.jobId, { ...stored, ...patch }, context);
            Object.assign(indexed, patch);
          });
          assert.equal(released.status, "available");
        });
      }
      const evidence = readBoth();
      const checkStopped = async (child, agentPids, label) => {
        assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
        await until(() => {
          const ps = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
          assert.equal(ps.status, 0, ps.stderr);
          return !ps.stdout.split("\n").map(line => line.trim().split(/\s+/)).some(([pid, pgid, stat]) =>
            stat && !stat.startsWith("Z") && (Number(pid) === child.pid || agentPids.has(Number(pid)) || Number(pgid) === child.pid));
        }, label, 5000);
      };
      let endpoint = f.env.GROK_COMPANION_ACP_ENDPOINT, generation = f.brokerIdentity.brokerGeneration;
      let nextChild, nextExit, nextSession;
      const initialPids = new Set(f.logs().map(row => row.started).filter(pid => Number.isSafeInteger(pid) && pid > 0));
      assert.ok(initialPids.size >= 2, "the broker and direct fake agents must both have started");
      f.cleanup(async () => {
        if (!nextChild) return;
        let clean = false;
        try {
          if (!nextSession) throw new Error("replacement broker identity is unavailable");
          if (nextChild.exitCode === null && nextChild.signalCode === null) {
            const control = await GrokAcpClient.connect(f.cwd, { env: f.env, brokerEndpoint: nextSession.endpoint, brokerOnly: true });
            try { await control.request("broker/shutdown", {}, { signal: AbortSignal.timeout(5000) }); }
            finally { await control.close(); }
          }
          await nextExit;
          assert.equal(nextChild.exitCode, 0);
          const agentPids = new Set(f.logs().map(row => row.started).filter(pid => Number.isSafeInteger(pid) && pid > 0 && !initialPids.has(pid)));
          assert.ok(agentPids.size > 0);
          await checkStopped(nextChild, agentPids, "replacement broker and agent stopped");
          clean = true;
        } finally {
          if (!clean && nextChild.exitCode === null && nextChild.signalCode === null) await stopFixtureChild(nextChild);
        }
      });
      if (variant === "old direct") {
        await f.stopBroker();
        await checkStopped(f.brokerChild, initialPids, "prior broker and direct agents stopped");
        const stateDir = resolveStateDir(f.cwd);
        assert.equal(shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir }).stopped, true);
        const barrier = path.join(stateDir, "state.lock"), preserved = path.join(f.cwd, "prior-state-lock");
        const prior = fs.lstatSync(barrier, { bigint: true });
        assert.ok(prior.isDirectory() && !prior.isSymbolicLink());
        assert.equal(fs.existsSync(preserved), false);
        fs.renameSync(barrier, preserved);
        const kept = fs.lstatSync(preserved, { bigint: true });
        assert.equal(kept.dev, prior.dev); assert.equal(kept.ino, prior.ino);
        migrateStateLock(f.cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
        withStateSnapshot(f.cwd, (_state, context) => {
          assert.notEqual(context.epoch, oldEpoch);
          createLinuxEpochRecovery(context, { offlineConfirmed: true, localOnly: true,
            allOldProcessesStopped: true, expectedStateDir: stateDir });
        });
        assert.deepEqual(readBoth(), evidence);
        endpoint = "unix:" + path.join(f.cwd, "next-broker.sock");
        const next = await startFixtureBroker(f.cwd, f.env, endpoint, { onChild(child) {
          nextChild = child;
          nextExit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
        } });
        nextSession = next.session;
        generation = nextSession.generation;
        assert.notEqual(generation, f.brokerIdentity.brokerGeneration);
      }
      const broker = await GrokAcpClient.connect(f.cwd, { env: f.env, brokerEndpoint: endpoint, brokerOnly: true });
      const otherExecution = "unrelated-terminal-execution";
      assert.notEqual(otherExecution, task.jobId);
      try {
        assert.equal((await broker.request("session/prompt", { sessionId, executionId: otherExecution,
          prompt: [{ type: "text", text: JSON.stringify({ name: "unrelated-terminal" }) }] })).stopReason, "end_turn");
        const terminal = await broker.request("broker/cancelTurn", { sessionId, executionId: otherExecution, generation });
        assert.equal(terminal.executionState, "terminal");
        assert.equal(terminal.notificationSent, false);
        const candidate = await broker.request("broker/cancelTurn", { sessionId, executionId: task.jobId, generation });
        assert.equal(candidate.executionState, "never-accepted");
        assert.equal(candidate.notificationSent, false);
      } finally { await broker.close(); }
      const before = f.logs().length;
      const resumed = cli(["task", "--resume-last", "--json", "must not resume"], {
        GROK_COMPANION_ACP_ENDPOINT: endpoint, GROK_COMPANION_BROKER_GENERATION: generation
      });
      const later = f.logs().slice(before);
      t.diagnostic(`resume ${variant}: status=${resumed.status}; stderr=${JSON.stringify(resumed.stderr)}; effects=${JSON.stringify(later.filter(row => row.loadedSession || row.prompt))}`);
      assert.equal(resumed.status, 1, "another execution's terminal must not authorize this candidate");
      assert.match(resumed.stderr, /resume|session|history|terminal|evidence|unverified|direct/i);
      assert.deepEqual(later.filter(row => row.loadedSession || row.prompt), [], "the agent must not load or prompt");
      assert.deepEqual(readBoth(), evidence, "candidate records must remain unchanged");
    });
}
