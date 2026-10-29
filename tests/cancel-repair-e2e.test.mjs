import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { interruptGrokTurn, runGrokReview, runGrokTurn } from "../plugins/grok/scripts/lib/grok.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_CAPACITY_RPC_CODE, GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { createLinuxEpochRecovery } from "../plugins/grok/scripts/lib/linux-epoch-recovery.mjs";
import { startFixtureBroker } from "./broker-fixture-helper.mjs";
import { cleanupIdleBrokerSession, ensureBrokerSession } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { initGitRepo, removeTempFixture, run } from "./helpers.mjs";
import { fixture, pause, stopFixtureChild, until } from "./cancel-repair-fixture.mjs";
import { loadState, readJobFile, resolveJobFile, migrateStateLock, resolveNativeStateLockEndpoint, resolveStateDir, updateState, withStateSnapshot, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { withAvailableLinuxLease } from "../plugins/grok/scripts/lib/linux-worker-lease.mjs";
import { verifyPublishedLinuxLeaseRecords } from "../plugins/grok/scripts/lib/linux-lease-ledger.mjs";

const companion = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));

function prepareFixtureState(cwd, env) {
  if (!["win32", "linux", "darwin"].includes(process.platform)) return;
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  try {
    // ACPだけのfixtureには適用せず、この専用dataへ書くCLIの前だけ移行する。
    const stateDir = resolveStateDir(cwd);
    migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
    return process.platform === "win32" ? resolveNativeStateLockEndpoint(stateDir)
      : process.platform === "linux" ? stateDir : path.join(stateDir, "state.lock", "native.lock");
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

function readFixtureJobRecords(cwd, env, jobId) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = env.CLAUDE_PLUGIN_DATA;
  try {
    return [loadState(cwd).jobs.find(job => job.id === jobId), readJobFile(resolveJobFile(cwd, jobId))];
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

const prompt = (client, executionId, data) => client.request("session/prompt", {
  sessionId: "session-1", executionId, prompt: [{ type: "text", text: JSON.stringify(data) }]
});
const cancel = async (client, executionId) => {
  const generation = client.initializeResult?._meta?.grokBrokerGeneration;
  assert.equal(typeof generation, "string");
  assert.ok(generation);
  const result = await client.request("broker/cancelTurn", { sessionId: "session-1", executionId, generation });
  assert.equal(result.generation, generation);
  return result;
};

test("failed broker startup stops its fixture sentinel after owned processes exit", { skip: process.platform !== "linux" }, async (t) => {
  let fixtureRoot;
  await t.test("delayed agent initialization", async (child) => {
    await assert.rejects(fixture(child, { CANCEL_DELAY_INITIALIZE: "10000" }, root => { fixtureRoot = root; }), /Fixture broker did not start/);
    assert.ok(path.isAbsolute(fixtureRoot), "fixture root must be recorded");
    const events = fs.readFileSync(path.join(fixtureRoot, "agent.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(events.some(row => row.delayedInitialize === true), "agent must receive and delay initialize");
  });
  assert.ok(path.isAbsolute(fixtureRoot), "fixture root must be recorded");
  assert.equal(fs.existsSync(fixtureRoot), false, "failed fixture must stop its sentinel and remove its verified root");
});

test("spawn rejection retains the fixture without waiting for a missing exit", { skip: process.platform !== "linux" }, async (t) => {
  let fixtureRoot, spawned, spawnError, stateDir, marker;
  await t.test("broker executable is missing", async (child) => {
    const broker = { async ensureBrokerSession(cwd, options) {
      stateDir = resolveStateDir(cwd);
      marker = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8"));
      spawned = spawn(path.join(cwd, "missing-broker-executable"), [], { cwd });
      const failed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("spawn rejection timed out")), 3000);
        spawned.once("error", error => { clearTimeout(timer); resolve(error); });
      });
      options.onBrokerSpawn(spawned);
      spawnError = await failed;
      throw spawnError;
    } };
    await assert.rejects(fixture(child, {}, root => { fixtureRoot = root; }, { broker }), /ENOENT/);
  });
  assert.equal(spawnError?.code, "ENOENT");
  assert.equal(spawned.pid, undefined);
  assert.ok(path.isAbsolute(fixtureRoot));
  assert.equal(fs.existsSync(fixtureRoot), true, "unconfirmed startup must retain its root");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).sentinel, marker.sentinel);
  // この故障注入では exec が ENOENT で失敗し、broker と agent は起動していない。
  const stopped = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.epoch, marker.epoch);
  removeTempFixture(fixtureRoot, { recursive: true, force: true });
});

test("process inspection timeout retains the failed startup fixture", { skip: process.platform !== "linux" }, async (t) => {
  let fixtureRoot, brokerChild, inspectionError, originalStateDir, originalMarker, originalIdentities;
  await t.test("process inspection hangs", async (child) => {
    await assert.rejects(fixture(child, { CANCEL_DELAY_INITIALIZE: "10000" }, root => { fixtureRoot = root; }, {
      onStartupChild: proc => {
        brokerChild = proc;
        originalStateDir = resolveStateDir(fixtureRoot);
        const paths = [originalStateDir, path.join(originalStateDir, "state.lock"), path.join(originalStateDir, "state.lock", "protocol.json")];
        originalIdentities = paths.map(file => {
          const stat = fs.lstatSync(file, { bigint: true });
          assert.ok(!stat.isSymbolicLink());
          return { dev: stat.dev, ino: stat.ino };
        });
        originalMarker = JSON.parse(fs.readFileSync(paths[2], "utf8"));
      },
      inspectProcesses(_command, _args, options) {
        const result = spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], options);
        inspectionError = result.error;
        return result;
      }
    }), /Fixture broker did not start/);
  });
  assert.equal(inspectionError?.code, "ETIMEDOUT");
  assert.equal(fs.existsSync(fixtureRoot), true);
  assert.ok(Number.isSafeInteger(brokerChild.pid) && brokerChild.pid > 0);
  assert.ok(brokerChild.exitCode !== null || brokerChild.signalCode !== null);
  const events = fs.readFileSync(path.join(fixtureRoot, "agent.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(events.some(row => row.delayedInitialize === true));
  const agentPids = new Set(events.map(row => row.started).filter(pid => Number.isSafeInteger(pid) && pid > 0));
  assert.ok(agentPids.size > 0);
  const ps = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 3000 });
  assert.ifError(ps.error);
  assert.equal(ps.status, 0, ps.stderr);
  assert.ok(!ps.stdout.split("\n").map(line => line.trim().split(/\s+/)).some(([pid, pgid, stat]) =>
    stat && !stat.startsWith("Z") && (Number(pid) === brokerChild.pid || agentPids.has(Number(pid)) || Number(pgid) === brokerChild.pid)));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(fixtureRoot, "data");
  try {
    const stateDir = resolveStateDir(fixtureRoot);
    assert.equal(stateDir, originalStateDir);
    const paths = [stateDir, path.join(stateDir, "state.lock"), path.join(stateDir, "state.lock", "protocol.json")];
    assert.deepEqual(paths.map(file => {
      const stat = fs.lstatSync(file, { bigint: true });
      assert.ok(!stat.isSymbolicLink());
      return { dev: stat.dev, ino: stat.ino };
    }), originalIdentities);
    const marker = JSON.parse(fs.readFileSync(paths[2], "utf8"));
    assert.equal(marker.epoch, originalMarker.epoch);
    assert.deepEqual(marker.sentinel, originalMarker.sentinel);
    const stopped = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.epoch, marker.epoch);
    removeTempFixture(fixtureRoot, { recursive: true, force: true });
  } finally {
    previous === undefined ? delete process.env.CLAUDE_PLUGIN_DATA : process.env.CLAUDE_PLUGIN_DATA = previous;
  }
});

test("cancel before a delayed repair prompt tombstones only that execution", async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  const control = await f.connect();
  const cancelled = await cancel(control, "job-a");
  assert.equal(cancelled.reservationAccepted, true);
  await assert.rejects(prompt(owner, "job-a", { name: "late-repair" }), /cancel/i);
  assert.deepEqual(f.logs().filter((row) => row.prompt), []);
  assert.equal((await prompt(owner, "job-b", { name: "resume" })).stopReason, "end_turn");
});

test("cancelled initial end_turn cannot start its repair, and stale cancel cannot stop resume", async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  const control = await f.connect();
  const firstGate = path.join(f.cwd, "first-release");
  const first = prompt(owner, "job-a", { name: "initial", gate: firstGate, ignoreCancel: true });
  await until(() => f.logs().some((row) => row.prompt === "initial"), "initial prompt");
  assert.equal((await cancel(control, "job-a")).reservationAccepted, true);
  fs.writeFileSync(firstGate, "release");
  assert.equal((await first).stopReason, "end_turn");
  await assert.rejects(prompt(owner, "job-a", { name: "repair" }), /cancel/i);
  const resumeGate = path.join(f.cwd, "resume-release");
  const resumed = prompt(owner, "job-b", { name: "resume", gate: resumeGate });
  await until(() => f.logs().some((row) => row.prompt === "resume"), "resume prompt");
  const before = f.logs().filter((row) => row.cancel).length;
  await cancel(control, "job-a");
  assert.equal(f.logs().filter((row) => row.cancel).length, before);
  fs.writeFileSync(resumeGate, "release");
  assert.equal((await resumed).stopReason, "end_turn");
  assert.deepEqual(f.logs().filter((row) => row.prompt).map((row) => row.prompt), ["initial", "resume"]);
  assert.ok(f.logs().filter((row) => row.prompt).every((row) => row.params.executionId === undefined), "broker metadata must not leak to ACP");
});

test("legacy shutdown cannot stop a broker with an attached owner", async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  const control = await f.connect();
  await assert.rejects(control.request("broker/shutdown", {}), /busy|attached/i);
  assert.equal((await prompt(owner, "still-running", { name: "after-shutdown" })).stopReason, "end_turn");
});

test("review runtime does not repair a cancelled malformed end_turn", async (t) => {
  const f = await fixture(t);
  const control = await f.connect();
  const connections = [];
  const enqueued = [];
  const enqueuePrompt = Object.assign((enqueue, execution) => {
    enqueued.push(execution);
    return enqueue();
  }, { connectionEstablished: (identity) => {
    assert.equal(typeof identity.close, "function", "broker connection must expose its owned socket close control");
    connections.push({ transport: identity.transport, brokerGeneration: identity.brokerGeneration });
  } });
  const review = runGrokReview(f.cwd, { env: f.env, executionId: "review-job", outputSchema: {}, enqueuePrompt });
  await until(() => f.logs().some((row) => row.prompt === "review-initial"), "review initial");
  assert.deepEqual(connections, [f.brokerIdentity], "review and cancellation must use the same broker generation");
  assert.deepEqual(enqueued, [{ sessionId: "session-1", ...f.brokerIdentity }], "the active review prompt must belong to that broker generation");
  const cancelled = await cancel(control, "review-job");
  assert.equal(cancelled.reservationAccepted, true);
  assert.equal(cancelled.notificationSent, true, "cancellation must target the active review execution");
  assert.equal(cancelled.executionState, "accepted");
  await until(() => f.logs().some((row) => row.cancel === "session-1"), "review agent cancel notification");
  fs.writeFileSync(f.env.CANCEL_REVIEW_GATE, "release");
  const result = await review;
  assert.equal(result.status, "failed");
  assert.equal(result.jsonRepaired, false);
  assert.match(result.error.message, /cancel/i);
  assert.equal(f.logs().filter((row) => row.started).length, 1, "review must not start a direct agent");
  assert.deepEqual(f.logs().filter((row) => row.terminal).map((row) => [row.terminal, row.stopReason]), [["review-initial", "end_turn"]]);
  assert.deepEqual(f.logs().filter((row) => row.prompt).map((row) => row.prompt), ["review-initial"]);
});

test("review repair rejected by a busy broker keeps the completed initial turn confirmed", async (t) => {
  const f = await fixture(t);
  const competing = await f.connect();
  const control = await f.connect();
  const gate = path.join(f.cwd, "busy-repair-release");
  fs.writeFileSync(f.env.CANCEL_REVIEW_GATE, "release");
  let calls = 0, busyError, competingPrompt, result;
  try {
    result = await runGrokReview(f.cwd, { env: f.env, executionId: "busy-repair", outputSchema: {},
      async enqueuePrompt(enqueue, execution) {
        assert.deepEqual(execution, { sessionId: "session-1", ...f.brokerIdentity });
        if (++calls === 1) return enqueue();
        assert.equal(calls, 2);
        assert.ok(f.logs().some(row => row.terminal === "review-initial" && row.stopReason === "end_turn"));
        competingPrompt = competing.request("session/prompt", { sessionId: "session-2", executionId: "other-execution",
          prompt: [{ type: "text", text: JSON.stringify({ name: "occupying-broker", gate }) }] });
        void competingPrompt.catch(() => {});
        await until(() => f.logs().some(row => row.prompt === "occupying-broker"), "other session occupies broker");
        try { return await enqueue(); } catch (error) { busyError = error; throw error; }
      } });
  } finally {
    fs.writeFileSync(gate, "release");
    if (competingPrompt) await competingPrompt;
  }
  assert.equal(calls, 2);
  assert.equal(busyError?.rpcCode, BROKER_BUSY_RPC_CODE, "repair must receive the real broker busy response");
  assert.equal(busyError?.rpcResponseReceived, true);
  assert.equal(busyError?.data?.data?.source, "grok-broker");
  assert.equal(busyError?.data?.data?.promptForwarded, false);
  assert.equal(result.status, "failed");
  assert.equal(result.jsonRepaired, false);
  assert.equal(result.turnStopUnconfirmed, false, "the initial turn ended and the repair was not forwarded");
  assert.equal(result.promptNotSent, false, "the initial review prompt was sent, so the whole job is not unsent");
  assert.deepEqual(f.logs().filter(row => row.prompt).map(row => row.prompt), ["review-initial", "occupying-broker"]);
  const proof = await cancel(control, "busy-repair");
  assert.equal(proof.executionState, "terminal");
  assert.equal(proof.reservationAccepted, true);
  assert.equal(proof.notificationSent, false);
});

test("direct runtime guards both enqueues and never sends execution metadata to ACP", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.env.CANCEL_REVIEW_GATE, "release");
  const stopped = await runGrokReview(f.cwd, { env: { ...f.env, GROK_COMPANION_DISABLE_BROKER: "1" },
    executionId: "cancelled-before-first", outputSchema: {}, enqueuePrompt() {
      throw new Error("Job cancelled before first prompt");
    } });
  assert.equal(stopped.status, "failed");
  assert.deepEqual(f.logs().filter((row) => row.prompt), []);
  let enqueues = 0;
  const result = await runGrokReview(f.cwd, { env: { ...f.env, GROK_COMPANION_DISABLE_BROKER: "1" },
    executionId: "direct-job", outputSchema: {}, enqueuePrompt(enqueue) {
      if (++enqueues === 2) throw new Error("Job cancelled; repair not sent");
      return enqueue();
    } });
  assert.equal(enqueues, 2);
  assert.equal(result.status, "failed");
  assert.deepEqual(f.logs().filter((row) => row.prompt).map((row) => row.prompt), ["review-initial"]);
  assert.ok(f.logs().filter((row) => row.prompt).every((row) => row.params.executionId === undefined));
});

test("broker seals enqueue before inspecting a reentrant error getter", async (t) => {
  const f = await fixture(t);
  const control = await f.connect();
  const reentries = [];
  let savedEnqueue;
  const error = new Error("guard rejected before enqueue");
  Object.defineProperty(error, "turnStopUnconfirmed", { get() {
    reentries.push(savedEnqueue());
    return false;
  } });
  const result = await runGrokTurn(f.cwd, { env: f.env, executionId: "getter-reentry", prompt: "never send",
    enqueuePrompt(enqueue, execution) {
      assert.deepEqual(execution, { sessionId: "session-1", ...f.brokerIdentity });
      savedEnqueue = enqueue;
      throw error;
    } });
  assert.equal(result.status, "failed");
  assert.equal(result.error, error);
  assert.equal(result.promptNotSent, true);
  assert.equal(result.turnStopUnconfirmed, false);
  assert.ok(reentries.length > 0, "the error getter must actually attempt reentry");
  for (const reentry of reentries) await assert.rejects(reentry, /enqueue operation is no longer active/i);
  assert.deepEqual(f.logs().filter(row => row.prompt || row.terminal), []);
  const proof = await cancel(control, "getter-reentry");
  assert.equal(proof.executionState, "never-accepted");
  assert.equal(proof.notificationSent, false);
});

for (const variant of ["explicit unconfirmed", "throwing getter", "reentrant getter"]) {
  test(`broker preserves non-Error unconfirmed evidence from ${variant}`, async (t) => {
    const f = await fixture(t);
    const control = await f.connect();
    const reentries = [];
    let savedEnqueue, getterReads = 0;
    const rejected = variant === "explicit unconfirmed" ? { turnStopUnconfirmed: true } : {};
    if (variant !== "explicit unconfirmed") Object.defineProperty(rejected, "turnStopUnconfirmed", { get() {
      getterReads++;
      if (variant === "throwing getter") throw new Error("unconfirmed inspection failed");
      reentries.push(savedEnqueue());
      return true;
    } });
    const executionId = `non-error-${variant.replaceAll(" ", "-")}`;
    const result = await runGrokTurn(f.cwd, { env: f.env, executionId, prompt: "never send",
      enqueuePrompt(enqueue, execution) {
        assert.deepEqual(execution, { sessionId: "session-1", ...f.brokerIdentity });
        savedEnqueue = enqueue;
        throw rejected;
      } });
    assert.equal(result.status, "failed");
    assert.equal(result.promptNotSent, false);
    assert.equal(result.turnStopUnconfirmed, true);
    if (variant !== "explicit unconfirmed") assert.ok(getterReads > 0, "unconfirmed getter must be inspected");
    if (variant === "throwing getter") {
      assert.equal(result.error.cause?.cause, rejected, "the original non-Error failure must remain available");
      assert.match(result.error.errors?.[1]?.message ?? "", /unconfirmed inspection failed/, "the getter failure must remain available");
    }
    if (variant === "reentrant getter") {
      assert.ok(reentries.length > 0, "the getter must actually attempt reentry");
      for (const reentry of reentries) await assert.rejects(reentry, /enqueue operation is no longer active/i);
    }
    assert.deepEqual(f.logs().filter(row => row.prompt || row.terminal), []);
    const proof = await cancel(control, executionId);
    assert.equal(proof.executionState, "never-accepted");
    assert.equal(proof.notificationSent, false);
  });
}

