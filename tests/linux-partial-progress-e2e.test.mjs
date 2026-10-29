import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { loadState, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir, updateState, withStateSnapshot, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { makeTempDir, initGitRepo } from "./helpers.mjs";
import { fixture, until } from "./cancel-repair-fixture.mjs";
import { withAvailableLinuxLease } from "../plugins/grok/scripts/lib/linux-worker-lease.mjs";

function waitForMessage(child, expected) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("close", onClose);
      child.off("error", onError);
      if (error) reject(error); else resolve(value);
    };
    const onMessage = value => {
      if (value?.type === "worker-error") return finish(new Error(value.message));
      if (value?.type !== expected) return finish(new Error(`unexpected worker message: ${JSON.stringify(value)}`));
      finish(null, value);
    };
    const onClose = (code, signal) => finish(new Error(`worker closed before ${expected}: code=${code} signal=${signal}`));
    const onError = error => finish(error);
    const timer = setTimeout(() => finish(new Error(`worker timed out before ${expected}`)), 12000);
    child.once("message", onMessage);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

function boundedClose(closed) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker close could not be confirmed")), 12000);
    closed.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

test("a repeated Linux progress event repairs a partially saved update before logging", { skip: process.platform !== "linux", timeout: 60000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const dataDir = makeTempDir("grok-partial-progress-state-");
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  delete process.env.PLUGIN_DATA;
  const workspace = makeTempDir("grok-partial-progress-workspace-");
  const stateDir = resolveStateDir(workspace);
  let migration, child, closed, closeResult;
  t.after(async () => {
    try {
      if (child && !closeResult) {
        if (child.connected) child.send("abort");
        try { closeResult = await boundedClose(closed); }
        catch (error) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          throw new Error(`Worker termination unconfirmed; fixture retained: ${dataDir}; ${workspace}`, { cause: error });
        }
      }
      if (child && closeResult?.signal) throw new Error(`Worker was signalled; fixture retained: ${dataDir}; ${workspace}`);
      if (migration) {
        const stopped = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
        assert.equal(stopped.stopped, true);
        assert.equal(stopped.epoch, migration.epoch);
      } else t.diagnostic(`Incomplete migration fixture retained: ${dataDir}; ${workspace}`);
      t.diagnostic(`Isolated fixture retained: ${dataDir}; ${workspace}`);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  migration = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const job = { id: "partial-progress", workspaceRoot: workspace, title: "Review", jobClass: "review" };
  child = fork(new URL("./fixtures/linux-partial-progress-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  const starting = waitForMessage(child, "started");
  child.send(job);
  const started = await starting;
  assert.equal(started.pid, child.pid);
  assert.ok(started.startKey);
  assert.equal(started.epoch, migration.epoch);
  const failing = waitForMessage(child, "first-failed");
  child.send("first");
  assert.deepEqual(await failing, { type: "first-failed", code: "EIO", injected: 1, outcome: "unknown" });
  const detail = resolveJobFile(workspace, job.id);
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).phase, "starting");
  assert.equal(readJobFile(detail).phase, "running");
  assert.equal(fs.readFileSync(started.logFile, "utf8"), "");
  const retrying = waitForMessage(child, "retried");
  child.send("retry");
  await retrying;
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).phase, "running");
  assert.equal(readJobFile(detail).phase, "running");
  assert.match(fs.readFileSync(started.logFile, "utf8"), /progress retry/);
  assert.doesNotMatch(fs.readFileSync(started.logFile, "utf8"), /progress once/);
  child.send("finish");
  closeResult = await boundedClose(closed);
  assert.deepEqual(closeResult, { code: 0, signal: null });
});


