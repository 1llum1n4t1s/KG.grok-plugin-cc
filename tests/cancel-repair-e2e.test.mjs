import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { interruptGrokTurn, runGrokReview, runGrokTurn } from "../plugins/grok/scripts/lib/grok.mjs";
import { initGitRepo, run } from "./helpers.mjs";
import { fixture, pause, stopFixtureChild, until } from "./cancel-repair-fixture.mjs";
import { loadState, readJobFile, resolveJobFile, migrateStateLock, resolveNativeStateLockEndpoint, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

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
      : path.join(stateDir, "state.lock", "native.lock");
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
        timeout: 10000, windowsHide: true, encoding: "utf8" });
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
};
fs.appendFileSync = function(target, content, ...args) {
  const result = append.call(this, target, content, ...args);
  if (String(content).includes("Session ready (session-2).")) armed = true;
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
  // 先行取得は成功時だけ数え、次の取得より前に止める。FDは開いているがlockは未取得。
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
  worker.stdout.resume();
  let stderr = "";
  worker.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => worker.on("exit", resolve));
  f.cleanup(async () => {
    fs.writeFileSync(env.CANCEL_REVIEW_GATE + ".allow-first", "release");
    await stopFixtureChild(worker);
    await exited;
  });
  await until(() => {
    if (worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Worker exited before its barrier: ${stderr}`);
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
  for (const record of readBoth()) assert.equal(record.grokPromptState, promptState);
  const cancelled = cli(["cancel", "--json", empty.id]);
  if (posix) {
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
    fs.writeFileSync(env.CANCEL_REVIEW_GATE + ".allow-first", "release");
  }
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
    assert.equal(completed.grokPromptState, promptState);
  }
  assert.equal(JSON.parse(cli(["status", "--json", empty.id]).stdout).job.taskSessionResumable, false);
  assert.ok(!f.logs().some((row) => row.prompt && row.params.sessionId === "session-2"));
  const resumed = cli(["task", "--resume-last", "--json", "continue valid conversation"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).grokSessionId, valid.grokSessionId,
    "resume-last must keep the last session that actually received a task prompt");
});

async function seededResumeFixture(t, records, { hostSession = "resume-host", sessions = [], seedBrokerHistory = true } = {}) {
  const f = await fixture(t, { CANCEL_LIST_SESSIONS: JSON.stringify(sessions) });
  initGitRepo(f.cwd);
  fs.writeFileSync(f.env.CANCEL_REVIEW_GATE, "release");
  const jobs = records.map((record, index) => ({ id: `seed-${index}`, jobClass: "task", workspaceRoot: f.cwd,
    createdAt: `2020-01-0${index + 1}T00:00:00.000Z`, ...(hostSession ? { sessionId: hostSession } : {}), ...record }));
  // 状態ファイルだけでは現brokerの再開証拠にならない。既存の有効会話と
  // session/list候補は実promptのterminalを作り、未送信会話には作らない。
  const established = new Set(records.filter((record) => record.taskSessionResumable !== false).map((record) => record.grokSessionId));
  const unconfirmed = new Set(records.filter((record) => record.taskSessionResumable === false).map((record) => record.grokSessionId));
  const safeSessions = new Set(established);
  for (const session of sessions) {
    const sessionId = session.sessionId ?? session.id;
    if (sessionId && (!unconfirmed.has(sessionId) || established.has(sessionId))) safeSessions.add(sessionId);
  }
  if (seedBrokerHistory && safeSessions.size) {
    const owner = await f.connect();
    for (const [index, sessionId] of [...safeSessions].entries()) {
      const executionId = `resume-history-${index}`;
      assert.equal((await owner.request("session/prompt", { sessionId, executionId,
        prompt: [{ type: "text", text: JSON.stringify({ name: "resume-history-seed" }) }] })).stopReason, "end_turn");
      const proof = await owner.request("broker/cancelTurn", { sessionId, executionId, generation: f.brokerIdentity.brokerGeneration });
      assert.equal(proof.generation, f.brokerIdentity.brokerGeneration);
      assert.equal(proof.executionState, "terminal", "resume fixture requires actual terminal history in its broker");
      assert.equal(proof.notificationSent, false);
    }
    await owner.close();
  }
  const env = { ...f.env, CLAUDE_PLUGIN_DATA: path.join(f.cwd, "data"), GROK_COMPANION_SESSION_ID: hostSession ?? "",
    CODEX_THREAD_ID: "", CANCEL_SEED_JOBS: JSON.stringify(jobs) };
  prepareFixtureState(f.cwd, env);
  const source = `import { saveState, writeJobFile } from ${JSON.stringify(new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href)};
    const jobs = JSON.parse(process.env.CANCEL_SEED_JOBS);
    saveState(process.cwd(), { version: 1, config: {}, jobs });
    for (const job of jobs) writeJobFile(process.cwd(), job.id, job);`;
  const seeded = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: f.cwd, env, windowsHide: true, encoding: "utf8", timeout: 15000
  });
  assert.equal(seeded.status, 0, seeded.stderr);
  const cli = (args) => spawnSync(process.execPath, [companion, ...args], {
    cwd: f.cwd, env, windowsHide: true, encoding: "utf8", timeout: 20000
  });
  return { ...f, cli };
}

for (const [label, established] of [
  ["legacy completed", { status: "completed" }],
  ["legacy cancelled", { status: "cancelled" }],
  ["confirmed failed", { status: "failed", taskSessionResumable: true }]
]) {
  test(`resume preserves ${label} task history while excluding a newer unconfirmed session`, async (t) => {
    const f = await seededResumeFixture(t, [
      { ...established, grokSessionId: "established-session" },
      { status: "cancelled", grokSessionId: "empty-session", taskSessionResumable: false }
    ]);
    const result = f.cli(["task", "--resume-last", "--json", "continue established conversation"]);
    assert.equal(result.status, 0, result.stderr);
    const task = JSON.parse(result.stdout);
    assert.equal(task.grokSessionId, "established-session");
    assert.equal(JSON.parse(f.cli(["status", "--json", task.jobId]).stdout).job.taskSessionResumable, true);
  });
}

test("legacy task state cannot resume without terminal history in the current broker", async (t) => {
  const f = await seededResumeFixture(t, [
    { status: "completed", grokSessionId: "previous-broker-session" }
  ], { seedBrokerHistory: false });
  const result = f.cli(["task", "--resume-last", "--json", "continue previous conversation"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no safe terminal execution history/);
  assert.deepEqual(f.logs().filter((row) => row.prompt || row.loadedSession), [], "unsafe resume must not reach the agent");
});

test("an unconfirmed job does not exclude an established job with the same Grok session", async (t) => {
  const f = await seededResumeFixture(t, [
    { status: "completed", grokSessionId: "shared-valid-session" },
    { status: "cancelled", grokSessionId: "shared-valid-session", taskSessionResumable: false }
  ], { hostSession: null });
  const result = f.cli(["task", "--resume-last", "--json", "continue established conversation"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).grokSessionId, "shared-valid-session");
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