test("broker retains a throwing inspection error after an agent terminal response", async (t) => {
  const f = await fixture(t);
  const control = await f.connect();
  const original = new Error("guard rejected after terminal");
  const inspection = new Error("terminal inspection getter failed");
  Object.defineProperty(original, "turnStopUnconfirmed", { get() { throw inspection; } });
  const result = await runGrokTurn(f.cwd, { env: f.env, executionId: "terminal-getter-error",
    prompt: JSON.stringify({ name: "terminal-getter-error" }),
    async enqueuePrompt(enqueue) { await enqueue(); throw original; } });
  assert.equal(result.status, "failed");
  assert.equal(result.turnStopUnconfirmed, true);
  assert.equal(result.promptNotSent, false);
  assert.equal(result.error.cause, original, "the original guard error must remain available");
  assert.equal(result.error.errors?.[1], inspection, "the getter error must remain available");
  assert.deepEqual(f.logs().filter(row => row.prompt).map(row => row.prompt), ["terminal-getter-error"]);
  assert.ok(f.logs().some(row => row.terminal === "terminal-getter-error" && row.stopReason === "end_turn"));
  const proof = await cancel(control, "terminal-getter-error");
  assert.equal(proof.executionState, "terminal");
  assert.equal(proof.notificationSent, false);
});

test("broker rejects a saved enqueue after the unsent result is returned", async (t) => {
  const f = await fixture(t);
  const control = await f.connect();
  let savedEnqueue;
  const result = await runGrokTurn(f.cwd, { env: f.env, executionId: "late-enqueue", prompt: "never send",
    enqueuePrompt(enqueue, execution) {
      assert.deepEqual(execution, { sessionId: "session-1", ...f.brokerIdentity });
      savedEnqueue = enqueue;
      throw new Error("guard rejected before enqueue");
    } });
  assert.equal(result.status, "failed");
  assert.equal(result.promptNotSent, true);
  assert.equal(result.turnStopUnconfirmed, false);
  await assert.rejects(savedEnqueue(), /enqueue operation is no longer active/i);
  assert.deepEqual(f.logs().filter(row => row.prompt || row.terminal), []);
  const proof = await cancel(control, "late-enqueue");
  assert.equal(proof.executionState, "never-accepted");
  assert.equal(proof.notificationSent, false);
});

test("broker does not classify an enqueued prompt as unsent when the guard then rejects", async (t) => {
  const f = await fixture(t);
  const control = await f.connect();
  const gate = path.join(f.cwd, "enqueued-before-rejection-release");
  let result;
  try {
    result = await runGrokTurn(f.cwd, { env: f.env, executionId: "enqueued-then-rejected",
      prompt: JSON.stringify({ name: "enqueued-before-rejection", gate }),
      async enqueuePrompt(enqueue, execution) {
        assert.deepEqual(execution, { sessionId: "session-1", ...f.brokerIdentity });
        const pending = enqueue();
        void pending.catch(() => {});
        await until(() => f.logs().some(row => row.prompt === "enqueued-before-rejection"), "agent received prompt");
        throw new Error("guard rejected after enqueue");
      } });
  } finally {
    fs.writeFileSync(gate, "release");
    if (f.logs().some(row => row.prompt === "enqueued-before-rejection")) {
      // socket が先に閉じれば broker は cancel を送り、fake は cancelled を返す。
      // gate 解放が先なら end_turn になるため、どちらも実際の agent 応答を確認する。
      await until(() => f.logs().some(row => row.terminal === "enqueued-before-rejection" &&
        ["end_turn", "cancelled"].includes(row.stopReason)), "enqueued prompt terminal");
      await until(async () => {
        const proof = await cancel(control, "enqueued-then-rejected");
        return proof.executionState === "terminal" && proof.notificationSent === false;
      }, "broker records enqueued prompt terminal");
    }
  }
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /guard rejected after enqueue/);
  assert.equal(result.promptNotSent, false);
  assert.equal(result.turnStopUnconfirmed, true);
  assert.equal(f.logs().filter(row => row.prompt === "enqueued-before-rejection").length, 1);
});

test("direct rejection before enqueue does not claim broker unsent evidence", async (t) => {
  const f = await fixture(t);
  const stops = [];
  const enqueuePrompt = Object.assign((_enqueue, execution) => {
    assert.equal(execution.transport, "direct");
    assert.equal(execution.brokerGeneration, null);
    throw new Error("direct guard rejected before enqueue");
  }, { directAgentStarting: () => ({ finish(proof) { stops.push(proof); return Boolean(proof); } }) });
  const result = await runGrokTurn(f.cwd, { env: { ...f.env, GROK_COMPANION_DISABLE_BROKER: "1" },
    executionId: "direct-unsent", prompt: "never send", enqueuePrompt });
  assert.equal(result.status, "failed");
  assert.equal(result.promptNotSent, false);
  assert.equal(result.turnStopUnconfirmed, true);
  assert.deepEqual(f.logs().filter(row => row.prompt || row.terminal), []);
  assert.equal(stops.length, 1);
  assert.equal(stops[0], process.platform === "win32" ? "job-empty" : "posix-group-empty");
});

test("legacy session-only cancellation cannot stop a scoped resumed turn", async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  const old = await f.connect();
  const gate = path.join(f.cwd, "legacy-release");
  const resumed = prompt(owner, "new-job", { name: "new-resume", gate });
  await until(() => f.logs().some((row) => row.prompt === "new-resume"), "new resume");
  old.notify("session/cancel", { sessionId: "session-1" });
  // 同一socketの次のrequest応答をbarrierにして通知の処理済みを確認する。
  await old.request("initialize", {});
  assert.deepEqual(f.logs().filter((row) => row.cancel), []);
  fs.writeFileSync(gate, "release");
  assert.equal((await resumed).stopReason, "end_turn");
});

test("new runtime uses direct transport and skips unsafe interrupt with a legacy broker", async (t) => {
  const f = await fixture(t);
  const received = [];
  const address = process.platform === "win32" ? `pipe:\\\\.\\pipe\\legacy-cancel-${randomUUID()}` : `unix:${path.join(f.cwd, "legacy.sock")}`;
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const m = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        received.push(m);
        if (m.id !== undefined) socket.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + "\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(address.slice(5), resolve));
  f.cleanup(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...f.env, GROK_COMPANION_ACP_ENDPOINT: address };
  fs.writeFileSync(env.CANCEL_REVIEW_GATE, "release");
  const result = await runGrokReview(f.cwd, { env, executionId: "old-broker-job", outputSchema: {} });
  assert.equal(result.status, "completed");
  assert.equal(result.jsonRepaired, true);
  const interrupted = await interruptGrokTurn(f.cwd, { ...f.brokerIdentity, sessionId: "session-1", executionId: "old-broker-job", env });
  assert.equal(interrupted.interrupted, false);
  assert.match(interrupted.detail, /broker generation did not match/i);
  assert.ok(received.every((m) => m.method === "initialize"));
  assert.ok(f.logs().filter((row) => row.prompt).every((row) => row.params.executionId === undefined));
});

test("tombstone capacity preserves cancelled generations and sends new runtime connections directly", async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  const control = await f.connect();
  const gate = path.join(f.cwd, "capacity-release");
  const active = prompt(owner, "active-job", { name: "active-capacity", gate });
  await until(() => f.logs().some((row) => row.prompt === "active-capacity"), "active before capacity");
  for (let n = 0; n < 4097; n++) await cancel(control, `cancelled-${n}`);
  const interrupted = await interruptGrokTurn(f.cwd, { ...f.brokerIdentity, sessionId: "session-1", executionId: "active-job", env: f.env });
  assert.equal(interrupted.notificationSent, true);
  assert.equal(interrupted.interrupted, false);
  assert.equal(interrupted.executionState, "accepted");
  assert.equal((await active).stopReason, "cancelled");
  assert.ok(f.logs().some((row) => row.cancel === "session-1"));
  assert.ok(f.logs().some((row) => row.terminal === "active-capacity" && row.stopReason === "cancelled"));
  const stopped = await interruptGrokTurn(f.cwd, { ...f.brokerIdentity, sessionId: "session-1", executionId: "active-job", env: f.env });
  assert.equal(stopped.stopConfirmed, true);
  assert.equal(stopped.executionState, "terminal");
  await assert.rejects(prompt(owner, "cancelled-4096", { name: "overflow-repair" }), /capacity/i);
  await assert.rejects(prompt(owner, "cancelled-0", { name: "old-repair" }), /cancel/i);
  fs.writeFileSync(f.env.CANCEL_REVIEW_GATE, "release");
  const result = await runGrokReview(f.cwd, { env: f.env, executionId: "fresh-direct", outputSchema: {} });
  assert.equal(result.status, "completed");
  assert.equal(result.jsonRepaired, true);
  assert.deepEqual(f.logs().filter((row) => row.prompt).map((row) => row.prompt), ["active-capacity", "review-initial", "review-repair"]);
  assert.ok(f.logs().filter((row) => row.prompt?.startsWith("review")).every((row) => row.params.executionId === undefined));
});

test("capacity reached during an admitted review preserves its JSON repair", async (t) => {
  const f = await fixture(t);
  const control = await f.connect();
  const review = runGrokReview(f.cwd, { env: f.env, executionId: "admitted-review", outputSchema: {} });
  await until(() => f.logs().some((row) => row.prompt === "review-initial"), "admitted review");
  for (let n = 0; n < 4097; n++) await cancel(control, `full-${n}`);
  fs.writeFileSync(f.env.CANCEL_REVIEW_GATE, "release");
  const result = await review;
  assert.equal(result.status, "completed");
  assert.equal(result.jsonRepaired, true);
  assert.deepEqual(f.logs().filter((row) => row.prompt).map((row) => row.prompt), ["review-initial", "review-repair"]);
});

test("capacity between initialize and the first enqueue retries directly through the state guard", async (t) => {
  const f = await fixture(t);
  const control = await f.connect();
  fs.writeFileSync(f.env.CANCEL_REVIEW_GATE, "release");
  let guarded = 0;
  const result = await runGrokReview(f.cwd, { env: f.env, executionId: "not-cancelled", outputSchema: {},
    enqueuePrompt(enqueue) {
      if (++guarded === 1) return (async () => {
        for (let n = 0; n < 4097; n++) await cancel(control, `full-${n}`);
        return enqueue();
      })();
      return enqueue();
    } });
  assert.equal(result.status, "completed");
  assert.equal(result.jsonRepaired, true);
  assert.equal(guarded, 3, "rejected initial, direct initial and direct repair each pass the guard");
  assert.ok(f.logs().filter((row) => row.prompt).every((row) => row.params.executionId === undefined));
});

test("idle cancellation confirms a never-accepted execution without notifying the agent", async (t) => {
  const f = await fixture(t);
  const result = await interruptGrokTurn(f.cwd, { ...f.brokerIdentity, sessionId: "session-1", executionId: "idle-job", env: f.env });
  assert.equal(result.reservationAccepted, true);
  assert.equal(result.interrupted, true);
  assert.equal(result.stopConfirmed, true);
  assert.equal(result.executionState, "never-accepted");
  assert.equal(result.notificationSent, false);
  assert.deepEqual(f.logs().filter((row) => row.cancel), []);
});

test("interrupt does not run synchronous Grok availability probes", async (t) => {
  const f = await fixture(t);
  const start = Date.now();
  const result = await interruptGrokTurn(f.cwd, { ...f.brokerIdentity, sessionId: "session-1", executionId: "probe-job",
    env: { ...f.env, CANCEL_PROBE_DELAY: "1200" } });
  assert.ok(Date.now() - start < 750, "a slow --version/--help must not block the cancellation timer");
  assert.equal(result.reservationAccepted, true);
  assert.deepEqual(f.logs().filter((row) => row.probe), []);
});

test("a sent cancellation notification does not prove that an ignoreCancel agent stopped", async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  const gate = path.join(f.cwd, "ignored-cancel-release");
  const active = prompt(owner, "ignoring-job", { name: "ignoring", gate, ignoreCancel: true });
  await until(() => f.logs().some((row) => row.prompt === "ignoring"), "ignoring prompt");
  const result = await interruptGrokTurn(f.cwd, { ...f.brokerIdentity, sessionId: "session-1", executionId: "ignoring-job", env: f.env });
  fs.writeFileSync(gate, "release");
  assert.equal((await active).stopReason, "end_turn", "the agent completed normally despite the notification");
  assert.equal(result.reservationAccepted, true);
  assert.equal(result.notificationSent, true);
  assert.equal(result.interrupted, false);
  assert.equal(result.stopConfirmed, false);
});

