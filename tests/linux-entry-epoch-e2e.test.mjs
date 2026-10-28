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
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";

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
  fs.mkdirSync(jobsDir, { recursive: true });
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
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [indexed], reviewGateSessions: [] }));
    fs.writeFileSync(detail(indexed), JSON.stringify(stored));
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
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [oldBroker], reviewGateSessions: [] }));
  fs.writeFileSync(detail(oldBroker), JSON.stringify(oldBroker));
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
  const current = { ...base, id: "current-queued", epoch };
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [current], reviewGateSessions: [] }));
  fs.writeFileSync(detail(current), JSON.stringify(current));
  const currentCancel = run(command, ["cancel", current.id, "--json", "--cwd", workspace]);
  assert.equal(currentCancel.status, 0, currentCancel.stderr);
  assert.equal(JSON.parse(currentCancel.stdout).status, "cancelled");
  const currentTask = { ...base, id: "current-terminal", epoch, status: "completed", grokSessionId: "current-session", taskSessionResumable: true };
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [currentTask], reviewGateSessions: [] }));
  fs.writeFileSync(detail(currentTask), JSON.stringify(currentTask));
  const currentCandidate = run(command, ["task-resume-candidate", "--json", "--cwd", workspace]);
  assert.equal(currentCandidate.status, 0, currentCandidate.stderr);
  assert.equal(JSON.parse(currentCandidate.stdout).candidate.id, currentTask.id);
  const fake = installFakeGrok({ replies: [{ text: "first" }, { text: "resumed" }] });
  const endpoint = createBrokerEndpoint(fake.binDir);
  const brokerEnv = { ...env, GROK_BIN: fake.env.GROK_BIN, FAKE_GROK_SCENARIO: fake.env.FAKE_GROK_SCENARIO,
    FAKE_GROK_STATE: fake.env.FAKE_GROK_STATE, XAI_API_KEY: "fake-key-for-tests", GROK_COMPANION_DISABLE_BROKER: "0",
    GROK_COMPANION_ACP_ENDPOINT: endpoint, TMPDIR: fake.binDir, TMP: fake.binDir, TEMP: fake.binDir };
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [], reviewGateSessions: [] }));
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
    const firstJob = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.find(job => job.jobClass === "task");
    assert.equal(firstJob?.epoch, epoch);
    assert.equal(firstJob?.status, "completed");
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
  const oldTask = { ...base, id: "old-terminal", status: "completed", grokSessionId: "old-session", taskSessionResumable: true };
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [oldTask], reviewGateSessions: [] }));
  fs.writeFileSync(detail(oldTask), JSON.stringify(oldTask));
  const candidate = run(command, ["task-resume-candidate", "--json", "--cwd", workspace]);
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);
  const invocation = path.join(root, "grok-invoked"), fakeGrok = path.join(root, "fake-grok");
  fs.writeFileSync(fakeGrok, '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.FAKE_INVOCATION, "called\\n");\nprocess.exit(1);\n', { mode: 0o700 });
  env.GROK_BIN = fakeGrok; env.FAKE_INVOCATION = invocation;
  const resume = run(command, ["task", "--resume", "--cwd", workspace]);
  assert.notEqual(resume.status, 0);
  assert.match(resume.stderr, /No previous Grok task thread/);
  assert.equal(fs.existsSync(invocation), false, "old session fallback must not start Grok");
  delete env.GROK_BIN; delete env.FAKE_INVOCATION;
  const gate = { sessionId: "session", epoch: randomUUID(), turnKey: "old", baselineNonce: "old", pendingReason: "stale blocker", retryWithoutChanges: true };
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [], reviewGateSessions: [gate] }));
  const prompt = run(gateHook, [], JSON.stringify({ cwd: workspace, session_id: "session", hook_event_name: "UserPromptSubmit", turn_id: "new" }));
  assert.equal(prompt.status, 0, prompt.stderr);
  const gates = JSON.parse(fs.readFileSync(stateFile, "utf8")).reviewGateSessions;
  assert.deepEqual(gates.find(x => x.epoch === gate.epoch), gate);
  const nextGate = gates.find(x => x.sessionId === "session" && x.epoch === epoch);
  assert.equal(nextGate.epoch, epoch);
  assert.equal(nextGate.pendingReason, null);
  assert.equal(nextGate.retryWithoutChanges, false);
});
