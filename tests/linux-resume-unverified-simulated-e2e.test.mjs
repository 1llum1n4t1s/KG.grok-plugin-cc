import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// Mac では Linux procfs・mount・flock を模擬。実 broker の再開拒否や
// Linux kernel の挙動はこのテストでは証明しない。A は停止証拠を含む
// broker 履歴形状の合成 fixture であり、実 broker 履歴ではない。
// A の有効な過去履歴に対し、同 session の B が不一致・欠落した場合に
// B を候補から黙って除外し、A を再開可能と表示することを防ぐ。
for (const damage of ["status", "session", "resumable", "missing", "pending", "index-old-epoch",
  "old-running", "old-queued", "old-pending", "old-missing", "old-inconsistent", "old-terminal", "old-other-session", "old-other-host-session", "old-missing-epoch-other-host"]) {
  test(`simulated Linux resume candidate refuses ${damage} task records`, { skip: process.platform !== "darwin", timeout: 45000 }, async t => {
    const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
    const root = fs.realpathSync(makeTempDir("grok-linux-resume-unverified-"));
    const data = path.join(root, "data"), workspace = path.join(root, "workspace"), registry = path.join(root, "processes");
    const identity = file => { const s = fs.lstatSync(file, { bigint: true }); return { dev: s.dev, ino: s.ino, mode: s.mode }; };
    const rootIdentity = identity(root);
    let migrated = false, completed = false, stateDir, env, args, command, protocolIdentity, epoch;
    const agentPid = path.join(root, "agent.pid"), spawnMarker = path.join(root, "agent-spawned"), wrapper = path.join(root, "fake-grok");
    t.after(async () => {
      try {
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
          assert.deepEqual(identity(root), rootIdentity);
          const marker = path.join(stateDir, "state.lock", "protocol.json");
          assert.deepEqual(identity(marker), protocolIdentity);
          assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).epoch, epoch);
          const result = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...args, "--json"], { env, encoding: "utf8", timeout: 15000 });
          assert.equal(result.error, undefined, result.error?.message);
          assert.equal(result.signal, null);
          assert.equal(result.status, 0, result.stderr);
          const confirmation = JSON.parse(result.stdout);
          assert.equal(confirmation.stopped, true);
          assert.equal(confirmation.stateDir, stateDir);
          assert.equal(confirmation.epoch, epoch);
          if (completed) { assert.deepEqual(identity(root), rootIdentity); removeTempFixture(root, { recursive: true }); }
          else t.diagnostic(`Retained fixture after test failure: ${root}`);
        } else t.diagnostic(`Retained fixture; migration or agent exit unconfirmed: ${root}`);
      } catch (error) {
        t.diagnostic(`Retained fixture; cleanup or owned process stop failed: ${root}`);
        throw error;
      } finally {
        for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
    });
    fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(registry, { mode: 0o700 });
    process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
    stateDir = resolveStateDir(workspace);
    command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
    const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
    const agent = fileURLToPath(new URL("./fixtures/linux-cli-simulated-agent.mjs", import.meta.url));
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { flag: "wx", mode: 0o700 });
    env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim(),
      GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_LINUX_SIM_AGENT_PID: agentPid, GROK_LINUX_SIM_SPAWN_MARKER: spawnMarker,
      GROK_LINUX_SIM_COMPLETE: "1", GROK_BIN: wrapper, XAI_API_KEY: "test-only", GROK_COMPANION_DISABLE_BROKER: "1",
      GROK_COMPANION_SESSION_ID: "resume-fixture" };
    args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
    const run = argv => spawnSync(process.execPath, [command, ...argv], { env, encoding: "utf8", timeout: 20000 });
    const migration = run(["state-lock", "migrate", ...args]); assert.equal(migration.error, undefined, migration.error?.message); assert.equal(migration.signal, null); assert.equal(migration.status, 0, migration.stderr); migrated = true;
    const stateFile = path.join(stateDir, "state.json"), state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.deepEqual(state.jobs, []);
    const protocolFile = path.join(stateDir, "state.lock", "protocol.json");
    protocolIdentity = identity(protocolFile);
    epoch = JSON.parse(fs.readFileSync(protocolFile, "utf8")).epoch;
    const firstId = "synthetic-broker-history", brokerGeneration = randomUUID();
    const first = { id: firstId, status: "completed", jobClass: "task", sessionId: "resume-fixture", epoch,
      createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z",
      grokSessionId: "synthetic-broker-session", grokTransport: "broker", grokBrokerGeneration: brokerGeneration,
      grokPromptState: "terminal", taskSessionResumable: true, terminationPending: false, pid: null,
      workerLease: null, workerStopConfirmed: true, workerStopProof: "linux-lease-released",
      workerStopLeaseId: randomUUID(), workerStopProcessStartKey: null };
    state.jobs.push(first);
    fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true, mode: 0o700 });
    const firstDetailPath = path.join(stateDir, "jobs", `${firstId}.json`);
    fs.writeFileSync(firstDetailPath, JSON.stringify(first), { flag: "wx", mode: 0o600 });
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    const snapshot = file => ({ identity: identity(file), bytes: fs.readFileSync(file) });
    const baselineState = snapshot(stateFile), baselineDetail = snapshot(firstDetailPath);
    const baseline = run(["task-resume-candidate", "--cwd", workspace, "--json"]);
    assert.equal(baseline.error, undefined, baseline.error?.message);
    assert.equal(baseline.signal, null);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).candidate?.id, firstId, "A alone must be an accepted broker-shaped candidate");
    assert.deepEqual(snapshot(stateFile), baselineState);
    assert.deepEqual(snapshot(firstDetailPath), baselineDetail);
    const next = { ...first, id: "partial-task", createdAt: "2021-01-01T00:00:00.000Z", updatedAt: "2099-01-01T00:00:00.000Z",
      workerStopLeaseId: randomUUID() };
    const detail = { ...next };
    const detailPath = path.join(stateDir, "jobs", `${next.id}.json`);
    if (["status", "session", "resumable", "pending"].includes(damage)) {
      state.jobs.unshift(next);
      fs.writeFileSync(detailPath, JSON.stringify(detail), { flag: "wx", mode: 0o600 });
      fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
      const controlState = snapshot(stateFile), controlDetail = snapshot(detailPath);
      const control = run(["task-resume-candidate", "--cwd", workspace, "--json"]);
      assert.equal(control.error, undefined, control.error?.message);
      assert.equal(control.signal, null);
      assert.equal(control.status, 0, control.stderr);
      assert.equal(JSON.parse(control.stdout).candidate?.id, next.id, "valid B must be accepted before introducing damage");
      assert.deepEqual(snapshot(stateFile), controlState);
      assert.deepEqual(snapshot(detailPath), controlDetail);
      assert.deepEqual(snapshot(firstDetailPath), baselineDetail);
    }
    if (damage === "index-old-epoch") next.epoch = "22222222-2222-4222-8222-222222222222";
    if (damage.startsWith("old-")) {
      next.epoch = detail.epoch = "22222222-2222-4222-8222-222222222222";
      next.status = detail.status = "running";
      next.grokPromptState = detail.grokPromptState = "pending";
      if (damage === "old-missing-epoch-other-host") {
        delete next.epoch; delete detail.epoch;
        next.sessionId = detail.sessionId = "other-host-session";
      }
      if (damage === "old-queued") next.status = detail.status = "queued";
      if (damage === "old-pending") {
        next.status = detail.status = "failed";
        next.terminationPending = detail.terminationPending = true;
      }
      if (damage === "old-terminal" || damage === "old-inconsistent") {
        next.status = detail.status = "completed";
        next.grokPromptState = detail.grokPromptState = "terminal";
        next.grokTransport = detail.grokTransport = "broker";
        next.grokBrokerGeneration = detail.grokBrokerGeneration = brokerGeneration;
        if (damage === "old-inconsistent") detail.grokPromptState = "pending";
      }
      if (damage === "old-other-session" || damage === "old-other-host-session") {
        next.grokSessionId = detail.grokSessionId = "other-grok-session";
        if (damage === "old-other-host-session") next.sessionId = detail.sessionId = "other-host-session";
      }
    }
    if (damage === "pending") {
      next.terminationPending = true;
      Object.assign(detail, next);
    }
    if (damage === "status") detail.status = "failed";
    if (damage === "session") detail.grokSessionId = "another-session";
    if (damage === "resumable") detail.taskSessionResumable = false;
    if (!state.jobs.some(job => job.id === next.id)) state.jobs.unshift(next);
    if (!["missing", "old-missing"].includes(damage)) fs.writeFileSync(detailPath, JSON.stringify(detail), { mode: 0o600 });
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    const beforeState = fs.readFileSync(stateFile, "utf8"), beforeDetail = ["missing", "old-missing"].includes(damage) ? null : fs.readFileSync(detailPath, "utf8");
    const beforeFirstDetail = fs.readFileSync(firstDetailPath, "utf8");
    const candidate = run(["task-resume-candidate", "--cwd", workspace, "--json"]);
    assert.equal(candidate.error, undefined, candidate.error?.message);
    assert.equal(candidate.signal, null);
    if (["old-terminal", "old-other-host-session"].includes(damage)) {
      assert.equal(candidate.status, 0, candidate.stderr);
      assert.equal(JSON.parse(candidate.stdout).candidate?.id, firstId);
    } else {
      assert.equal(candidate.status, 1, `unexpected candidate exit: ${candidate.stderr}\n${candidate.stdout}`);
      const expected = {
        status: /^Task partial-task has unverified or inconsistent records; resume is unavailable\.\s*$/,
        session: /^Task partial-task has unverified or inconsistent records; resume is unavailable\.\s*$/,
        resumable: /^Task partial-task has unverified or inconsistent records; resume is unavailable\.\s*$/,
        missing: /^Task partial-task has unverified or inconsistent records; resume is unavailable\.\s*$/,
        pending: /^A task is still running or termination is pending; resume is unavailable\.\s*$/,
        "index-old-epoch": /^Task partial-task has unverified or inconsistent epoch records; resume is unavailable\.\s*$/,
        "old-running": /^Job partial-task has unverified or pending turn evidence; resume is unavailable\.\s*$/,
        "old-queued": /^Job partial-task has unverified or pending turn evidence; resume is unavailable\.\s*$/,
        "old-pending": /^Job partial-task has unverified or pending turn evidence; resume is unavailable\.\s*$/,
        "old-missing": /^Task partial-task has unverified or inconsistent epoch records; resume is unavailable\.\s*$/,
        "old-inconsistent": /^Job partial-task has inconsistent or unverified turn evidence; resume is unavailable\.\s*$/,
        // 同 host の別 session の稼働 worker は direct fallback を起こし得る。
        "old-other-session": /^Job partial-task has unverified or pending turn evidence; resume is unavailable\.\s*$/,
        "old-missing-epoch-other-host": /^Job partial-task has unverified epoch; resume is unavailable\.\s*$/
      };
      assert.match(candidate.stderr, expected[damage]);
    }
    assert.equal(fs.readFileSync(stateFile, "utf8"), beforeState);
    assert.equal(fs.readFileSync(firstDetailPath, "utf8"), beforeFirstDetail);
    if (beforeDetail !== null) assert.equal(fs.readFileSync(detailPath, "utf8"), beforeDetail);
    else assert.equal(fs.existsSync(detailPath), false);
    assert.equal(fs.existsSync(spawnMarker), false, "candidate inspection must not start an agent");
    completed = true;
  });
}