for (const command of ["review", "task"]) {
  test(`tracked ${command} persists its live Grok session and distinguishes worker cancellation from unconfirmed agent termination`, async (t) => {
    const f = await fixture(t);
    initGitRepo(f.cwd);
    fs.writeFileSync(path.join(f.cwd, "example.js"), "export const n = 1;\n");
    assert.equal(run("git", ["add", "example.js"], { cwd: f.cwd }).status, 0);
    assert.equal(run("git", ["commit", "-m", "test fixture"], { cwd: f.cwd }).status, 0);
    assert.equal(run("git", ["switch", "-c", "cancel-feature"], { cwd: f.cwd }).status, 0);
    fs.writeFileSync(path.join(f.cwd, "example.js"), "export const n = 2;\n");
    assert.equal(run("git", ["add", "example.js"], { cwd: f.cwd }).status, 0);
    assert.equal(run("git", ["commit", "-m", "cancellation review difference"], { cwd: f.cwd }).status, 0);
    assert.equal(run("git", ["diff", "--name-only", "main...HEAD"], { cwd: f.cwd }).stdout.trim(), "example.js");
    const env = { ...f.env, CLAUDE_PLUGIN_DATA: path.join(f.cwd, "data"), GROK_COMPANION_SESSION_ID: "host-session" };
    prepareFixtureState(f.cwd, env);
    const companion = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
    // POSIXのworking-tree snapshotは未対応なので、キャンセル経路は実commit差分で検証する。
    const child = spawn(process.execPath, [companion, command, "--json",
      ...(command === "task" ? ["hold this turn"] : ["--scope", "branch", "--base", "main"])],
      { cwd: f.cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume();
    let workerStderr = "";
    child.stderr.on("data", (chunk) => { workerStderr = (workerStderr + chunk).slice(-16384); });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    f.cleanup(async () => {
      fs.writeFileSync(env.CANCEL_REVIEW_GATE, "release");
      await stopFixtureChild(child);
      await exited;
    });
    await until(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Tracked ${command} exited before its prompt (code=${child.exitCode}, signal=${child.signalCode}).\n${workerStderr || "No worker stderr was captured."}`);
      }
      return f.logs().some((row) => row.prompt === "review-initial");
    }, `tracked ${command} prompt`, 30000);
    const status = spawnSync(process.execPath, [companion, "status", "--json"], { cwd: f.cwd, env, windowsHide: true, encoding: "utf8", timeout: 15000 });
    assert.equal(status.status, 0, status.stderr);
    const job = JSON.parse(status.stdout).running[0];
    assert.equal(job.grokSessionId, "session-1");
    assert.equal(job.grokTransport, f.brokerIdentity.transport);
    assert.equal(job.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
    const result = spawnSync(process.execPath, [companion, "cancel", "--json", job.id], { cwd: f.cwd, env, windowsHide: true, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 1, "an ignoreCancel agent must leave cancellation pending");
    assert.match(result.stderr, /Worker stopped.*turn stop is unconfirmed.*cancellation remains pending/i);
    if (process.platform === "linux" || process.platform === "darwin") {
      assert.ok(job.workerLease?.id);
      for (const record of readFixtureJobRecords(f.cwd, env, job.id)) {
        assert.equal(record.status, "cancelled");
        assert.equal(record.terminationPending, true);
        assert.equal(record.workerLease?.id, job.workerLease.id);
        assert.equal(record.workerStopConfirmed, true);
        assert.equal(record.workerStopProof, `${process.platform}-lease-released`);
        assert.equal(record.workerStopLeaseId, job.workerLease.id);
      }
    }
    await until(() => child.exitCode !== null || child.signalCode !== null, `tracked ${command} worker exit`, 15000);
    await exited;
    const pendingStatus = spawnSync(process.execPath, [companion, "status", "--json", job.id], { cwd: f.cwd, env, windowsHide: true, encoding: "utf8", timeout: 15000 });
    assert.equal(pendingStatus.status, 0, pendingStatus.stderr);
    const pending = JSON.parse(pendingStatus.stdout).job;
    assert.equal(pending.status, "cancelled");
    assert.equal(pending.phase, "termination-pending");
    assert.equal(pending.terminationPending, true);
    assert.equal(pending.workerStopConfirmed, true);
    assert.equal(pending.pid, null);
    assert.ok(f.logs().some((row) => row.cancel === "session-1"), "the agent actually received cancellation");
    assert.deepEqual(f.logs().filter((row) => row.terminal), [], "worker exit must not count as agent terminal");
    const log = fs.readFileSync(job.logFile, "utf8");
    assert.match(log, /notification sent.*stop.*unconfirmed/i);
    fs.writeFileSync(env.CANCEL_REVIEW_GATE, "release");
    await until(() => f.logs().some((row) => row.terminal === "review-initial" && row.stopReason === "end_turn"), "ignored cancellation agent terminal");
    const control = await f.connect();
    await until(async () => (await cancel(control, job.id)).executionState === "terminal", "broker records agent terminal");
    const retried = spawnSync(process.execPath, [companion, "cancel", "--json", job.id], { cwd: f.cwd, env, windowsHide: true, encoding: "utf8", timeout: 15000 });
    assert.equal(retried.status, 0, retried.stderr);
    const payload = JSON.parse(retried.stdout);
    assert.equal(payload.jobId, job.id);
    assert.equal(payload.turnCancellationReserved, true);
    assert.equal(payload.turnInterruptNotificationSent, false);
    assert.equal(payload.turnInterrupted, true);
    assert.equal(payload.turnStopConfirmed, true);
    assert.equal(payload.workerStopConfirmed, true);
    const final = spawnSync(process.execPath, [companion, "status", "--json", job.id], { cwd: f.cwd, env, windowsHide: true, encoding: "utf8", timeout: 15000 });
    assert.equal(final.status, 0, final.stderr);
    const cancelled = JSON.parse(final.stdout).job;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(cancelled.terminationPending, false);
  });
}

test("same-session concurrent prompts are rejected without releasing another session's owner", async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  const control = await f.connect();
  const firstGate = path.join(f.cwd, "first-concurrent");
  const first = prompt(owner, "first-concurrent", { name: "first-concurrent", gate: firstGate });
  await until(() => f.logs().some((row) => row.prompt === "first-concurrent"), "first concurrent prompt");
  await assert.rejects(prompt(owner, "second-concurrent", { name: "same-session" }), /busy|already.*prompt/i);
  await assert.rejects(owner.request("session/prompt", { sessionId: "session-1", prompt: [{ type: "text", text: '{}' }] }), /busy|already.*prompt/i);
  const siblingGate = path.join(f.cwd, "sibling-concurrent");
  const sibling = owner.request("session/prompt", { sessionId: "session-2", executionId: "sibling",
    prompt: [{ type: "text", text: JSON.stringify({ name: "sibling", gate: siblingGate }) }] });
  await until(() => f.logs().some((row) => row.prompt === "sibling"), "different-session concurrent prompt");
  await cancel(control, "first-concurrent");
  assert.equal((await first).stopReason, "cancelled");
  await assert.rejects(control.request("session/new", { cwd: f.cwd, mcpServers: [] }), /busy/i);
  fs.writeFileSync(siblingGate, "release");
  assert.equal((await sibling).stopReason, "end_turn");
  assert.deepEqual(f.logs().filter((row) => row.prompt).map((row) => row.prompt), ["first-concurrent", "sibling"]);
});

test("capacity cancellation protects an idle admitted repair and keeps the same ID in another session independent", async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  const control = await f.connect();
  const second = (name) => owner.request("session/prompt", { sessionId: "session-2", executionId: "same-id",
    prompt: [{ type: "text", text: JSON.stringify({ name }) }] });
  await prompt(owner, "same-id", { name: "first-session-initial" });
  await second("second-session-initial");
  for (let n = 0; n < 4097; n++) await cancel(control, `full-${n}`);
  const ack = await cancel(control, "same-id");
  assert.equal(ack.reservationAccepted, true);
  assert.equal(ack.notificationSent, false);
  await assert.rejects(prompt(owner, "same-id", { name: "cancelled-repair" }), /cancel/i);
  assert.equal((await second("other-session-repair")).stopReason, "end_turn");
  const replacement = await f.connect();
  await assert.rejects(prompt(replacement, "same-id", { name: "reconnected-repair" }), /capacity/i);
  await assert.rejects(owner.request("session/prompt", { sessionId: "session-1", prompt: [{ type: "text", text: '{}' }] }), /capacity/i);
});

test("a cancellation committed after capacity rejection prevents the direct retry enqueue", async (t) => {
  const f = await fixture(t);
  const control = await f.connect();
  let cancelled = false;
  let guarded = 0;
  const result = await runGrokReview(f.cwd, { env: f.env, executionId: "cancelled-retry", outputSchema: {},
    enqueuePrompt(enqueue) {
      guarded++;
      if (cancelled) throw new Error("Job cancelled before direct retry");
      return (async () => {
        for (let n = 0; n < 4097; n++) await cancel(control, `full-${n}`);
        try { return await enqueue(); } finally { cancelled = true; }
      })();
    } });
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /cancelled before direct retry/);
  assert.equal(guarded, 2);
  assert.deepEqual(f.logs().filter((row) => row.prompt), []);
});

test("a guardless library call reports capacity without replaying its first prompt", async (t) => {
  const f = await fixture(t);
  let filled = false;
  const fill = `import { GrokAcpClient } from ${JSON.stringify(new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href)};
    const c = await GrokAcpClient.connect(process.cwd(), { env: process.env, brokerOnly: true });
    const generation = c.initializeResult._meta.grokBrokerGeneration;
    try { for (let n=0;n<4097;n++) await c.request('broker/cancelTurn', {sessionId:'session-1',executionId:'full-'+n,generation}); } finally { await c.close(); }`;
  const result = await runGrokReview(f.cwd, { env: f.env, executionId: "guardless", outputSchema: {},
    onProgress(event) {
      if (filled || typeof event !== "object" || !event.message?.startsWith("Session ready")) return;
      filled = true;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", fill], { cwd: f.cwd, env: f.env,
        timeout: 450000, windowsHide: true, encoding: "utf8" });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, child.stderr);
    } });
  assert.equal(filled, true);
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /capacity/i);
  assert.doesNotMatch(result.error.message, /cancel/i);
  assert.deepEqual(f.logs().filter((row) => row.prompt), []);
});

test("agent capacity-code spoofing after a side effect never replays a task", async (t) => {
  const f = await fixture(t, { CANCEL_FORGED_CAPACITY: "1" });
  let guarded = 0;
  const result = await runGrokTurn(f.cwd, { env: f.env, executionId: "write-once", prompt: "perform the fake side effect",
    enqueuePrompt(enqueue) { guarded++; return enqueue(); } });
  assert.equal(result.status, "failed");
  assert.equal(result.error.rpcCode, -32000);
  assert.equal(guarded, 1);
  assert.equal(f.logs().filter((row) => row.prompt).length, 1, "receiving the prompt is the fake side effect");
});

test("a broker-only connection failure never starts a replacement Grok agent", async (t) => {
  const f = await fixture(t);
  const before = f.logs().filter((row) => row.started).length;
  const absent = process.platform === "win32" ? `pipe:\\\\.\\pipe\\absent-${randomUUID()}` : `unix:${path.join(f.cwd, "absent.sock")}`;
  const result = await interruptGrokTurn(f.cwd, { ...f.brokerIdentity, sessionId: "session-1", executionId: "direct-job",
    env: { ...f.env, GROK_COMPANION_ACP_ENDPOINT: absent } });
  assert.equal(result.interrupted, false);
  assert.equal(result.attempted, true, "the unavailable broker must actually be contacted");
  assert.equal(f.logs().filter((row) => row.started).length, before);
});

test("admission records stay bounded per socket without evicting earlier repairs", async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  for (let n = 0; n < 64; n++) await prompt(owner, `admitted-${n}`, { name: `initial-${n}` });
  await assert.rejects(prompt(owner, "not-admitted", { name: "overflow" }), /capacity/i);
  assert.equal((await prompt(owner, "admitted-0", { name: "early-repair" })).stopReason, "end_turn");
  assert.equal(f.logs().filter((row) => row.prompt).length, 65);
});

for (const [label, response] of [
  ["never-accepted with rejected reservation", { executionState: "never-accepted", reservationAccepted: false, notificationSent: false }],
  ["never-accepted with missing reservation", { executionState: "never-accepted", notificationSent: false }],
  ["never-accepted with an active notification", { executionState: "never-accepted", reservationAccepted: true, notificationSent: true }],
  ["never-accepted with missing notification", { executionState: "never-accepted", reservationAccepted: true }],
  ["terminal with rejected reservation", { executionState: "terminal", reservationAccepted: false, notificationSent: false }],
  ["terminal with missing reservation", { executionState: "terminal", notificationSent: false }],
  ["terminal with an active notification", { executionState: "terminal", reservationAccepted: true, notificationSent: true }],
  ["terminal with missing notification", { executionState: "terminal", reservationAccepted: true }]
]) {
  test(`interrupt does not confirm an inconsistent broker response: ${label}`, async (t) => {
    const f = await fixture(t);
    const address = process.platform === "win32" ? `pipe:\\\\.\\pipe\\invalid-cancel-${randomUUID()}` : `unix:${path.join(f.cwd, "invalid-cancel.sock")}`;
    const peers = new Set();
    const received = [];
    const server = net.createServer((socket) => {
      peers.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => peers.delete(socket));
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        while (input.includes("\n")) {
          const end = input.indexOf("\n");
          const message = JSON.parse(input.slice(0, end));
          input = input.slice(end + 1);
          received.push(message);
          const result = message.method === "initialize"
            ? { protocolVersion: 1, _meta: { grokScopedCancellation: true, grokExecutionLedger: true,
                grokBrokerGeneration: f.brokerIdentity.brokerGeneration } }
            : { ...response, generation: f.brokerIdentity.brokerGeneration };
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
        }
      });
    });
    f.cleanup(async () => {
      for (const socket of peers) socket.destroy();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address.slice(5), resolve); });
    const result = await interruptGrokTurn(f.cwd, { ...f.brokerIdentity, sessionId: "session-1", executionId: "invalid-response",
      env: { ...f.env, GROK_COMPANION_ACP_ENDPOINT: address } });
    assert.deepEqual(received.map((message) => message.method), ["initialize", "broker/cancelTurn"]);
    assert.deepEqual(received[1].params, { sessionId: "session-1", executionId: "invalid-response", generation: f.brokerIdentity.brokerGeneration });
    assert.equal(result.stopConfirmed, false, JSON.stringify({ response, result }));
    assert.equal(result.interrupted, false, JSON.stringify({ response, result }));
  });
}

for (const phase of ["initialize", "cancel"]) {
  test(`interrupt deadline destroys its own connection when broker hangs during ${phase}`, async (t) => {
    const f = await fixture(t);
    const address = process.platform === "win32" ? `pipe:\\\\.\\pipe\\hanging-cancel-${randomUUID()}` : `unix:${path.join(f.cwd, "hanging.sock")}`;
    const peers = new Set();
    const received = [];
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      peers.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => peers.delete(socket));
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        while (input.includes("\n")) {
          const end = input.indexOf("\n");
          const m = JSON.parse(input.slice(0, end));
          input = input.slice(end + 1);
          received.push(m);
          if (phase === "cancel" && m.method === "initialize") socket.write(JSON.stringify({ jsonrpc: "2.0", id: m.id,
            result: { protocolVersion: 1, _meta: { grokScopedCancellation: true, grokExecutionLedger: true,
              grokBrokerGeneration: f.brokerIdentity.brokerGeneration } } }) + "\n");
        }
      });
    });
    await new Promise((resolve) => server.listen(address.slice(5), resolve));
    const source = `import { interruptGrokTurn } from ${JSON.stringify(new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url).href)}; console.log(JSON.stringify(await interruptGrokTurn(process.cwd(), { ...${JSON.stringify(f.brokerIdentity)}, sessionId: "session-1", executionId: "deadline", env: process.env })));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd,
      env: { ...f.env, GROK_COMPANION_ACP_ENDPOINT: address }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve) => child.on("exit", () => resolve(true)));
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    f.cleanup(async () => {
      await stopFixtureChild(child);
      await exited;
      for (const socket of peers) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    const finished = await Promise.race([exited, pause(1500).then(() => false)]);
    assert.equal(finished, true, "interrupt must release its socket and let the worker exit without waiting 10 seconds");
    assert.equal(JSON.parse(stdout).interrupted, false);
    assert.equal(JSON.parse(stdout).attempted, true);
    assert.deepEqual(received.map((m) => m.method), phase === "cancel" ? ["initialize", "broker/cancelTurn"] : ["initialize"]);
    if (phase === "cancel") assert.equal(received[1].params.generation, f.brokerIdentity.brokerGeneration);
  });
}

test("a session cancelled before its first prompt does not replace the last valid task conversation", async (t) => {
  const f = await fixture(t, { CANCEL_NUMBERED_SESSIONS: "1" });
  initGitRepo(f.cwd);
  const env = { ...f.env, CLAUDE_PLUGIN_DATA: path.join(f.cwd, "data"), GROK_COMPANION_SESSION_ID: "resume-repro-host" };
  const stateMutexEndpoint = prepareFixtureState(f.cwd, env);
  const cli = (args) => spawnSync(process.execPath, [companion, ...args], {
    cwd: f.cwd, env, windowsHide: true, encoding: "utf8", timeout: 20000
  });
  fs.writeFileSync(env.CANCEL_REVIEW_GATE, "release");
  const first = cli(["task", "--json", "valid conversation"]);
  assert.equal(first.status, 0, first.stderr);
  const valid = JSON.parse(first.stdout);
  assert.equal(valid.grokSessionId, "session-1");
  assert.equal(JSON.parse(cli(["status", "--json", valid.jobId]).stdout).job.taskSessionResumable, true);

  // Session readyの保存を終え、次のenqueue用lockを取る直前にworkerだけ停止する。
  // lockを保持しないので、cancel自身の状態保存や予約RPCは進められる。
  const preload = path.join(f.cwd, "pause-before-first-prompt.cjs");
  fs.writeFileSync(preload, String.raw`
const fs = require("node:fs");
const net = require("node:net");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const append = fs.appendFileSync;
const write = fs.writeFileSync;
const listen = net.Server.prototype.listen;
const stateMutexEndpoint = process.env.CANCEL_STATE_MUTEX_ENDPOINT;
let armed = false;
let locks = 0;
const waitBeforeFirst = () => {
  const gate = process.env.CANCEL_REVIEW_GATE;
  write(gate + ".before-first", "session-2");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !fs.existsSync(gate + ".allow-first"))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  if (!fs.existsSync(gate + ".allow-first")) {
    try {
      write(gate + ".expired", "first-prompt barrier expired");
      fs.writeSync(2, "first-prompt barrier expired; prompt was not enqueued\n");
    } finally { process.exit(70); }
  }
};
fs.appendFileSync = function(target, content, ...args) {
  const result = append.call(this, target, content, ...args);
  if (String(content).includes("Session ready (session-2).")) armed = true;
  return result;
};
fs.writeFileSync = function(target, content, ...args) {
  const result = write.call(this, target, content, ...args);
  // Darwin は検証した log の FD に書くため、この経路でも barrier を有効にする。
  if (typeof target === "number" && String(content).includes("Session ready (session-2).")) armed = true;
  return result;
};
net.Server.prototype.listen = function(...args) {
  const options = args[0];
  // 対象stateのmutexだけを数え、brokerやcapability probeのpipeを含めない。
  if (armed && stateMutexEndpoint && options && typeof options === "object" &&
      options.path === stateMutexEndpoint && ++locks === 2) {
    waitBeforeFirst();
  }
  return listen.apply(this, args);
};
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = function(command, args, options) {
  let targetLock = false;
  if (armed && stateMutexEndpoint &&
      ((command === "/usr/bin/lockf" && JSON.stringify(args) === '["-s","-t","0","3"]') ||
       (command === "/usr/bin/flock" && JSON.stringify(args) === '["-x","-n","3"]')) &&
      typeof options?.stdio?.[3] === "number") {
    const actual = fs.fstatSync(options.stdio[3], { bigint: true });
    const expected = fs.statSync(stateMutexEndpoint, { bigint: true });
    targetLock = actual.dev === expected.dev && actual.ino === expected.ino;
  }
  // Linux は外側の root lock、Darwin は native mutex の取得前に停止する。
  // 先行取得は成功時だけ数える。FDは開いているがlockは未取得。
  if (targetLock && locks === 1) waitBeforeFirst();
  const result = execFileSync.apply(this, arguments);
  if (targetLock) locks++;
  return result;
};
syncBuiltinESMExports();
`);
  const childEnv = { ...env, CANCEL_STATE_MUTEX_ENDPOINT: stateMutexEndpoint,
    NODE_OPTIONS: [env.NODE_OPTIONS, `--require="${preload.replaceAll("\\", "/")}"`].filter(Boolean).join(" ") };
  const worker = spawn(process.execPath, [companion, "task", "--json", "cancel before first prompt"], {
    cwd: f.cwd, env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  worker.stdout.on("data", (chunk) => { stdout += chunk; });
  worker.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => worker.on("exit", resolve));
  f.cleanup(async () => {
    fs.writeFileSync(env.CANCEL_REVIEW_GATE + ".allow-first", "release");
    await stopFixtureChild(worker);
    await exited;
  });
  await until(() => {
    if (worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Worker exited before its barrier (code=${worker.exitCode}, signal=${worker.signalCode}): stdout=${stdout}; stderr=${stderr}`);
    return fs.existsSync(env.CANCEL_REVIEW_GATE + ".before-first");
  }, "second session saved before its first prompt");
  const status = cli(["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const empty = JSON.parse(status.stdout).running[0];
  assert.equal(empty.grokSessionId, "session-2");
  assert.equal(empty.taskSessionResumable, false);
  assert.ok(!f.logs().some((row) => row.prompt && row.params.sessionId === "session-2"));
  const readBoth = () => readFixtureJobRecords(f.cwd, env, empty.id);
  const posix = process.platform === "linux" || process.platform === "darwin";
  const promptState = posix ? "pending" : "not-sent";
  assert.ok(fs.existsSync(env.CANCEL_REVIEW_GATE + ".before-first"));
  assert.ok(!fs.existsSync(env.CANCEL_REVIEW_GATE + ".allow-first"));
  assert.ok(!fs.existsSync(env.CANCEL_REVIEW_GATE + ".expired"), "first-prompt barrier must not expire");
  for (const record of readBoth()) assert.equal(record.grokPromptState, promptState);
  const cancelled = cli(["cancel", "--json", empty.id]);
  assert.ok(!fs.existsSync(env.CANCEL_REVIEW_GATE + ".expired"), "first-prompt barrier must not expire during cancellation");
  if (posix) {
    assert.equal(worker.exitCode, null); assert.equal(worker.signalCode, null);
    assert.equal(cancelled.status, 1, "a worker held at the barrier must leave its lease unconfirmed");
  }
  let payload;
  if (cancelled.status === 1) {
    assert.match(cancelled.stderr, posix
      ? /worker lease remains unconfirmed.*cancellation remains pending/i
      : /Could not stop process.*cancellation remains pending/i);
    for (const pending of readBoth()) {
      assert.equal(pending.phase, "termination-pending");
      assert.equal(pending.terminationPending, true);
      assert.notEqual(pending.workerStopConfirmed, true);
      assert.equal(pending.taskSessionResumable, false);
      assert.equal(pending.grokPromptState, promptState);
      assert.equal(pending.processStartKey, empty.processStartKey);
      if (posix) {
        assert.ok(empty.workerLease?.id);
        assert.equal(pending.workerLease?.id, empty.workerLease.id);
      }
    }
    assert.ok(!f.logs().some((row) => row.prompt && row.params.sessionId === "session-2"));
    if (posix) {
      assert.match(fs.readFileSync(empty.logFile, "utf8"), /Reserved cancellation.*no matching broker turn was active/i);
      const control = await f.connect();
      const reservation = await control.request("broker/cancelTurn", { sessionId: empty.grokSessionId,
        executionId: empty.id, generation: empty.grokBrokerGeneration });
      assert.equal(reservation.generation, empty.grokBrokerGeneration);
      assert.equal(reservation.reservationAccepted, true);
      assert.equal(reservation.executionState, "never-accepted");
      assert.equal(reservation.notificationSent, false);
    }
    assert.ok(!fs.existsSync(env.CANCEL_REVIEW_GATE + ".expired"), "first-prompt barrier must not expire before release");
    assert.equal(worker.exitCode, null); assert.equal(worker.signalCode, null);
    fs.writeFileSync(env.CANCEL_REVIEW_GATE + ".allow-first", "release");
    await until(() => worker.exitCode !== null || worker.signalCode !== null, "cancelled first-prompt worker natural exit");
    await exited;
    const retried = cli(["cancel", "--json", empty.id]);
    assert.equal(retried.status, 0, retried.stderr);
    payload = JSON.parse(retried.stdout);
  } else {
    assert.equal(cancelled.status, 0, cancelled.stderr);
    payload = JSON.parse(cancelled.stdout);
    let timer;
    try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Confirmed worker exit was not observed")), 5000); })]); }
    finally { clearTimeout(timer); }
    assert.ok(!fs.existsSync(env.CANCEL_REVIEW_GATE + ".expired"), "first-prompt barrier must not expire before release");
    fs.writeFileSync(env.CANCEL_REVIEW_GATE + ".allow-first", "release");
  }
  assert.ok(!fs.existsSync(env.CANCEL_REVIEW_GATE + ".expired"), "first-prompt barrier must not expire before worker exit");
  assert.notEqual(worker.exitCode, 70, "barrier expiration must not be accepted as worker completion");
  if (posix) assert.equal(worker.signalCode, null, "cancelled worker must exit naturally");
  assert.equal(payload.jobId, empty.id);
  assert.equal(payload.turnInterruptAttempted, posix);
  assert.equal(payload.turnInterruptNotificationSent, false);
  assert.equal(payload.turnCancellationReserved, posix);
  assert.equal(payload.turnStopConfirmed, true);
  assert.equal(payload.workerStopConfirmed, true);
  const finalStatus = cli(["status", "--json", empty.id]);
  assert.equal(finalStatus.status, 0, finalStatus.stderr);
  assert.equal(JSON.parse(finalStatus.stdout).job.terminationPending, false);
  for (const completed of readBoth()) {
    assert.equal(completed.id, empty.id);
    assert.equal(completed.terminationPending, false);
    assert.equal(completed.workerStopConfirmed, true);
    if (posix) {
      assert.ok(empty.workerLease?.id);
      assert.equal(completed.workerStopProof, `${process.platform}-lease-released`);
      assert.equal(completed.workerLease?.id, empty.workerLease.id);
      assert.equal(completed.workerStopLeaseId, empty.workerLease.id);
    } else assert.equal(completed.workerStopProof, "process-exited");
    assert.equal(completed.workerStopProcessStartKey, empty.processStartKey);
    assert.equal(completed.processStartKey, empty.processStartKey);
    assert.equal(completed.grokPromptState, posix ? "not-sent" : promptState);
  }
  assert.equal(JSON.parse(cli(["status", "--json", empty.id]).stdout).job.taskSessionResumable, false);
  assert.ok(!f.logs().some((row) => row.prompt && row.params.sessionId === "session-2"));
  const resumed = cli(["task", "--resume-last", "--json", "continue valid conversation"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).grokSessionId, valid.grokSessionId,
    "resume-last must keep the last session that actually received a task prompt");
});

test("Linux resumes a broker task after an unrelated review fails before sending", { skip: process.platform !== "linux" }, async (t) => {
  const f = await fixture(t, { CANCEL_NUMBERED_SESSIONS: "1" });
  initGitRepo(f.cwd);
  fs.writeFileSync(path.join(f.cwd, "example.js"), "export const n = 1;\n");
  assert.equal(run("git", ["add", "example.js"], { cwd: f.cwd }).status, 0);
  assert.equal(run("git", ["commit", "-m", "test fixture"], { cwd: f.cwd }).status, 0);
  assert.equal(run("git", ["switch", "-c", "review-feature"], { cwd: f.cwd }).status, 0);
  fs.writeFileSync(path.join(f.cwd, "example.js"), "export const n = 2;\n");
  assert.equal(run("git", ["add", "example.js"], { cwd: f.cwd }).status, 0);
  assert.equal(run("git", ["commit", "-m", "review difference"], { cwd: f.cwd }).status, 0);
  const env = { ...f.env, GROK_COMPANION_SESSION_ID: "resume-failed-review-host" };
  prepareFixtureState(f.cwd, env);
  const cli = (args, overrides = {}) => spawnSync(process.execPath, [companion, ...args], {
    cwd: f.cwd, env: { ...env, ...overrides }, windowsHide: true, encoding: "utf8", timeout: 20000
  });
  fs.writeFileSync(env.CANCEL_REVIEW_GATE, "release");
  const first = cli(["task", "--json", "establish a resumable conversation"]);
  assert.equal(first.status, 0, first.stderr);
  const valid = JSON.parse(first.stdout);
  const taskRecords = readFixtureJobRecords(f.cwd, env, valid.jobId);
  for (const record of taskRecords) {
    assert.equal(record.status, "completed");
    assert.equal(record.grokSessionId, valid.grokSessionId);
    assert.equal(record.grokTransport, "broker");
    assert.equal(record.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
    assert.equal(record.grokPromptState, "terminal");
    assert.equal(record.terminationPending, false);
    assert.equal(record.taskSessionResumable, true);
  }
  const control = await f.connect();
  const terminalProof = () => control.request("broker/cancelTurn", { sessionId: valid.grokSessionId,
    executionId: valid.jobId, generation: f.brokerIdentity.brokerGeneration });
  const initialProof = await terminalProof();
  assert.equal(initialProof.executionState, "terminal");
  assert.equal(initialProof.notificationSent, false);
  const beforeReview = f.logs().filter(row => row.prompt || row.newSession || row.loadedSession || row.terminal);
  const failed = cli(["review", "--json", "--scope", "branch", "--base", "main"], { CANCEL_FAIL_PROBE: "1" });
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /Grok Build is not installed/);
  assert.equal(f.logs().filter(row => row.probeFailed).length, 1);
  assert.deepEqual(f.logs().filter(row => row.prompt || row.newSession || row.loadedSession || row.terminal), beforeReview,
    "failed availability must not start an agent session or send a prompt");
  withStateSnapshot(f.cwd, (state, context) => {
    const reviews = state.jobs.filter(job => job.jobClass === "review");
    assert.equal(reviews.length, 1);
    const indexed = reviews[0];
    const stored = readJobFile(resolveJobFile(f.cwd, indexed.id));
    for (const record of [indexed, stored]) {
      assert.equal(record.epoch, context.epoch);
      assert.equal(record.status, "failed");
      assert.equal(record.phase, "failed");
      assert.equal(record.grokPromptState, "not-sent");
      assert.equal(record.terminationPending, false);
      assert.ok(record.startedAt, "the worker must have started before availability failed");
      assert.ok(record.processStartKey);
      assert.equal(record.pid, null);
      for (const key of ["grokSessionId", "grokTransport", "grokBrokerGeneration", "grokDirectGeneration",
        "grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind"]) {
        assert.equal(record[key] ?? null, null, key);
      }
    }
    assert.ok(indexed.workerLease?.id);
    verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
    assert.equal(withAvailableLinuxLease(indexed.workerLease, context, () => true).status, "available",
      "the failed review worker must release its lease");
  });
  assert.deepEqual(readFixtureJobRecords(f.cwd, env, valid.jobId), taskRecords);
  const proofAfterFailure = await terminalProof();
  assert.equal(proofAfterFailure.executionState, "terminal");
  assert.equal(proofAfterFailure.notificationSent, false);
  const resumed = cli(["task", "--resume-last", "--json", "continue the established conversation"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).grokSessionId, valid.grokSessionId);
  assert.ok(f.logs().some(row => row.loadedSession === valid.grokSessionId));
  const proofAfterResume = await terminalProof();
  assert.equal(proofAfterResume.executionState, "terminal");
  assert.equal(proofAfterResume.notificationSent, false);
});

test("Linux resumes a G2 task after an unrelated G1 review stopped before sending", { skip: process.platform !== "linux" }, async (t) => {
  const f = await fixture(t, { CANCEL_SESSION_PREFIX: "g1-", CANCEL_MANAGED_ENDPOINT: "1" });
  initGitRepo(f.cwd);
  fs.writeFileSync(path.join(f.cwd, "example.js"), "export const n = 1;\n");
  assert.equal(run("git", ["add", "example.js"], { cwd: f.cwd }).status, 0);
  assert.equal(run("git", ["commit", "-m", "test fixture"], { cwd: f.cwd }).status, 0);
  assert.equal(run("git", ["switch", "-c", "review-feature"], { cwd: f.cwd }).status, 0);
  fs.writeFileSync(path.join(f.cwd, "example.js"), "export const n = 2;\n");
  assert.equal(run("git", ["add", "example.js"], { cwd: f.cwd }).status, 0);
  assert.equal(run("git", ["commit", "-m", "review difference"], { cwd: f.cwd }).status, 0);
  const env = { ...f.env, GROK_COMPANION_SESSION_ID: "cross-broker-host" };
  const stateMutexEndpoint = prepareFixtureState(f.cwd, env);
  const epoch = withStateSnapshot(f.cwd, (_state, context) => context.epoch);
  const cli = (args, overrides = {}) => spawnSync(process.execPath, [companion, ...args], {
    cwd: f.cwd, env: { ...env, ...overrides }, windowsHide: true, encoding: "utf8", timeout: 20000
  });
  fs.writeFileSync(env.CANCEL_REVIEW_GATE, "release");
  // Session ready の保存後、pending 保存に続く最終 lock だけを一度失敗させる。
  const preload = path.join(f.cwd, "fail-before-review-enqueue.cjs");
  fs.writeFileSync(preload, "const fs = require(\"node:fs\");\nconst childProcess = require(\"node:child_process\");\nconst { syncBuiltinESMExports } = require(\"node:module\");\nconst append = fs.appendFileSync, execFileSync = childProcess.execFileSync;\nlet armed = false, locks = 0, failed = false;\nfs.appendFileSync = function(target, content, ...args) {\n  const result = append.call(this, target, content, ...args);\n  if (String(content).includes(\"Session ready (g1-1).\")) armed = true;\n  return result;\n};\nchildProcess.execFileSync = function(command, args, options) {\n  let target = false;\n  if (armed && command === \"/usr/bin/flock\" && JSON.stringify(args) === '[\"-x\",\"-n\",\"3\"]' &&\n      typeof options?.stdio?.[3] === \"number\") {\n    const actual = fs.fstatSync(options.stdio[3], { bigint: true });\n    const expected = fs.statSync(process.env.CANCEL_STATE_MUTEX_ENDPOINT, { bigint: true });\n    target = actual.dev === expected.dev && actual.ino === expected.ino;\n  }\n  if (target && locks === 1 && !failed) {\n    failed = true;\n    fs.writeFileSync(process.env.CANCEL_INJECTED_FAILURE, \"failed before enqueue\");\n    throw new Error(\"fixture failure before prompt enqueue\");\n  }\n  const result = execFileSync.apply(this, arguments);\n  if (target) locks++;\n  return result;\n};\nsyncBuiltinESMExports();");
  const injected = path.join(f.cwd, "review-enqueue-failed");
  const review = cli(["review", "--json", "--scope", "branch", "--base", "main"], {
    NODE_OPTIONS: [env.NODE_OPTIONS, "--require=" + JSON.stringify(preload)].filter(Boolean).join(" "),
    CANCEL_STATE_MUTEX_ENDPOINT: stateMutexEndpoint, CANCEL_INJECTED_FAILURE: injected
  });
  assert.equal(review.status, 1, review.stderr);
  assert.ok(fs.existsSync(injected), "the real review worker must hit the pre-enqueue failure");
  const reviewId = withStateSnapshot(f.cwd, (state) => {
    const reviews = state.jobs.filter(job => job.jobClass === "review");
    assert.equal(reviews.length, 1);
    return reviews[0].id;
  });
  const before = readFixtureJobRecords(f.cwd, env, reviewId);
  withStateSnapshot(f.cwd, (_state, context) => {
    for (const record of before) {
      assert.equal(record.epoch, epoch);
      assert.equal(record.status, "failed");
      assert.equal(record.grokPromptState, "not-sent");
      assert.equal(record.terminationPending, false);
      assert.equal(record.grokSessionId, "g1-1");
      assert.equal(record.grokTransport, "broker");
      assert.equal(record.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
      assert.ok(record.startedAt && record.processStartKey);
      assert.equal(record.pid, null);
    }
    verifyPublishedLinuxLeaseRecords({ context, indexed: before[0], stored: before[1], lease: before[0].workerLease });
    assert.equal(withAvailableLinuxLease(before[0].workerLease, context, () => true).status, "available");
  });
  assert.deepEqual(f.logs().filter(row => row.prompt || row.terminal), []);
  const g1 = await f.connect();
  const proof = await g1.request("broker/cancelTurn", { sessionId: "g1-1", executionId: reviewId,
    generation: f.brokerIdentity.brokerGeneration });
  assert.equal(proof.executionState, "never-accepted");
  assert.equal(proof.notificationSent, false);
  await g1.close();
  const g1AgentPids = new Set(f.logs().map(row => row.started).filter(pid => Number.isSafeInteger(pid) && pid > 0));
  assert.equal(g1AgentPids.size, 1);
  const assertStopped = async (child, agentPids, label) => {
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
    await until(() => {
      const ps = spawnSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
      assert.equal(ps.status, 0, ps.stderr);
      return !ps.stdout.split("\n").map(line => line.trim().split(/\s+/)).some(([pid, pgid, stat]) =>
        stat && !stat.startsWith("Z") && (Number(pid) === child.pid || agentPids.has(Number(pid)) || Number(pgid) === child.pid));
    }, label, 3000);
  };
  const cleanupManaged = async (session, timeoutMs) => {
    const keys = ["TMPDIR", "TMP", "TEMP"];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) process.env[key] = f.cwd;
    try { return await cleanupIdleBrokerSession(f.cwd, session, { timeoutMs }); }
    finally { for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; }
  };
  assert.equal(await cleanupManaged(f.brokerSession, 10000), true,
    "G1 must stop through its own managed generation and clear its broker record");
  await f.brokerExited;
  assert.equal(f.brokerChild.exitCode, 0);
  await assertStopped(f.brokerChild, g1AgentPids, "G1 broker, agent and process group exit");
  assert.equal(withStateSnapshot(f.cwd, (_state, context) => context.epoch), epoch);
  let g2Child, g2Exited, g2Session;
  const g2Env = { ...env, CANCEL_SESSION_PREFIX: "g2-" };
  delete g2Env.GROK_COMPANION_ACP_ENDPOINT;
  delete g2Env.GROK_COMPANION_BROKER_GENERATION;
  let g2Address;
  f.cleanup(async () => {
    if (!g2Child) return;
    if (!g2Session) {
      await stopFixtureChild(g2Child);
      throw new Error("G2 admission did not return its owned identity; fixture retained");
    }
    const g2AgentPids = new Set(f.logs().map(row => row.started).filter(pid => Number.isSafeInteger(pid) && pid > 0 && !g1AgentPids.has(pid)));
    assert.ok(g2AgentPids.size > 0, "G2 agent identity must be recorded");
    assert.equal(await cleanupManaged(g2Session, 6000), true,
      "G2 must stop through its own managed generation");
    await g2Exited;
    assert.equal(g2Child.exitCode, 0);
    await assertStopped(g2Child, g2AgentPids, "G2 broker, agent and process group exit");
  });
  const started = await startFixtureBroker(f.cwd, g2Env, undefined, {
    broker: { ensureBrokerSession: (workspace, options) => ensureBrokerSession(workspace, { ...options, createBrokerEndpoint: undefined }) },
    onChild(child) {
    g2Child = child;
    g2Exited = new Promise(resolve => child.once("exit", resolve));
  } });
  g2Session = started.session;
  g2Address = g2Session.endpoint;
  assert.equal(started.child, g2Child);
  assert.notEqual(g2Session.generation, f.brokerIdentity.brokerGeneration);
  assert.equal(withStateSnapshot(f.cwd, (_state, context) => context.epoch), epoch);
  const g2Overrides = { ...g2Env, GROK_COMPANION_ACP_ENDPOINT: g2Address, GROK_COMPANION_BROKER_GENERATION: g2Session.generation };
  const first = cli(["task", "--json", "establish a G2 conversation"], g2Overrides);
  assert.equal(first.status, 0, first.stderr);
  const task = JSON.parse(first.stdout);
  assert.equal(task.grokSessionId, "g2-1");
  const control = await GrokAcpClient.connect(f.cwd, { env: g2Overrides, brokerEndpoint: g2Address, brokerOnly: true });
  try {
    const terminal = await control.request("broker/cancelTurn", { sessionId: task.grokSessionId,
      executionId: task.jobId, generation: g2Session.generation });
    assert.equal(terminal.executionState, "terminal");
    assert.equal(terminal.notificationSent, false);
  } finally { await control.close(); }
  assert.deepEqual(readFixtureJobRecords(f.cwd, env, reviewId), before);
  const resumed = cli(["task", "--resume-last", "--json", "continue G2 conversation"], g2Overrides);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).grokSessionId, task.grokSessionId);
  assert.ok(f.logs().some(row => row.loadedSession === task.grokSessionId));
  assert.deepEqual(readFixtureJobRecords(f.cwd, env, reviewId), before);
  assert.equal(withStateSnapshot(f.cwd, (_state, context) => context.epoch), epoch);
});

async function seededResumeFixture(t, records, { hostSession = "resume-host", sessions = [], seedBrokerHistory = true, seedListedSessions = seedBrokerHistory, extraRecords = [], agentEnv = {} } = {}) {
  const f = await fixture(t, { CANCEL_LIST_SESSIONS: JSON.stringify(sessions), ...agentEnv });
  initGitRepo(f.cwd);
  fs.writeFileSync(f.env.CANCEL_REVIEW_GATE, "release");
  const intentionallyUnsettled = new Set();
  const jobs = records.map(({ fixtureUnsettled, fixtureClaimTerminal, ...record }, index) => {
    const id = `seed-${index}`;
    if (fixtureUnsettled) intentionallyUnsettled.add(id);
    return { id, jobClass: "task", workspaceRoot: f.cwd,
      createdAt: `2020-01-0${index + 1}T00:00:00.000Z`, ...(hostSession ? { sessionId: hostSession } : {}), ...record,
      ...(fixtureUnsettled || fixtureClaimTerminal ? { grokTransport: "broker", grokBrokerGeneration: f.brokerIdentity.brokerGeneration } : {}),
      ...(fixtureClaimTerminal ? { grokPromptState: "terminal", terminationPending: false } : {}) };
  });
  // 状態ファイルだけでは現brokerの再開証拠にならない。既存の有効会話と
  // session/list候補は実promptのterminalを作り、未送信会話には作らない。
  const established = new Set(records.filter((record) => record.taskSessionResumable !== false).map((record) => record.grokSessionId));
  const unconfirmed = new Set(records.filter((record) => record.taskSessionResumable === false).map((record) => record.grokSessionId));
  const safeSessions = new Set(established);
  for (const session of sessions) {
    const sessionId = session.sessionId ?? session.id;
    if (sessionId && (!unconfirmed.has(sessionId) || established.has(sessionId))) safeSessions.add(sessionId);
  }
  const provenJobs = seedBrokerHistory ? jobs.filter(job => job.grokSessionId && job.taskSessionResumable !== false &&
    !intentionallyUnsettled.has(job.id)) : [];
  const historyRequests = provenJobs.map(job => ({ sessionId: job.grokSessionId, executionId: job.id }));
  for (const [index, sessionId] of (seedListedSessions ? [...safeSessions] : []).entries()) {
    if (sessionId && !historyRequests.some(item => item.sessionId === sessionId)) historyRequests.push({ sessionId, executionId: `resume-history-${index}` });
  }
  const unconfirmedJobs = seedBrokerHistory ? jobs.filter(job => job.grokSessionId && job.taskSessionResumable === false) : [];
  const unconfirmedProofs = {};
  if (seedBrokerHistory && (historyRequests.length || unconfirmedJobs.length)) {
    const owner = await f.connect();
    for (const { sessionId, executionId } of historyRequests) {
      assert.equal((await owner.request("session/prompt", { sessionId, executionId,
        prompt: [{ type: "text", text: JSON.stringify({ name: "resume-history-seed" }) }] })).stopReason, "end_turn");
      const proof = await owner.request("broker/cancelTurn", { sessionId, executionId, generation: f.brokerIdentity.brokerGeneration });
      assert.equal(proof.generation, f.brokerIdentity.brokerGeneration);
      assert.equal(proof.executionState, "terminal", "resume fixture requires actual terminal history in its broker");
      assert.equal(proof.notificationSent, false);
    }
    for (const job of unconfirmedJobs) {
      const proof = await owner.request("broker/cancelTurn", { sessionId: job.grokSessionId, executionId: job.id,
        generation: f.brokerIdentity.brokerGeneration });
      assert.equal(proof.generation, f.brokerIdentity.brokerGeneration);
      assert.equal(proof.executionState, "never-accepted", "unconfirmed fixture prompt must not have been accepted");
      assert.equal(proof.notificationSent, false);
      unconfirmedProofs[job.id] = proof;
    }
    await owner.close();
  }
  const env = { ...f.env, CLAUDE_PLUGIN_DATA: path.join(f.cwd, "data"), GROK_COMPANION_SESSION_ID: hostSession ?? "",
    CODEX_THREAD_ID: "", CANCEL_SEED_JOBS: JSON.stringify(jobs), CANCEL_SEED_EXTRA: JSON.stringify(extraRecords),
    CANCEL_PROVEN_IDS: JSON.stringify(provenJobs.map(job => job.id)), CANCEL_PROVEN_GENERATION: f.brokerIdentity.brokerGeneration };
  prepareFixtureState(f.cwd, env);
  const source = `import { updateState, writeJobFile } from ${JSON.stringify(new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href)};
    import { reserveLinuxTrackedJob } from ${JSON.stringify(new URL("../plugins/grok/scripts/lib/tracked-jobs.mjs", import.meta.url).href)};
    const jobs = JSON.parse(process.env.CANCEL_SEED_JOBS), proven = new Set(JSON.parse(process.env.CANCEL_PROVEN_IDS));
    if (process.platform === "linux") for (const job of jobs) reserveLinuxTrackedJob({ ...job, grokPromptState: "not-sent" });
    updateState(process.cwd(), (state, context) => {
      for (const job of jobs) {
        const reserved = state.jobs.find(record => record.id === job.id);
        const terminal = proven.has(job.id) ? { grokTransport: "broker",
          grokBrokerGeneration: process.env.CANCEL_PROVEN_GENERATION, grokPromptState: "terminal", terminationPending: false } : {};
        const record = process.platform === "linux" ? { ...reserved, ...job, ...terminal, epoch: context.epoch,
          claimToken: reserved.claimToken, workerLease: reserved.workerLease, pid: null, processStartKey: null } : { ...job, ...terminal };
        writeJobFile(process.cwd(), job.id, record);
        if (reserved) Object.assign(reserved, record); else state.jobs.push(record);
      }
      for (const extra of JSON.parse(process.env.CANCEL_SEED_EXTRA)) {
        const { currentEpoch, detailCurrentEpoch, detailGrokSessionId, ...raw } = extra;
        const record = currentEpoch ? { ...raw, epoch: context.epoch } : raw;
        const detail = { ...record, ...(detailCurrentEpoch ? { epoch: context.epoch } : {}),
          ...(detailGrokSessionId !== undefined ? { grokSessionId: detailGrokSessionId } : {}) };
        writeJobFile(process.cwd(), record.id, detail);
        state.jobs.push(record);
      }
    });`;
  const seeded = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: f.cwd, env, windowsHide: true, encoding: "utf8", timeout: 15000
  });
  assert.equal(seeded.status, 0, seeded.stderr);
  if (process.platform === "linux") for (const job of provenJobs) {
    withStateSnapshot(f.cwd, (state, context) => {
      const indexed = state.jobs.find(entry => entry.id === job.id);
      const stored = readJobFile(resolveJobFile(f.cwd, job.id));
      for (const entry of [indexed, stored]) {
        assert.equal(entry.epoch, context.epoch);
        assert.equal(entry.grokSessionId, job.grokSessionId);
        assert.equal(entry.grokTransport, "broker");
        assert.equal(entry.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
        assert.equal(entry.grokPromptState, "terminal");
        assert.equal(entry.terminationPending, false);
      }
      verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
      const released = withAvailableLinuxLease(indexed.workerLease, context, () => true);
      assert.equal(released.status, "available", "the seed owner must have exited and released its published lease");
    });
  }
  if (process.platform === "linux") for (const job of unconfirmedJobs) {
    const proof = unconfirmedProofs[job.id];
    assert.equal(proof.generation, f.brokerIdentity.brokerGeneration);
    assert.equal(proof.executionState, "never-accepted");
    assert.equal(proof.notificationSent, false);
    updateState(f.cwd, (state, context) => {
      const indexed = state.jobs.find(entry => entry.id === job.id);
      const stored = readJobFile(resolveJobFile(f.cwd, job.id));
      for (const entry of [indexed, stored]) {
        assert.equal(entry.epoch, context.epoch);
        assert.equal(entry.status, "cancelled");
        assert.equal(entry.grokSessionId, job.grokSessionId);
        assert.equal(entry.grokPromptState, "not-sent");
        assert.equal(entry.pid, null);
      }
      const evidence = { grokTransport: "broker", grokBrokerGeneration: proof.generation, terminationPending: false };
      writeJobFile(f.cwd, job.id, { ...stored, ...evidence });
      Object.assign(indexed, evidence);
    }, { aroundCommit(state, context, commit) {
      const indexed = state.jobs.find(entry => entry.id === job.id);
      const stored = readJobFile(resolveJobFile(f.cwd, job.id));
      verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
      const released = withAvailableLinuxLease(indexed.workerLease, context, () => {
        verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
        return commit();
      });
      assert.equal(released.status, "available", "unconfirmed seed owner must have released its lease before saving evidence");
      return released.value;
    } });
  }
  if (process.platform !== "linux") for (const job of unconfirmedJobs) {
    const proof = unconfirmedProofs[job.id];
    assert.equal(proof.executionState, "never-accepted");
    assert.equal(proof.generation, f.brokerIdentity.brokerGeneration);
    updateState(f.cwd, (state, context) => {
      const indexed = state.jobs.find(entry => entry.id === job.id);
      const stored = readJobFile(resolveJobFile(f.cwd, job.id));
      const evidence = { grokPromptState: "not-sent", grokTransport: "broker",
        grokBrokerGeneration: proof.generation, terminationPending: false };
      writeJobFile(f.cwd, job.id, { ...stored, ...evidence }, context);
      Object.assign(indexed, evidence);
    });
  }
  const cliEnvironment = overrides => ({ ...env, ...overrides });
  const cli = (args, overrides = {}) => spawnSync(process.execPath, [companion, ...args], {
    cwd: f.cwd, env: cliEnvironment(overrides), windowsHide: true, encoding: "utf8", timeout: 20000
  });
  const cliAsync = (args, overrides = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [companion, ...args], {
      cwd: f.cwd, env: cliEnvironment(overrides), windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Resume CLI timed out and exited with ${signal}: ${stderr}`));
      else resolve({ status, signal, stdout, stderr });
    });
  });
  return { ...f, cli, cliAsync, cliEnvironment, unconfirmedProofs };
}

for (const [label, established] of [
  ["legacy completed", { status: "completed" }],
  ["legacy cancelled", { status: "cancelled" }],
  ["confirmed failed", { status: "failed", taskSessionResumable: true }]
]) {
  test(`resume ${label === "confirmed failed" ? "preserves" : "rejects"} ${label} task history while excluding a newer unconfirmed session`, async (t) => {
    const legacy = label !== "confirmed failed";
    const f = await seededResumeFixture(t, [
      { ...established, grokSessionId: "established-session" },
      { status: "cancelled", grokSessionId: "empty-session", taskSessionResumable: false }
    ], legacy ? { seedBrokerHistory: false, seedListedSessions: true, sessions: [{ sessionId: "established-session", title: "Grok Companion Task existing conversation" }] } : {});
    const original = readFixtureJobRecords(f.cwd, f.env, "seed-0");
    const before = f.logs().length;
    const result = f.cli(["task", "--resume-last", "--json", "continue established conversation"]);
    if (legacy) {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /resume|candidate|broker|evidence|session/i);
      assertNoResumeAgentEffects(f, before);
      assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, "seed-0"), original);
    } else {
      assert.equal(result.status, 0, result.stderr);
      const task = JSON.parse(result.stdout);
      assert.equal(task.grokSessionId, "established-session");
      assert.equal(JSON.parse(f.cli(["status", "--json", task.jobId]).stdout).job.taskSessionResumable, true);
    }
  });
}