for (const fault of ["index", "log"]) {
  test(`unsent broker resume retains safe task evidence after final ${fault} EIO`, { skip: process.platform !== "linux", timeout: 60000 }, async t => {
    const sessionId = "partial-resume-session";
    const f = await fixture(t, { CANCEL_LIST_SESSIONS: JSON.stringify([{ sessionId, title: "Grok Companion Task existing conversation" }]) });
    initGitRepo(f.cwd);
    fs.writeFileSync(f.env.CANCEL_REVIEW_GATE, "release");
    const owner = await f.connect();
    try {
      const executionId = "partial-resume-history";
      const terminal = await owner.request("session/prompt", { sessionId, executionId,
        prompt: [{ type: "text", text: JSON.stringify({ name: "partial-resume-seed" }) }] });
      assert.equal(terminal.stopReason, "end_turn");
      const proof = await owner.request("broker/cancelTurn", { sessionId, executionId, generation: f.brokerIdentity.brokerGeneration });
      assert.equal(proof.generation, f.brokerIdentity.brokerGeneration);
      assert.equal(proof.executionState, "terminal");
      assert.equal(proof.notificationSent, false);
    } finally { await owner.close(); }
    const stateDir = fs.realpathSync(resolveStateDir(f.cwd));
    const companion = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
    const preload = new URL("./fixtures/linux-partial-progress-worker.mjs", import.meta.url).href;
    const entered = path.join(f.cwd, "partial-resume-entered"), release = path.join(f.cwd, "partial-resume-release");
    const passed = path.join(f.cwd, "partial-resume-passed"), faulted = path.join(f.cwd, "partial-resume-faulted");
    let child, closed, closeResult, stdout = "", stderr = "";
    f.cleanup(async () => {
      fs.writeFileSync(release, "release");
      if (!child) return;
      if (!closeResult) {
        try { closeResult = await boundedClose(closed); }
        catch (error) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          throw new Error(`Partial resume worker termination unconfirmed; fixture retained: ${f.cwd}`, { cause: error });
        }
      }
      if (closeResult.signal) throw new Error(`Partial resume worker was signalled; fixture retained: ${f.cwd}`);
    });
    const before = f.logs().length;
    child = fork(companion, ["task", "--resume-last", "--json", "continue existing conversation"], {
      cwd: f.cwd, execArgv: ["--import", preload], windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...f.env, GROK_COMPANION_SESSION_ID: "", CODEX_THREAD_ID: "", PARTIAL_RESUME_FAULT: fault,
        PARTIAL_RESUME_MAIN: companion, PARTIAL_RESUME_STATE_DIR: stateDir, PARTIAL_RESUME_SESSION: sessionId,
        PARTIAL_RESUME_ENTERED: entered, PARTIAL_RESUME_RELEASE: release, PARTIAL_RESUME_PASSED: passed, PARTIAL_RESUME_FAULTED: faulted }
    });
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => { closeResult = { code, signal }; resolve(closeResult); });
    });
    void closed.catch(() => {});
    await until(() => fs.existsSync(entered) || closeResult, "partial resume pending-save gate", 8000);
    assert.ok(fs.existsSync(entered), `worker did not enter the post-save gate: ${JSON.stringify(closeResult)} ${stderr}`);
    const gate = JSON.parse(fs.readFileSync(entered, "utf8"));
    assert.equal(gate.pid, child.pid);
    const current = () => [loadState(f.cwd).jobs.find(entry => entry.id === gate.id), readJobFile(resolveJobFile(f.cwd, gate.id))];
    const pending = current();
    for (const record of pending) {
      assert.equal(record.pid, child.pid);
      assert.equal(record.status, "running");
      assert.equal(record.grokSessionId, sessionId);
      assert.equal(record.grokPromptState, "pending");
      assert.equal(record.grokTransport, "broker");
      assert.equal(record.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
    }
    const beforeInjection = f.logs().slice(before);
    assert.ok(beforeInjection.some(row => row.loadedSession === sessionId), "real broker session/load must complete before prompt guard");
    assert.equal(beforeInjection.some(row => row.prompt), false);
    const conflictingId = "partial-conflicting-pending";
    updateState(f.cwd, (state, context) => {
      assert.ok(!state.jobs.some(entry => entry.id === conflictingId));
      const record = { id: conflictingId, epoch: context.epoch, status: "running", terminationPending: true,
        grokSessionId: sessionId, grokPromptState: "pending" };
      writeJobFile(f.cwd, conflictingId, record);
      state.jobs.push(record);
    });
    const conflict = [loadState(f.cwd).jobs.find(entry => entry.id === conflictingId), readJobFile(resolveJobFile(f.cwd, conflictingId))];
    for (const record of conflict) { assert.equal(record.grokSessionId, sessionId); assert.equal(record.grokPromptState, "pending"); }
    fs.writeFileSync(release, "release");
    closeResult = await boundedClose(closed);
    assert.deepEqual(closeResult, { code: 1, signal: null }, stderr);
    assert.ok(fs.existsSync(passed), "pending gate must be released without timing out");
    assert.ok(fs.existsSync(faulted), `expected ${fault} EIO was not injected: ${stderr}`);
    const injection = JSON.parse(fs.readFileSync(faulted, "utf8"));
    assert.equal(injection.kind, fault); assert.equal(injection.code, "EIO");
    if (fault === "log") assert.equal(injection.id, gate.id);
    assert.match(stderr, /injected final .*EIO/i, `the write failure must be visible: ${stdout} ${stderr}`);
    assert.doesNotMatch(stderr, /fixture gate timed out/i);
    assert.equal(f.logs().slice(before).some(row => row.prompt), false, "guard rejection must not send a prompt to the agent");
    const records = current();
    for (const record of records) {
      assert.ok(record);
      assert.equal(record.id, gate.id);
      assert.equal(record.taskSessionResumable, false);
      assert.notEqual(record.grokPromptState, "terminal", "unsent prompt must not be represented as terminal");
      assert.ok(["not-sent", "pending"].includes(record.grokPromptState));
      assert.ok(record.workerLease && record.claimToken);
    }
    assert.equal(records[0].claimToken, records[1].claimToken);
    assert.equal(records[0].workerLease.id, records[1].workerLease.id);
    if (fault === "log") {
      for (const record of records) {
        assert.equal(record.status, "failed");
        assert.equal(record.grokPromptState, "not-sent");
        assert.equal(record.terminationPending, false);
      }
    } else if (records[0].grokPromptState !== records[1].grokPromptState || records[0].status !== records[1].status) {
      assert.ok(records.some(record => record.grokPromptState === "pending" || record.terminationPending === true),
        "a partial index/detail update must retain unconfirmed evidence");
    }
    withStateSnapshot(f.cwd, (_state, context) => {
      assert.equal(withAvailableLinuxLease(records[0].workerLease, context, () => true).status, "available",
        "worker must have exited and released its lease before sentinel shutdown");
    });
    assert.deepEqual([loadState(f.cwd).jobs.find(entry => entry.id === conflictingId), readJobFile(resolveJobFile(f.cwd, conflictingId))], conflict);
  });
}