test("Linux rejects current not-sent review with broker generation but no transport or session", { skip: process.platform !== "linux" }, async (t) => {
  const f = await seededResumeFixture(t, [
    { status: "completed", grokSessionId: "candidate-session" },
    { jobClass: "review", status: "failed", grokSessionId: "prior-review-session" }
  ], { hostSession: null });
  const id = "seed-1";
  updateState(f.cwd, (state, context) => {
    const indexed = state.jobs.find(entry => entry.id === id);
    const stored = readJobFile(resolveJobFile(f.cwd, id));
    verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
    const released = withAvailableLinuxLease(indexed.workerLease, context, () => {
      verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
      const patch = { status: "failed", grokPromptState: "not-sent", terminationPending: false,
        grokSessionId: null, grokTransport: null, grokBrokerGeneration: f.brokerIdentity.brokerGeneration };
      writeJobFile(f.cwd, id, { ...stored, ...patch }, context);
      Object.assign(indexed, patch);
    });
    assert.equal(released.status, "available");
  });
  const previous = readFixtureJobRecords(f.cwd, f.env, id);
  withStateSnapshot(f.cwd, (_state, context) => {
    for (const entry of previous) {
      assert.equal(entry.epoch, context.epoch);
      assert.equal(entry.jobClass, "review");
      assert.equal(entry.status, "failed");
      assert.equal(entry.grokPromptState, "not-sent");
      assert.equal(entry.terminationPending, false);
      assert.equal(entry.grokSessionId, null);
      assert.equal(entry.grokTransport, null);
      assert.equal(entry.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
    }
    verifyPublishedLinuxLeaseRecords({ context, indexed: previous[0], stored: previous[1], lease: previous[0].workerLease });
    assert.equal(withAvailableLinuxLease(previous[0].workerLease, context, () => true).status, "available");
  });
  const before = f.logs().length;
  const result = f.cli(["task", "--resume-last", "--json", "continue candidate"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /pending|unverified|inconsistent|resume|session/i);
  assertNoResumeAgentEffects(f, before);
  assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, id), previous);
});


for (const epochKind of ["old", "current"]) {
  for (const variant of ["unknown transport", "null transport", "broker without generation"]) {
    test(`Linux rejects ${epochKind} terminal review with ${variant}`, { skip: process.platform !== "linux" }, async (t) => {
      const candidate = "candidate-terminal-session";
      const bad = { id: "old-invalid-terminal", jobClass: "review", epoch: randomUUID(), status: "failed",
        grokSessionId: candidate, grokPromptState: "terminal", terminationPending: false,
        grokTransport: variant === "unknown transport" ? "unknown" : variant === "null transport" ? null : "broker",
        grokBrokerGeneration: variant === "broker without generation" ? null : randomUUID() };
      const f = await seededResumeFixture(t, [
        { status: "completed", grokSessionId: candidate },
        ...(epochKind === "current" ? [{ jobClass: "review", status: "failed", grokSessionId: candidate }] : [])
      ], { hostSession: null, extraRecords: epochKind === "old" ? [bad] : [] });
      const id = epochKind === "old" ? bad.id : "seed-1";
      if (epochKind === "current") updateState(f.cwd, (state, context) => {
        const indexed = state.jobs.find(entry => entry.id === id);
        const stored = readJobFile(resolveJobFile(f.cwd, id));
        verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
        const released = withAvailableLinuxLease(indexed.workerLease, context, () => {
          verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
          const patch = { grokTransport: bad.grokTransport,
            grokBrokerGeneration: variant === "broker without generation" ? null : f.brokerIdentity.brokerGeneration };
          writeJobFile(f.cwd, id, { ...stored, ...patch }, context);
          Object.assign(indexed, patch);
        });
        assert.equal(released.status, "available");
      });
      const records = readFixtureJobRecords(f.cwd, f.env, id);
      withStateSnapshot(f.cwd, (_state, context) => {
        for (const entry of records) {
          assert.equal(entry.epoch === context.epoch, epochKind === "current");
          assert.equal(entry.jobClass, "review");
          assert.equal(entry.status, "failed");
          assert.equal(entry.grokSessionId, candidate);
          assert.equal(entry.grokPromptState, "terminal");
          assert.equal(entry.terminationPending, false);
          assert.equal(entry.grokTransport, bad.grokTransport);
          if (variant === "broker without generation") assert.equal(entry.grokBrokerGeneration, null);
          else assert.ok(entry.grokBrokerGeneration);
        }
        if (epochKind === "current") {
          verifyPublishedLinuxLeaseRecords({ context, indexed: records[0], stored: records[1], lease: records[0].workerLease });
          assert.equal(withAvailableLinuxLease(records[0].workerLease, context, () => true).status, "available");
        }
      });
      const control = await f.connect();
      const proof = await control.request("broker/cancelTurn", { sessionId: candidate,
        executionId: "seed-0", generation: f.brokerIdentity.brokerGeneration });
      assert.equal(proof.executionState, "terminal");
      assert.equal(proof.notificationSent, false);
      await control.close();
      const before = f.logs().length;
      const result = f.cli(["task", "--resume-last", "--json", "continue candidate"]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /pending|unverified|inconsistent|resume|session|transport/i);
      assertNoResumeAgentEffects(f, before);
      assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, id), records);
    });
  }
}

for (const epochKind of ["old", "current"]) {
  for (const variant of ["numeric session", "empty session", "whitespace generation"]) {
    test(`Linux rejects ${epochKind} terminal review with ${variant}`, { skip: process.platform !== "linux" }, async (t) => {
      const candidate = "typed-candidate-session";
      const bad = { id: "old-invalid-terminal-type", jobClass: "review", epoch: randomUUID(), status: "failed",
        grokSessionId: variant === "numeric session" ? 123 : variant === "empty session" ? "" : candidate,
        grokPromptState: "terminal", terminationPending: false, grokTransport: "broker",
        grokBrokerGeneration: variant === "whitespace generation" ? "   " : randomUUID() };
      const f = await seededResumeFixture(t, [
        { status: "completed", grokSessionId: candidate },
        ...(epochKind === "current" ? [{ jobClass: "review", status: "failed", grokSessionId: candidate }] : [])
      ], { hostSession: null, extraRecords: epochKind === "old" ? [bad] : [] });
      const id = epochKind === "old" ? bad.id : "seed-1";
      if (epochKind === "current") updateState(f.cwd, (state, context) => {
        const indexed = state.jobs.find(entry => entry.id === id);
        const stored = readJobFile(resolveJobFile(f.cwd, id));
        verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
        const released = withAvailableLinuxLease(indexed.workerLease, context, () => {
          verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
          const patch = { grokSessionId: bad.grokSessionId,
            grokBrokerGeneration: variant === "whitespace generation" ? "   " : f.brokerIdentity.brokerGeneration };
          writeJobFile(f.cwd, id, { ...stored, ...patch }, context);
          Object.assign(indexed, patch);
        });
        assert.equal(released.status, "available");
      });
      const records = readFixtureJobRecords(f.cwd, f.env, id);
      withStateSnapshot(f.cwd, (_state, context) => {
        for (const entry of records) {
          assert.equal(entry.epoch === context.epoch, epochKind === "current");
          assert.equal(entry.jobClass, "review");
          assert.equal(entry.status, "failed");
          assert.equal(entry.grokPromptState, "terminal");
          assert.equal(entry.terminationPending, false);
          assert.equal(entry.grokTransport, "broker");
          assert.equal(entry.grokSessionId, bad.grokSessionId);
          if (variant === "whitespace generation") assert.equal(entry.grokBrokerGeneration, "   ");
          else assert.ok(entry.grokBrokerGeneration);
        }
        if (epochKind === "current") {
          verifyPublishedLinuxLeaseRecords({ context, indexed: records[0], stored: records[1], lease: records[0].workerLease });
          assert.equal(withAvailableLinuxLease(records[0].workerLease, context, () => true).status, "available");
        }
      });
      const control = await f.connect();
      const proof = await control.request("broker/cancelTurn", { sessionId: candidate,
        executionId: "seed-0", generation: f.brokerIdentity.brokerGeneration });
      assert.equal(proof.executionState, "terminal");
      assert.equal(proof.notificationSent, false);
      await control.close();
      const before = f.logs().length;
      const result = f.cli(["task", "--resume-last", "--json", "continue candidate"]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /pending|unverified|inconsistent|resume|session|transport/i);
      assertNoResumeAgentEffects(f, before);
      assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, id), records);
    });
  }
}

test("legacy task state cannot resume without terminal history in the current broker", async (t) => {
  const f = await seededResumeFixture(t, [
    { status: "completed", grokSessionId: "previous-broker-session", fixtureClaimTerminal: true }
  ], { seedBrokerHistory: false });
  if (process.platform === "linux") {
    const records = readFixtureJobRecords(f.cwd, f.env, "seed-0");
    for (const record of records) {
      assert.equal(record.grokPromptState, "terminal");
      assert.equal(record.terminationPending, false);
      assert.equal(record.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
    }
    assert.deepEqual(f.logs().filter(row => row.prompt || row.terminal || row.loadedSession), [], "the broker has no corresponding terminal history");
  }
  const result = f.cli(["task", "--resume-last", "--json", "continue previous conversation"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /resume|source|execution|history|terminal/i);
  assert.deepEqual(f.logs().filter((row) => row.prompt || row.loadedSession), [], "unsafe resume must not reach the agent");
});

test("an unconfirmed job does not exclude an established job with the same Grok session", async (t) => {
  const f = await seededResumeFixture(t, [
    { status: "completed", grokSessionId: "shared-valid-session", taskSessionResumable: true },
    { status: "cancelled", grokSessionId: "shared-valid-session", taskSessionResumable: false }
  ], { hostSession: null });
  const established = readFixtureJobRecords(f.cwd, f.env, "seed-0");
  for (const record of established) {
    assert.equal(record.id, "seed-0");
    assert.equal(record.status, "completed");
    assert.equal(record.taskSessionResumable, true);
    assert.equal(record.grokSessionId, "shared-valid-session");
    assert.equal(record.grokPromptState, "terminal");
    assert.equal(record.terminationPending, false);
    assert.equal(record.grokTransport, "broker");
    assert.equal(record.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
  }
  const proofClient = await f.connect();
  const terminalProof = await proofClient.request("broker/cancelTurn", { sessionId: "shared-valid-session",
    executionId: "seed-0", generation: f.brokerIdentity.brokerGeneration });
  assert.equal(terminalProof.generation, f.brokerIdentity.brokerGeneration);
  assert.equal(terminalProof.executionState, "terminal");
  assert.equal(terminalProof.notificationSent, false);
  assert.equal(f.unconfirmedProofs["seed-1"].executionState, "never-accepted");
  assert.equal(f.unconfirmedProofs["seed-1"].generation, f.brokerIdentity.brokerGeneration);
  if (process.platform === "linux") {
    const records = readFixtureJobRecords(f.cwd, f.env, "seed-1");
    withStateSnapshot(f.cwd, (_state, context) => {
      for (const record of records) {
        assert.equal(record.epoch, context.epoch);
        assert.equal(record.status, "cancelled");
        assert.equal(record.grokSessionId, "shared-valid-session");
        assert.equal(record.grokPromptState, "not-sent");
        assert.equal(record.terminationPending, false);
        assert.equal(record.grokTransport, "broker");
        assert.equal(record.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
        assert.ok(record.claimToken && record.workerLease);
      }
      assert.equal(records[0].claimToken, records[1].claimToken);
      assert.equal(records[0].workerLease.id, records[1].workerLease.id);
      verifyPublishedLinuxLeaseRecords({ context, indexed: records[0], stored: records[1], lease: records[0].workerLease });
      assert.equal(withAvailableLinuxLease(records[0].workerLease, context, () => true).status, "available");
    });
  }
  const result = f.cli(["task", "--resume-last", "--json", "continue established conversation"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).grokSessionId, "shared-valid-session");
});

test("hostless session list skips an earlier unproven session for a later terminal session", { skip: process.platform !== "linux" }, async (t) => {
  const sessions = [{ sessionId: "first-unproven", title: "Grok Companion Task first" },
    { sessionId: "second-terminal", title: "Grok Companion Task second" }];
  const f = await fixture(t, { CANCEL_LIST_SESSIONS: JSON.stringify(sessions) });
  initGitRepo(f.cwd);
  const env = { ...f.env, GROK_COMPANION_SESSION_ID: "", CODEX_THREAD_ID: "" };
  prepareFixtureState(f.cwd, env);
  fs.writeFileSync(env.CANCEL_REVIEW_GATE, "release");
  const owner = await f.connect();
  const seed = await owner.request("session/prompt", { sessionId: "second-terminal", executionId: "second-source",
    prompt: [{ type: "text", text: JSON.stringify({ name: "second-terminal-seed" }) }] });
  assert.equal(seed.stopReason, "end_turn");
  const proof = await owner.request("broker/inspectResumeSessions", {
    sessionIds: sessions.map(session => session.sessionId), generation: f.brokerIdentity.brokerGeneration });
  assert.equal(proof.generation, f.brokerIdentity.brokerGeneration);
  assert.deepEqual(proof.sessions, [{ sessionId: "first-unproven", terminal: false }, { sessionId: "second-terminal", terminal: true }]);
  const before = f.logs().length;
  const result = spawnSync(process.execPath, [companion, "task", "--resume-last", "--json", "continue proven session"], {
    cwd: f.cwd, env, windowsHide: true, encoding: "utf8", timeout: 20000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).grokSessionId, "second-terminal");
  const later = f.logs().slice(before);
  assert.ok(later.some(row => row.loadedSession === "second-terminal"));
  assert.ok(later.some(row => row.prompt && row.params.sessionId === "second-terminal"));
  assert.equal(later.some(row => row.loadedSession === "first-unproven" || row.params?.sessionId === "first-unproven"), false);
});

for (const idKey of ["sessionId", "id"]) {
test(`hostless session-list fallback (${idKey}) skips a known unconfirmed session and selects an external valid one`, async (t) => {
  const f = await seededResumeFixture(t, [
    { status: "cancelled", grokSessionId: "empty-session", taskSessionResumable: false }
  ], { hostSession: null, sessions: [
    { [idKey]: "empty-session", title: "Grok Companion Task empty" },
    { [idKey]: "external-valid", title: "Grok Companion Task existing conversation" }
  ] });
  const result = f.cli(["task", "--resume-last", "--json", "continue existing conversation"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).grokSessionId, "external-valid");
  assert.ok(f.logs().some((row) => row.listedSessions));
  assert.ok(f.logs().some((row) => row.loadedSession === "external-valid"));
  assert.ok(f.logs().some((row) => row.prompt === "review-initial" && row.params.sessionId === "external-valid"));
  assert.ok(f.logs().every((row) => row.loadedSession !== "empty-session"));
});

test(`hostless session-list fallback (${idKey}) cannot recover a known unconfirmed empty session`, async (t) => {
  const f = await seededResumeFixture(t, [
    { status: "cancelled", grokSessionId: "empty-session", taskSessionResumable: false }
  ], { hostSession: null, sessions: [{ [idKey]: "empty-session", title: "Grok Companion Task empty" }] });
  const result = f.cli(["task", "--resume-last", "--json", "continue"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No previous Grok task thread/);
  assert.deepEqual(f.logs().filter((row) => row.prompt || row.loadedSession), []);
});
}

test("session-list exclusion and selection use canonical sessionId when a legacy id alias disagrees", async (t) => {
  const f = await seededResumeFixture(t, [
    { status: "cancelled", grokSessionId: "empty-session", taskSessionResumable: false }
  ], { hostSession: null, sessions: [
    { sessionId: "empty-session", id: "misleading-empty-alias", title: "Grok Companion Task empty" },
    { sessionId: "external-valid", id: "misleading-valid-alias", title: "Grok Companion Task existing conversation" }
  ] });
  const result = f.cli(["task", "--resume-last", "--json", "continue"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).grokSessionId, "external-valid");
});


const externalResumeSession = { sessionId: "external-valid", title: "Grok Companion Task existing conversation" };
function assertNoResumeAgentEffects(f, before) {
  const later = f.logs().slice(before);
  assert.deepEqual(later.filter(row => row.loadedSession || row.prompt || row.newSession || row.started), [],
    "unsafe resume must not load, prompt, create a session, or start another agent");
}

for (const mismatch of [false, true]) {
  for (const knownJobClass of [true, false]) {
    test(`hostless fallback rejects ${mismatch ? "inconsistent" : "old pending"} epoch history with ${knownJobClass ? "task" : "unknown"} job class`, { skip: process.platform !== "linux" }, async (t) => {
      const oldEpoch = randomUUID();
      const old = { id: "old-pending", ...(knownJobClass ? { jobClass: "task" } : {}), status: "running", terminationPending: true,
        grokSessionId: "external-valid", grokPromptState: "starting", taskSessionResumable: false, epoch: oldEpoch,
        ...(mismatch ? { detailCurrentEpoch: true } : {}) };
      const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [externalResumeSession], extraRecords: [old] });
      const previous = readFixtureJobRecords(f.cwd, f.env, old.id), before = f.logs().length;
      for (const record of previous) {
        assert.equal(record.grokSessionId, externalResumeSession.sessionId);
        assert.equal(record.jobClass, knownJobClass ? "task" : undefined);
        assert.equal(record.terminationPending, true);
      }
      assert.equal(previous[0].epoch, oldEpoch);
      assert.equal(previous[1].epoch === oldEpoch, !mismatch);
      const result = f.cli(["task", "--resume-last", "--json", "continue existing conversation"]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /epoch|pending|unverified|inconsistent|resume|session/i);
      assertNoResumeAgentEffects(f, before);
      assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, old.id), previous, "old history must remain unchanged");
    });
  }
}

for (const [label, fields] of [
  ["running with no start identity", { status: "running" }],
  ["queued with unknown transport", { status: "queued", grokTransport: "unknown" }],
  ["cancelled with unknown transport", { status: "cancelled", grokTransport: "unknown" }],
  ["queued with broker generation alone", { status: "queued", grokBrokerGeneration: randomUUID() }],
  ["cancelled with broker generation alone", { status: "cancelled", grokBrokerGeneration: randomUUID() }]
]) {
  test(`hostless resume rejects old not-sent review that is ${label}`, { skip: process.platform !== "linux" }, async (t) => {
    const old = { id: "old-contradictory-unsent", jobClass: "review", epoch: randomUUID(), ...fields,
      terminationPending: false, grokPromptState: "not-sent", grokSessionId: null, startedAt: null };
    const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [externalResumeSession], extraRecords: [old] });
    const currentEpoch = withStateSnapshot(f.cwd, (_state, context) => context.epoch);
    const previous = readFixtureJobRecords(f.cwd, f.env, old.id), before = f.logs().length;
    assert.notEqual(old.epoch, currentEpoch);
    for (const record of previous) {
      assert.equal(record.epoch, old.epoch);
      assert.equal(record.status, fields.status);
      assert.equal(record.grokPromptState, "not-sent");
      assert.equal(record.terminationPending, false);
      assert.equal(record.grokSessionId, null);
      assert.equal(record.startedAt, null);
      assert.equal(record.grokTransport ?? null, fields.grokTransport ?? null);
      assert.equal(record.grokBrokerGeneration ?? null, fields.grokBrokerGeneration ?? null);
    }
    assert.ok(f.logs().some(row => row.terminal === "resume-history-seed" && row.stopReason === "end_turn"),
      "the candidate must have a terminal in the managed broker");
    const result = f.cli(["task", "--resume-last", "--json", "continue existing conversation"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /pending|unverified|inconsistent|resume|session/i);
    assertNoResumeAgentEffects(f, before);
    assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, old.id), previous, "contradictory history must remain unchanged");
  });
}

for (const status of ["queued", "cancelled"]) {
  test(`hostless resume accepts old ${status} review with no agent or transport evidence`, { skip: process.platform !== "linux" }, async (t) => {
    const old = { id: "old-clean-unsent", jobClass: "review", epoch: randomUUID(), status,
      terminationPending: false, grokPromptState: "not-sent", grokSessionId: null, startedAt: null };
    const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [externalResumeSession], extraRecords: [old] });
    const currentEpoch = withStateSnapshot(f.cwd, (_state, context) => context.epoch);
    const previous = readFixtureJobRecords(f.cwd, f.env, old.id), before = f.logs().length;
    assert.notEqual(old.epoch, currentEpoch);
    for (const record of previous) {
      assert.equal(record.epoch, old.epoch);
      assert.equal(record.status, status);
      assert.equal(record.grokPromptState, "not-sent");
      assert.equal(record.terminationPending, false);
      assert.equal(record.grokSessionId, null);
      assert.equal(record.startedAt, null);
      for (const key of ["grokTransport", "grokBrokerGeneration", "grokDirectGeneration", "grokDirectOwnerPid",
        "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"]) {
        assert.equal(record[key] ?? null, null, key);
      }
    }
    assert.ok(f.logs().some(row => row.terminal === "resume-history-seed" && row.stopReason === "end_turn"),
      "the candidate must have a terminal in the managed broker");
    const result = f.cli(["task", "--resume-last", "--json", "continue existing conversation"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).grokSessionId, externalResumeSession.sessionId);
    assert.ok(f.logs().slice(before).some(row => row.loadedSession === externalResumeSession.sessionId));
    assert.ok(f.logs().slice(before).some(row => row.prompt && row.params.sessionId === externalResumeSession.sessionId));
    assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, old.id), previous, "clean old history must remain unchanged");
  });
}

for (const variant of ["unknown class", "review index matches", "review detail matches"]) {
  test(`hostless fallback rejects current epoch pending history with ${variant}`, { skip: process.platform !== "linux" }, async (t) => {
    const candidate = externalResumeSession.sessionId;
    const record = { id: "current-pending", currentEpoch: true, status: "running", terminationPending: true,
      grokPromptState: "starting", taskSessionResumable: false,
      ...(variant === "unknown class" ? { grokSessionId: candidate } : {
        jobClass: "review", grokSessionId: variant === "review index matches" ? candidate : "unrelated-review",
        detailGrokSessionId: variant === "review detail matches" ? candidate : "unrelated-review"
      }) };
    const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [externalResumeSession], extraRecords: [record] });
    const epoch = withStateSnapshot(f.cwd, (_state, context) => context.epoch);
    const previous = readFixtureJobRecords(f.cwd, f.env, record.id), before = f.logs().length;
    assert.ok(epoch);
    for (const entry of previous) {
      assert.equal(entry.epoch, epoch);
      assert.equal(entry.status, "running");
      assert.equal(entry.terminationPending, true);
      assert.equal(entry.jobClass, variant === "unknown class" ? undefined : "review");
    }
    assert.equal(previous[0].grokSessionId, variant === "review detail matches" ? "unrelated-review" : candidate);
    assert.equal(previous[1].grokSessionId, variant === "review index matches" ? "unrelated-review" : candidate);
    const result = f.cli(["task", "--resume-last", "--json", "continue existing conversation"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /pending|unverified|inconsistent|resume|session/i);
    assertNoResumeAgentEffects(f, before);
    assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, record.id), previous, "pending history must remain unchanged");
  });
}

for (const promptState of ["starting", "pending"]) {
  test(`hostless fallback rejects current task whose matching records have ${promptState} prompt state`, { skip: process.platform !== "linux" }, async (t) => {
    const f = await seededResumeFixture(t, [{ fixtureUnsettled: true, status: "completed", grokSessionId: externalResumeSession.sessionId,
      taskSessionResumable: true, grokPromptState: promptState, terminationPending: false }],
      { hostSession: null, sessions: [externalResumeSession] });
    const epoch = withStateSnapshot(f.cwd, (_state, context) => context.epoch);
    const previous = readFixtureJobRecords(f.cwd, f.env, "seed-0"), before = f.logs().length;
    for (const entry of previous) {
      assert.equal(entry.epoch, epoch);
      assert.equal(entry.jobClass, "task");
      assert.equal(entry.grokSessionId, externalResumeSession.sessionId);
      assert.equal(entry.grokPromptState, promptState);
      assert.equal(entry.terminationPending, false);
      assert.equal(entry.grokTransport, "broker");
      assert.equal(entry.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
      assert.ok(entry.workerLease && entry.claimToken);
    }
    assert.equal(previous[0].workerLease.id, previous[1].workerLease.id);
    withStateSnapshot(f.cwd, (_state, context) => {
      verifyPublishedLinuxLeaseRecords({ context, indexed: previous[0], stored: previous[1], lease: previous[0].workerLease });
      assert.equal(withAvailableLinuxLease(previous[0].workerLease, context, () => true).status, "available");
    });
    assert.ok(f.logs().some(row => row.prompt === "resume-history-seed" && row.params.sessionId === externalResumeSession.sessionId));
    const result = f.cli(["task", "--resume-last", "--json", "continue existing conversation"]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /pending|starting|unverified|inconsistent|resume|session/i);
    assertNoResumeAgentEffects(f, before);
    assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, "seed-0"), previous, "unsettled task records must remain unchanged");
  });
}

test("hostless fallback permits an established session alongside an unrelated verified review", { skip: process.platform !== "linux" }, async (t) => {
  const f = await seededResumeFixture(t, [{ jobClass: "review", status: "completed", grokSessionId: "unrelated-review" }],
    { hostSession: null, sessions: [externalResumeSession] });
  const epoch = withStateSnapshot(f.cwd, (_state, context) => context.epoch);
  const previous = readFixtureJobRecords(f.cwd, f.env, "seed-0"), before = f.logs().length;
  for (const entry of previous) {
    assert.equal(entry.epoch, epoch);
    assert.equal(entry.jobClass, "review");
    assert.equal(entry.grokSessionId, "unrelated-review");
    assert.equal(entry.status, "completed");
    assert.ok(entry.claimToken && entry.workerLease);
  }
  assert.equal(previous[0].claimToken, previous[1].claimToken);
  assert.equal(previous[0].workerLease.id, previous[1].workerLease.id);
  assert.ok(f.logs().some(row => row.prompt === "resume-history-seed" && row.params.sessionId === externalResumeSession.sessionId));
  assert.ok(f.logs().some(row => row.terminal === "resume-history-seed" && row.stopReason === "end_turn"));
  const result = f.cli(["task", "--resume-last", "--json", "continue existing conversation"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).grokSessionId, externalResumeSession.sessionId);
  const later = f.logs().slice(before);
  assert.ok(later.some(row => row.loadedSession === externalResumeSession.sessionId));
  assert.ok(later.some(row => row.prompt && row.params.sessionId === externalResumeSession.sessionId));
  assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, "seed-0"), previous);
});

async function directStopEvidenceFixture(t, epochKind, variant, { notSent = false } = {}) {
  const sessionId = "session-1";
  const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [{ sessionId, title: "Grok Companion Task existing conversation" }] });
  let nextChild, nextExit, nextSession;
  f.cleanup(async () => {
    if (!nextChild) return;
    let cleaned = false;
    try {
      if (nextChild.exitCode === null && nextChild.signalCode === null && nextSession) {
        const control = await GrokAcpClient.connect(f.cwd, { env: f.env, brokerEndpoint: nextSession.endpoint, brokerOnly: true });
        try { await control.request("broker/shutdown", {}, { signal: AbortSignal.timeout(5000) }); }
        finally { await control.close(); }
      }
      if (nextExit) await nextExit;
      assert.equal(nextChild.exitCode, 0, "replacement broker must exit normally");
      cleaned = true;
    } finally {
      if (!cleaned && nextChild.exitCode === null && nextChild.signalCode === null) await stopFixtureChild(nextChild);
    }
  });
  const direct = f.cli(["task", "--json", "establish a direct task"],
    { GROK_COMPANION_DISABLE_BROKER: "1", GROK_COMPANION_ACP_ENDPOINT: "" });
  assert.equal(direct.status, 0, direct.stderr);
  const task = JSON.parse(direct.stdout);
  assert.equal(task.grokSessionId, sessionId);
  const original = readFixtureJobRecords(f.cwd, f.env, task.jobId);
  let oldEpoch;
  withStateSnapshot(f.cwd, (_state, context) => {
    oldEpoch = context.epoch;
    for (const entry of original) {
      assert.equal(entry.epoch, oldEpoch);
      assert.equal(entry.status, "completed");
      assert.equal(entry.grokPromptState, "terminal");
      assert.equal(entry.terminationPending, false);
      assert.equal(entry.grokTransport, "direct");
      assert.ok(entry.grokDirectGeneration && entry.grokDirectStopConfirmedAt);
      assert.equal(entry.grokDirectStopGeneration, entry.grokDirectGeneration);
      assert.equal(entry.grokDirectStopKind, "posix-group-empty");
      assert.ok(Number.isInteger(entry.grokDirectOwnerPid) && entry.grokDirectOwnerPid > 0);
      assert.ok(entry.grokDirectOwnerStartKey);
      assert.equal(entry.grokDirectOwnerStartKey, entry.processStartKey);
      assert.equal(entry.workerLease.stateGeneration, oldEpoch);
    }
    verifyPublishedLinuxLeaseRecords({ context, indexed: original[0], stored: original[1], lease: original[0].workerLease });
    assert.equal(withAvailableLinuxLease(original[0].workerLease, context, () => true).status, "available");
  });
  if (variant !== "valid" || notSent) {
    updateState(f.cwd, (state, context) => {
      const indexed = state.jobs.find(entry => entry.id === task.jobId);
      const stored = readJobFile(resolveJobFile(f.cwd, task.jobId));
      verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
      const mutate = entry => {
        // 未送信を主張する不整合を、実 direct owner の証拠から作る負例。
        if (notSent) { entry.grokPromptState = "not-sent"; entry.grokSessionId = null; entry.sessionId = null; entry.startedAt = null; }
        if (variant === "missing generation") entry.grokDirectGeneration = null;
        if (variant === "missing stop proof") entry.grokDirectStopKind = null;
        if (variant === "mismatched stop generation") entry.grokDirectStopGeneration = randomUUID();
        if (variant === "missing timestamp") entry.grokDirectStopConfirmedAt = null;
        if (variant === "mismatched owner") entry.grokDirectOwnerStartKey = "other-owner";
      };
      mutate(indexed); mutate(stored);
      if (variant === "mismatched stop generation") {
        const wrong = randomUUID(); indexed.grokDirectStopGeneration = wrong; stored.grokDirectStopGeneration = wrong;
      }
      writeJobFile(f.cwd, task.jobId, stored);
    });
  }
  const evidence = readFixtureJobRecords(f.cwd, f.env, task.jobId);
  let cliOverrides = {};
  if (epochKind === "old") {
    await f.stopBroker();
    const agentPids = new Set(f.logs().map(row => row.started).filter(pid => Number.isSafeInteger(pid) && pid > 0));
    await until(() => {
      const ps = spawnSync("ps", ["-A", "-o", "pid=,stat="], { encoding: "utf8" });
      assert.equal(ps.status, 0, ps.stderr);
      return !ps.stdout.split("\n").map(line => line.trim().split(/\s+/)).some(([pid, stat]) =>
        agentPids.has(Number(pid)) && stat && !stat.startsWith("Z"));
    }, "old managed and direct agents exited", 5000);
    const stateDir = resolveStateDir(f.cwd);
    assert.equal(shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir }).stopped, true);
    const barrier = path.join(stateDir, "state.lock"), preserved = path.join(f.cwd, "previous-state-lock");
    const prior = fs.lstatSync(barrier, { bigint: true });
    assert.ok(prior.isDirectory() && !prior.isSymbolicLink());
    assert.equal(fs.existsSync(preserved), false);
    fs.renameSync(barrier, preserved);
    const kept = fs.lstatSync(preserved, { bigint: true });
    assert.equal(kept.dev, prior.dev); assert.equal(kept.ino, prior.ino);
    migrateStateLock(f.cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
    withStateSnapshot(f.cwd, (_state, context) => {
      assert.notEqual(context.epoch, oldEpoch);
      createLinuxEpochRecovery(context, { offlineConfirmed: true, localOnly: true, allOldProcessesStopped: true, expectedStateDir: stateDir });
    });
    assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, task.jobId), evidence, "migration must preserve prior direct evidence");
    const endpoint = `unix:${path.join(f.cwd, "next-broker.sock")}`;
    const next = await startFixtureBroker(f.cwd, f.env, endpoint, { onChild(child) {
      nextChild = child;
      nextExit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    } });
    nextSession = next.session;
    assert.notEqual(nextSession.generation, f.brokerIdentity.brokerGeneration);
    const owner = await GrokAcpClient.connect(f.cwd, { env: f.env, brokerEndpoint: endpoint, brokerOnly: true });
    try {
      const executionId = "next-broker-terminal";
      assert.equal((await owner.request("session/prompt", { sessionId, executionId,
        prompt: [{ type: "text", text: JSON.stringify({ name: "resume-history-seed" }) }] })).stopReason, "end_turn");
      const proof = await owner.request("broker/cancelTurn", { sessionId, executionId, generation: nextSession.generation });
      assert.equal(proof.generation, nextSession.generation);
      assert.equal(proof.executionState, "terminal");
      assert.equal(proof.notificationSent, false);
    } finally { await owner.close(); }
    cliOverrides = { GROK_COMPANION_ACP_ENDPOINT: endpoint, GROK_COMPANION_BROKER_GENERATION: nextSession.generation };
  }
  return { f, sessionId, id: task.jobId, evidence, oldEpoch, cliOverrides };
}

for (const epochKind of ["current", "old"]) {
  for (const variant of ["valid", "missing generation", "missing stop proof", "mismatched stop generation", "missing timestamp", "mismatched owner"]) {
    test(`resume rejects ${variant === "valid" ? "verified" : variant} ${epochKind} epoch direct task history`,
      { skip: process.platform !== "linux", timeout: 60000 }, async (t) => {
        const { f, sessionId, id, evidence, oldEpoch, cliOverrides } = await directStopEvidenceFixture(t, epochKind, variant);
        const currentEpoch = withStateSnapshot(f.cwd, (_state, context) => context.epoch);
        assert.equal(evidence[0].epoch, oldEpoch);
        assert.equal(evidence[1].epoch, oldEpoch);
        assert.equal(oldEpoch === currentEpoch, epochKind === "current");
        for (const record of evidence) {
          assert.equal(record.status, "completed");
          assert.equal(record.grokSessionId, sessionId);
          assert.equal(record.grokPromptState, "terminal");
          assert.equal(record.terminationPending, false);
          assert.equal(record.grokTransport, "direct");
          assert.equal(record.workerLease.stateGeneration, oldEpoch);
          if (variant === "missing generation") assert.equal(record.grokDirectGeneration, null);
          else assert.ok(record.grokDirectGeneration);
          if (variant === "missing stop proof") assert.equal(record.grokDirectStopKind, null);
          else assert.equal(record.grokDirectStopKind, "posix-group-empty");
          if (variant === "mismatched stop generation") assert.notEqual(record.grokDirectStopGeneration, record.grokDirectGeneration);
          if (variant === "missing timestamp") assert.equal(record.grokDirectStopConfirmedAt, null);
          if (variant === "mismatched owner") assert.notEqual(record.grokDirectOwnerStartKey, record.processStartKey);
        }
        const before = f.logs().length;
        const result = f.cli(["task", "--resume-last", "--json", "continue direct session"], cliOverrides);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /direct|stop|evidence|owner|generation|resume|session/i);
        assertNoResumeAgentEffects(f, before);
        assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, id), evidence, "direct stop evidence must remain unchanged");
      });
  }
}

for (const epochKind of ["current", "old"]) {
  for (const variant of ["missing stop proof", "mismatched stop generation", "missing timestamp", "mismatched owner"]) {
    test(`resume rejects ${epochKind} epoch not-sent direct history with ${variant}`,
      { skip: process.platform !== "linux", timeout: 60000 }, async (t) => {
        const { f, id, evidence, oldEpoch, cliOverrides } = await directStopEvidenceFixture(t, epochKind, variant, { notSent: true });
        const currentEpoch = withStateSnapshot(f.cwd, (_state, context) => context.epoch);
        assert.equal(oldEpoch === currentEpoch, epochKind === "current");
        for (const record of evidence) {
          assert.equal(record.epoch, oldEpoch);
          assert.equal(record.status, "completed");
          assert.equal(record.grokPromptState, "not-sent");
          assert.equal(record.grokSessionId, null);
          assert.equal(record.sessionId, null);
          assert.equal(record.startedAt, null);
          assert.equal(record.terminationPending, false);
          assert.equal(record.grokTransport, "direct");
          assert.ok(record.grokDirectGeneration);
          assert.equal(record.workerLease.stateGeneration, oldEpoch);
          if (variant === "missing stop proof") assert.equal(record.grokDirectStopKind, null);
          if (variant === "mismatched stop generation") assert.notEqual(record.grokDirectStopGeneration, record.grokDirectGeneration);
          if (variant === "missing timestamp") assert.equal(record.grokDirectStopConfirmedAt, null);
          if (variant === "mismatched owner") assert.notEqual(record.grokDirectOwnerStartKey, record.processStartKey);
        }
        const before = f.logs().length;
        const result = f.cli(["task", "--resume-last", "--json", "continue existing conversation"], cliOverrides);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /direct|stop|evidence|owner|generation/i);
        assertNoResumeAgentEffects(f, before);
        assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, id), evidence, "invalid direct evidence must remain unchanged");
      });
  }
}


for (const mode of ["busy", "capacity", "cancel"]) {
  test("Linux resumed task keeps verified broker " + mode + " rejection not-sent", { skip: process.platform !== "linux", timeout: 600000 }, async (t) => {
    const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [externalResumeSession] });
    const stateDir = resolveStateDir(f.cwd), preload = path.join(f.cwd, "verified-unsent-" + mode + ".cjs");
    const entered = path.join(f.cwd, "verified-unsent-entered"), release = path.join(f.cwd, "verified-unsent-release");
    const trace = path.join(f.cwd, "verified-unsent-rpc.jsonl"), holdRelease = path.join(f.cwd, "verified-unsent-holder-release");
    fs.writeFileSync(preload, "const fs=require(\"node:fs\"), path=require(\"node:path\"), net=require(\"node:net\"), moduleApi=require(\"node:module\");\nconst open=fs.openSync, close=fs.closeSync, write=net.Socket.prototype.write, emit=net.Socket.prototype.emit, handles=new Set();\nlet gated=false, promptSocket=null, promptId=null, buffer=\"\";\nError.stackTraceLimit=50;\nfs.openSync=function(file,flags,...args){\n  const fd=open.call(this,file,flags,...args), stack=new Error().stack;\n  if(!gated && process.argv[1] && path.resolve(process.argv[1])===process.env.UNSENT_MAIN && String(file)===process.env.UNSENT_STATE_DIR &&\n      stack.split(\"\\n\")[2]?.includes(\"withLinuxRootLock\") && stack.includes(\"updateState\") && stack.includes(\"enqueuePrompt\")) handles.add(fd);\n  return fd;\n};\nfs.closeSync=function(fd){\n  const marked=handles.delete(fd), result=close.call(this,fd);\n  if(marked && !gated){\n    const state=JSON.parse(fs.readFileSync(path.join(process.env.UNSENT_STATE_DIR,\"state.json\"),\"utf8\"));\n    const found=state.jobs.filter(job=>job.status===\"running\" && job.grokPromptState===\"pending\" && job.grokSessionId===process.env.UNSENT_SESSION);\n    if(found.length===1){\n      const job=found[0], detail=JSON.parse(fs.readFileSync(path.join(process.env.UNSENT_STATE_DIR,\"jobs\",job.id+\".json\"),\"utf8\"));\n      if(detail.grokPromptState===\"pending\" && detail.grokSessionId===job.grokSessionId){\n        gated=true; fs.writeFileSync(process.env.UNSENT_ENTERED,JSON.stringify({pid:process.pid,id:job.id}));\n        const deadline=Date.now()+15000, wait=new Int32Array(new SharedArrayBuffer(4));\n        while(!fs.existsSync(process.env.UNSENT_RELEASE)){\n          if(Date.now()>=deadline) throw new Error(\"unsent fixture gate timed out\");\n          Atomics.wait(wait,0,0,10);\n        }\n      }\n    }\n  }\n  return result;\n};\nnet.Socket.prototype.write=function(chunk,...args){\n  let message; try { message=JSON.parse(String(chunk).trim()); } catch {}\n  if(message?.method===\"session/prompt\" && message.id!==undefined){\n    promptSocket=this; promptId=message.id; buffer=\"\";\n    fs.appendFileSync(process.env.UNSENT_TRACE,JSON.stringify({event:\"request\",message})+\"\\n\");\n  }\n  return write.call(this,chunk,...args);\n};\nnet.Socket.prototype.emit=function(event,...args){\n  if(event===\"data\" && this===promptSocket){\n    buffer+=String(args[0]);\n    for(let end;(end=buffer.indexOf(\"\\n\"))>=0;){\n      const line=buffer.slice(0,end); buffer=buffer.slice(end+1);\n      try { const message=JSON.parse(line); if(message.id===promptId && !message.method)\n        fs.appendFileSync(process.env.UNSENT_TRACE,JSON.stringify({event:\"response\",message})+\"\\n\"); } catch {}\n    }\n  }\n  return emit.call(this,event,...args);\n};\nmoduleApi.syncBuiltinESMExports();");
    const control = await f.connect();
    if (mode === "capacity") {
      // seed の terminal 証明で 1 件を予約済み。上限ちょうどで initialize し、最後の 1 件だけ gate 後に追加する。
      for (let n = 0; n < 4095; n++) await cancel(control, "capacity-before-" + n);
    }
    const before = f.logs().length;
    const options = { NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "") + " --require=" + JSON.stringify(preload),
      UNSENT_MAIN: companion, UNSENT_STATE_DIR: stateDir, UNSENT_SESSION: externalResumeSession.sessionId,
      UNSENT_ENTERED: entered, UNSENT_RELEASE: release, UNSENT_TRACE: trace };
    let done, holderRequest;
    const running = f.cliAsync(["task", "--resume-last", "--json", "continue without forwarding"], options).then(
      result => { done = { result }; return result; }, error => { done = { error }; throw error; });
    void running.catch(() => {});
    try {
      await until(() => fs.existsSync(entered) || done, "pending-save gate for " + mode, 8000);
      assert.ok(fs.existsSync(entered), "CLI did not reach pending-save gate: " + JSON.stringify(done));
      const gate = JSON.parse(fs.readFileSync(entered, "utf8"));
      const epoch = withStateSnapshot(f.cwd, (_state, context) => context.epoch);
      for (const record of readFixtureJobRecords(f.cwd, f.env, gate.id)) {
        assert.equal(record.epoch, epoch);
        assert.equal(record.status, "running");
        assert.equal(record.pid, gate.pid);
        assert.equal(record.grokPromptState, "pending");
        assert.equal(record.grokSessionId, externalResumeSession.sessionId);
        assert.equal(record.grokTransport, "broker");
        assert.equal(record.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
      }
      assert.ok(f.logs().slice(before).some(row => row.loadedSession === externalResumeSession.sessionId));
      assert.equal(f.logs().slice(before).some(row => row.prompt), false, "resume prompt preceded the gate");
      if (mode === "busy") {
        const holder = await f.connect();
        holderRequest = holder.request("session/prompt", { sessionId: "busy-holder-session", executionId: "busy-holder-execution",
          prompt: [{ type: "text", text: JSON.stringify({ name: "busy-holder", gate: holdRelease, ignoreCancel: true }) }] });
        void holderRequest.catch(() => {});
        await until(() => f.logs().some(row => row.prompt === "busy-holder"), "broker busy holder");
      } else if (mode === "capacity") {
        await cancel(control, "capacity-overflow");
      } else {
        const reserved = await control.request("broker/cancelTurn", { sessionId: externalResumeSession.sessionId,
          executionId: gate.id, generation: f.brokerIdentity.brokerGeneration });
        assert.equal(reserved.generation, f.brokerIdentity.brokerGeneration);
        assert.equal(reserved.reservationAccepted, true);
        assert.equal(reserved.executionState, "never-accepted");
        assert.equal(reserved.notificationSent, false);
      }
      fs.writeFileSync(release, "release");
      const result = await running;
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.doesNotMatch(result.stderr + result.stdout, /fixture gate timed out/i);
      if (holderRequest) {
        fs.writeFileSync(holdRelease, "release");
        assert.equal((await holderRequest).stopReason, "end_turn");
      }
      const frames = fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
      const sent = frames.filter(frame => frame.event === "request"), received = frames.filter(frame => frame.event === "response");
      assert.equal(sent.length, 1, JSON.stringify(frames));
      assert.equal(received.length, 1, JSON.stringify(frames));
      assert.equal(sent[0].message.params.sessionId, externalResumeSession.sessionId);
      assert.equal(sent[0].message.params.executionId, gate.id);
      assert.equal(received[0].message.id, sent[0].message.id);
      const rejection = received[0].message.error;
      assert.equal(rejection?.code, mode === "busy" ? BROKER_BUSY_RPC_CODE : mode === "capacity" ? BROKER_CAPACITY_RPC_CODE : -32002);
      assert.equal(rejection?.data?.source, "grok-broker");
      assert.equal(rejection?.data?.promptForwarded, false);
      if (mode === "cancel") assert.equal(rejection?.data?.reason, "cancelled");
      assert.equal(f.logs().slice(before).some(row => row.prompt && row.params?.sessionId === externalResumeSession.sessionId), false,
        "rejected resume prompt reached the agent");
      const proof = await control.request("broker/cancelTurn", { sessionId: externalResumeSession.sessionId,
        executionId: gate.id, generation: f.brokerIdentity.brokerGeneration });
      assert.equal(proof.generation, f.brokerIdentity.brokerGeneration);
      assert.equal(proof.executionState, "never-accepted");
      assert.equal(proof.notificationSent, false);
      for (const record of readFixtureJobRecords(f.cwd, f.env, gate.id)) {
        assert.equal(record.status, "failed");
        assert.equal(record.phase, "failed");
        assert.equal(record.pid, null);
        assert.equal(record.epoch, epoch);
        assert.equal(record.grokPromptState, "not-sent", "verified unforwarded prompt must stay not-sent");
        assert.equal(record.terminationPending, false, "verified unforwarded prompt must not remain pending");
        assert.equal(record.taskSessionResumable, false, "unforwarded turn must not establish session history");
        assert.equal(record.grokSessionId, externalResumeSession.sessionId);
        assert.equal(record.grokTransport, "broker");
        assert.equal(record.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
      }
      if (mode !== "capacity") {
        const resumed = f.cli(["task", "--resume-last", "--json", "continue valid conversation"]);
        assert.equal(resumed.status, 0, resumed.stderr);
        assert.equal(JSON.parse(resumed.stdout).grokSessionId, externalResumeSession.sessionId);
      }
    } finally {
      fs.writeFileSync(release, "release");
      fs.writeFileSync(holdRelease, "release");
      if (holderRequest) await holderRequest.catch(() => {});
      if (!done) await running.catch(() => {});
    }
  });
}

test("resume keeps its job not-sent when a concurrent pending record blocks prompt enqueue", { skip: process.platform !== "linux", timeout: 45000 }, async (t) => {
  const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [externalResumeSession] });
  const stateDir = resolveStateDir(f.cwd), preload = path.join(f.cwd, "resume-pending-gate.cjs");
  const entered = path.join(f.cwd, "resume-pending-entered"), release = path.join(f.cwd, "resume-pending-release"), passed = path.join(f.cwd, "resume-pending-passed");
  fs.writeFileSync(preload, String.raw`
const fs = require("node:fs"), path = require("node:path"), moduleApi = require("node:module");
const open = fs.openSync, close = fs.closeSync, handles = new Set();
let gated = false;
Error.stackTraceLimit = 50;
fs.openSync = function(file, flags, ...args) {
  const fd = open.call(this, file, flags, ...args), stack = new Error().stack;
  if (!gated && process.argv[1] && path.resolve(process.argv[1]) === process.env.RESUME_PENDING_MAIN &&
      String(file) === process.env.RESUME_PENDING_STATE_DIR && stack.split("\n")[2]?.includes("withLinuxRootLock") &&
      stack.includes("updateState") && stack.includes("enqueuePrompt")) handles.add(fd);
  return fd;
};
fs.closeSync = function(fd) {
  const marked = handles.delete(fd), result = close.call(this, fd);
  if (marked && !gated) {
    const state = JSON.parse(fs.readFileSync(path.join(process.env.RESUME_PENDING_STATE_DIR, "state.json"), "utf8"));
    const matching = state.jobs.filter(job => job.status === "running" && job.grokPromptState === "pending" &&
      job.grokSessionId === process.env.RESUME_PENDING_SESSION);
    if (matching.length === 1) {
      const job = matching[0], detail = JSON.parse(fs.readFileSync(path.join(process.env.RESUME_PENDING_STATE_DIR, "jobs", job.id + ".json"), "utf8"));
      if (detail.grokPromptState === "pending" && detail.grokSessionId === job.grokSessionId) {
        gated = true;
        fs.writeFileSync(process.env.RESUME_PENDING_ENTERED, JSON.stringify({ pid: process.pid, id: job.id }));
        const deadline = Date.now() + 15000, wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(process.env.RESUME_PENDING_RELEASE)) {
          if (Date.now() >= deadline) throw new Error("resume pending fixture gate timed out");
          Atomics.wait(wait, 0, 0, 10);
        }
        fs.writeFileSync(process.env.RESUME_PENDING_PASSED, "passed");
      }
    }
  }
  return result;
};
moduleApi.syncBuiltinESMExports();
`);
  const before = f.logs().length;
  const options = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim(),
    RESUME_PENDING_MAIN: companion, RESUME_PENDING_STATE_DIR: stateDir, RESUME_PENDING_SESSION: externalResumeSession.sessionId,
    RESUME_PENDING_ENTERED: entered, RESUME_PENDING_RELEASE: release, RESUME_PENDING_PASSED: passed };
  let completion;
  const running = f.cliAsync(["task", "--resume-last", "--json", "continue existing conversation"], options).then(
    result => { completion = { result }; return result; }, error => { completion = { error }; throw error; });
  void running.catch(() => {});
  try {
    await until(() => fs.existsSync(entered) || completion, "pending-save gate", 8000);
    assert.ok(fs.existsSync(entered), `CLI did not reach the pending-save gate: ${JSON.stringify(completion)}`);
    const gate = JSON.parse(fs.readFileSync(entered, "utf8"));
    const pending = readFixtureJobRecords(f.cwd, f.env, gate.id);
    const epoch = withStateSnapshot(f.cwd, (_state, context) => context.epoch);
    for (const record of pending) {
      assert.equal(record.epoch, epoch);
      assert.equal(record.pid, gate.pid);
      assert.equal(record.status, "running");
      assert.equal(record.grokSessionId, externalResumeSession.sessionId);
      assert.equal(record.grokPromptState, "pending");
      assert.equal(record.grokTransport, "broker");
      assert.equal(record.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
    }
    const soFar = f.logs().slice(before);
    assert.ok(soFar.some(row => row.loadedSession === externalResumeSession.sessionId), "session/load must succeed before the gate");
    assert.equal(soFar.some(row => row.prompt), false, "the resumed prompt must not be sent before the gate");
    const id = "concurrent-after-pending";
    updateState(f.cwd, (state, context) => {
      assert.ok(!state.jobs.some(entry => entry.id === id));
      const record = { id, epoch: context.epoch, status: "running", terminationPending: true,
        grokSessionId: externalResumeSession.sessionId, grokPromptState: "pending" };
      writeJobFile(f.cwd, id, record);
      state.jobs.push(record);
    });
    const injected = readFixtureJobRecords(f.cwd, f.env, id);
    for (const record of injected) {
      assert.equal(record.epoch, epoch);
      assert.equal(record.grokSessionId, externalResumeSession.sessionId);
      assert.equal(record.grokPromptState, "pending");
      assert.equal(record.terminationPending, true);
    }
    fs.writeFileSync(release, "release");
    const result = await running;
    assert.ok(fs.existsSync(passed), "the pending-save gate must be released without timing out");
    assert.doesNotMatch(result.stderr, /fixture gate timed out/i);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr + result.stdout, /pending|unverified|inconsistent|resume|session/i);
    assert.equal(f.logs().slice(before).some(row => row.prompt), false, "resume rejection must not reach the agent as a prompt");
    for (const record of readFixtureJobRecords(f.cwd, f.env, gate.id)) {
      assert.equal(record.grokPromptState, "not-sent", "an unsent prompt must not be recorded as terminal or pending");
      assert.equal(record.taskSessionResumable, false, "an unsent prompt must not be marked resumable");
    }
    assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, id), injected, "concurrent evidence must remain unchanged");
  } finally {
    fs.writeFileSync(release, "release");
    if (!completion) await running.catch(() => {});
  }
});

test("resume rechecks a concurrently added pending record before session load", { skip: process.platform !== "linux", timeout: 45000 }, async (t) => {
  const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [externalResumeSession] });
  const preload = path.join(f.cwd, "resume-reconnect-gate.cjs");
  const entered = path.join(f.cwd, "resume-reconnect-entered"), release = path.join(f.cwd, "resume-reconnect-release"), passed = path.join(f.cwd, "resume-reconnect-passed");
  fs.writeFileSync(preload, String.raw`
const fs = require("node:fs"), net = require("node:net"), path = require("node:path");
if (process.argv[1] && path.resolve(process.argv[1]) === process.env.RESUME_GATE_MAIN) {
  const write = net.Socket.prototype.write, wait = new Int32Array(new SharedArrayBuffer(4));
  let listed = false, gated = false;
  net.Socket.prototype.write = function(chunk, ...args) {
    let message;
    try { message = JSON.parse(String(chunk)); } catch {}
    if (message?.method === "session/list") listed = true;
    if (listed && !gated && message?.method === "initialize") {
      gated = true;
      fs.writeFileSync(process.env.RESUME_GATE_ENTERED, JSON.stringify({ pid: process.pid, listed }));
      const deadline = Date.now() + 12000;
      while (!fs.existsSync(process.env.RESUME_GATE_RELEASE)) {
        if (Date.now() >= deadline) throw new Error("resume reconnect fixture gate timed out");
        Atomics.wait(wait, 0, 0, 10);
      }
      fs.writeFileSync(process.env.RESUME_GATE_PASSED, "passed");
    }
    return write.call(this, chunk, ...args);
  };
}
`);
  const before = f.logs().length;
  const options = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`.trim(),
    RESUME_GATE_MAIN: companion, RESUME_GATE_ENTERED: entered, RESUME_GATE_RELEASE: release, RESUME_GATE_PASSED: passed };
  let completion;
  const running = f.cliAsync(["task", "--resume-last", "--json", "continue existing conversation"], options).then(
    result => { completion = { result }; return result; }, error => { completion = { error }; throw error; });
  void running.catch(() => {});
  try {
    await until(() => fs.existsSync(entered) || completion, "CLI reconnect gate", 8000);
    assert.ok(fs.existsSync(entered), `CLI did not reach the post-list reconnect gate: ${JSON.stringify(completion)}`);
    const gate = JSON.parse(fs.readFileSync(entered, "utf8"));
    assert.equal(gate.listed, true);
    assert.ok(Number.isSafeInteger(gate.pid) && gate.pid > 0);
    assert.ok(f.logs().slice(before).some(row => row.listedSessions), "managed broker must have delivered the candidate list");
    assertNoResumeAgentEffects(f, before);
    const id = "concurrent-unknown-pending";
    updateState(f.cwd, (state, context) => {
      assert.ok(context.epoch);
      assert.ok(!state.jobs.some(entry => entry.id === id));
      const record = { id, epoch: context.epoch, status: "running", terminationPending: true,
        grokSessionId: externalResumeSession.sessionId, grokPromptState: "pending" };
      writeJobFile(f.cwd, id, record);
      state.jobs.push(record);
    });
    const saved = readFixtureJobRecords(f.cwd, f.env, id);
    const epoch = withStateSnapshot(f.cwd, (_state, context) => context.epoch);
    for (const record of saved) {
      assert.equal(record.epoch, epoch);
      assert.equal(record.jobClass, undefined);
      assert.equal(record.grokSessionId, externalResumeSession.sessionId);
      assert.equal(record.grokPromptState, "pending");
      assert.equal(record.terminationPending, true);
    }
    fs.writeFileSync(release, "release");
    const result = await running;
    assert.ok(fs.existsSync(passed), "the reconnect gate must have been released without timing out");
    assert.doesNotMatch(result.stderr, /fixture gate timed out/i);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /pending|unverified|inconsistent|resume|session/i);
    assertNoResumeAgentEffects(f, before);
    assert.deepEqual(readFixtureJobRecords(f.cwd, f.env, id), saved, "concurrent evidence must remain unchanged");
  } finally {
    fs.writeFileSync(release, "release");
    if (!completion) await running.catch(() => {});
  }
});

test("tracked resume binds the source execution and strips proof before agent load", async (t) => {
  const f = await fixture(t);
  const owner = await f.connect();
  const session = await owner.request("session/new", { cwd: f.cwd, mcpServers: [] });
  assert.equal(session.sessionId, "session-1");
  assert.equal((await prompt(owner, "source-execution", { name: "source-terminal" })).stopReason, "end_turn");
  const metadata = owner.initializeResult?._meta;
  assert.equal(metadata?.grokResumeExecutionProof, true);
  assert.equal(metadata.grokBrokerGeneration, f.brokerIdentity.brokerGeneration);
  const before = f.logs().length;
  await assert.rejects(runGrokTurn(f.cwd, { env: f.env, prompt: "missing generation",
    resumeSessionId: session.sessionId, resumeExecutionId: "source-execution" }), /execution identity|generation/i);
  assertNoResumeAgentEffects(f, before);
  await assert.rejects(runGrokTurn(f.cwd, { env: f.env, prompt: JSON.stringify({ name: "invalid-source-resume" }),
    resumeSessionId: session.sessionId, resumeExecutionId: "unknown-source-execution",
    resumeBrokerGeneration: f.brokerIdentity.brokerGeneration }), /resume|history|execution|terminal/i);
  assertNoResumeAgentEffects(f, before);
  const result = await runGrokTurn(f.cwd, { env: f.env, prompt: JSON.stringify({ name: "bound-source-resume" }),
    resumeSessionId: session.sessionId, resumeExecutionId: "source-execution",
    resumeBrokerGeneration: f.brokerIdentity.brokerGeneration });
  assert.equal(result.status, "completed", result.error?.message);
  assert.equal(result.sessionId, session.sessionId);
  const loaded = f.logs().slice(before).filter(row => row.loadedSession === session.sessionId);
  assert.equal(loaded.length, 1);
  assert.equal(Object.hasOwn(loaded[0].loadParams, "grokResumeExecutionId"), false);
  assert.equal(Object.hasOwn(loaded[0].loadParams, "grokResumeGeneration"), false);
  assert.ok(f.logs().slice(before).some(row => row.prompt === "bound-source-resume"));
  // 実 broker の initialize 応答から新 capability だけを隠し、旧 broker 相当を再現する。
  const preload = path.join(f.cwd, "mask-resume-capability.cjs"), observed = path.join(f.cwd, "resume-capability-masked");
  fs.writeFileSync(preload, "const net=require(\"node:net\"),fs=require(\"node:fs\"),original=net.Socket.prototype.emit,buffers=new WeakMap();\nnet.Socket.prototype.emit=function(event,...args){\n  if(event!==\"data\") return original.call(this,event,...args);\n  let buffer=(buffers.get(this)||\"\")+String(args[0]), end, emitted=false;\n  while((end=buffer.indexOf(\"\\n\"))>=0){\n    let line=buffer.slice(0,end); buffer=buffer.slice(end+1);\n    try { const reply=JSON.parse(line); if(reply.result?._meta?.grokBrokerGeneration===process.env.MASK_GENERATION &&\n        reply.result._meta.grokResumeExecutionProof===true){\n      delete reply.result._meta.grokResumeExecutionProof; line=JSON.stringify(reply); fs.writeFileSync(process.env.MASK_OBSERVED,\"masked\");\n    } } catch {}\n    emitted=original.call(this,event,typeof args[0]===\"string\"?line+\"\\n\":Buffer.from(line+\"\\n\"),...args.slice(1))||emitted;\n  }\n  buffers.set(this,buffer); return emitted||true;\n};");
  const moduleUrl = new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url).href;
  const source = "import {runGrokTurn} from " + JSON.stringify(moduleUrl) + "; try { await runGrokTurn(" + JSON.stringify(f.cwd) +
    ",{env:process.env,prompt:'old capability',resumeSessionId:'session-1',resumeExecutionId:'source-execution',resumeBrokerGeneration:process.env.MASK_GENERATION});" +
    "process.exitCode=7; } catch(error) { console.log(error.message); }";
  const beforeLegacy = f.logs().length;
  const legacy = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd, encoding: "utf8", timeout: 20000,
    env: { ...f.env, NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "") + " --require=" + JSON.stringify(preload),
      MASK_GENERATION: f.brokerIdentity.brokerGeneration, MASK_OBSERVED: observed } });
  assert.equal(legacy.error, undefined, legacy.error?.message);
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(fs.readFileSync(observed, "utf8"), "masked", "real broker initialize capability must be removed");
  assert.match(legacy.stdout, /broker cannot verify the tracked execution history/i);
  assertNoResumeAgentEffects(f, beforeLegacy);
});

test("runGrokTurn rejects a mismatched broker generation before loading an established session", { skip: process.platform !== "linux" }, async (t) => {
  const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [externalResumeSession] });
  assert.ok(f.logs().some(row => row.terminal === "resume-history-seed" && row.stopReason === "end_turn"), "current broker must have actual terminal history");
  let mismatchedGeneration = randomUUID();
  while (mismatchedGeneration === f.brokerIdentity.brokerGeneration) mismatchedGeneration = randomUUID();
  const before = f.logs().length;
  await assert.rejects(runGrokTurn(f.cwd, { env: f.env, prompt: "continue existing conversation",
    resumeSessionId: externalResumeSession.sessionId, resumeBrokerGeneration: mismatchedGeneration }), /broker generation changed/i);
  assertNoResumeAgentEffects(f, before);
});

test("hostless fallback rejects a candidate without terminal history in the current broker", { skip: process.platform !== "linux" }, async (t) => {
  const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [externalResumeSession], seedBrokerHistory: false });
  const before = f.logs().length;
  const result = f.cli(["task", "--resume-last", "--json", "continue existing conversation"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /No previous Grok task thread/);
  assert.ok(f.logs().slice(before).some(row => row.listedSessions), "the candidate must come from the current broker session list");
  assertNoResumeAgentEffects(f, before);
});

for (const mode of ["stopped explicit endpoint", "broker disabled"]) {
  test(`hostless fallback does not escape to a direct agent with ${mode}`, { skip: process.platform !== "linux" }, async (t) => {
    const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [externalResumeSession] });
    await f.stopBroker();
    const overrides = mode === "broker disabled"
      ? { GROK_COMPANION_ACP_ENDPOINT: "", GROK_COMPANION_DISABLE_BROKER: "1" }
      : { GROK_COMPANION_ACP_ENDPOINT: f.env.GROK_COMPANION_ACP_ENDPOINT, GROK_COMPANION_DISABLE_BROKER: "" };
    const effectiveEnv = f.cliEnvironment(overrides);
    assert.equal(effectiveEnv.GROK_COMPANION_ACP_ENDPOINT, mode === "broker disabled" ? "" : f.env.GROK_COMPANION_ACP_ENDPOINT);
    assert.equal(effectiveEnv.GROK_COMPANION_DISABLE_BROKER, mode === "broker disabled" ? "1" : "");
    const before = f.logs().length;
    const result = f.cli(["task", "--resume-last", "--json", "continue existing conversation"], overrides);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /broker|resume|session|transport|endpoint/i);
    assertNoResumeAgentEffects(f, before);
  });
}

test("hostless fallback rejects an unmanaged explicit endpoint without direct fallback", { skip: process.platform !== "linux" }, async (t) => {
  const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [externalResumeSession] });
  const address = path.join(f.cwd, "unmanaged.sock"), generation = randomUUID(), received = [], sockets = new Set();
  let connections = 0;
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"), message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1); received.push(message);
        if (message.id === undefined) continue;
        const result = message.method === "initialize" ? { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
          _meta: { grokBrokerGeneration: generation, grokScopedCancellation: true, grokExecutionLedger: true, grokPromptAdmission: true } }
          : message.method === "session/list" ? { sessions: [externalResumeSession] }
            : message.method === "session/new" ? { sessionId: "unexpected-new" } : {};
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  f.cleanup(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  const before = f.logs().length;
  const result = await f.cliAsync(["task", "--resume-last", "--json", "continue existing conversation"],
    { GROK_COMPANION_ACP_ENDPOINT: `unix:${address}` });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /broker|resume|session|transport|endpoint/i);
  assertNoResumeAgentEffects(f, before);
  assert.equal(connections, 0, "unmanaged endpoint must be rejected before connecting");
  assert.deepEqual(received, [], "unmanaged endpoint must not receive any request");
});

test("hostless fallback cannot replace a resume with a new session when load is unsupported", async (t) => {
  const f = await seededResumeFixture(t, [], { hostSession: null, sessions: [externalResumeSession], agentEnv: { CANCEL_NO_LOAD_SESSION: "1" } });
  const control = await f.connect();
  assert.equal(control.initializeResult.agentCapabilities.loadSession, false);
  await control.close();
  const before = f.logs().length;
  const result = f.cli(["task", "--resume-last", "--json", "continue existing conversation"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /load|resume|session|support/i);
  assertNoResumeAgentEffects(f, before);
});
