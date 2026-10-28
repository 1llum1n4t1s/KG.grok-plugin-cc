import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// Mac では Linux procfs・mount・flock を模擬。実 broker の再開拒否や
// Linux kernel の挙動はこのテストでは証明しない。
// A の有効な過去履歴に対し、同 session の B が不一致・欠落した場合に
// B を候補から黙って除外し、A を再開可能と表示することを防ぐ。
for (const damage of ["status", "session", "resumable", "missing", "pending", "index-old-epoch",
  "old-running", "old-queued", "old-pending", "old-missing", "old-inconsistent", "old-terminal", "old-other-session", "old-other-host-session", "old-missing-epoch-other-host"]) {
  test(`simulated Linux resume candidate refuses ${damage} task records`, { skip: process.platform !== "darwin", timeout: 45000 }, async t => {
    const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
    const root = fs.realpathSync(makeTempDir("grok-linux-resume-unverified-"));
    const data = path.join(root, "data"), workspace = path.join(root, "workspace"), registry = path.join(root, "processes");
    fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(registry, { mode: 0o700 });
    process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
    const stateDir = resolveStateDir(workspace), agentPid = path.join(root, "agent.pid"), spawnMarker = path.join(root, "agent-spawned"), wrapper = path.join(root, "fake-grok");
    const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
    const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
    const agent = fileURLToPath(new URL("./fixtures/linux-cli-simulated-agent.mjs", import.meta.url));
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { flag: "wx", mode: 0o700 });
    const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim(),
      GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_LINUX_SIM_AGENT_PID: agentPid, GROK_LINUX_SIM_SPAWN_MARKER: spawnMarker,
      GROK_LINUX_SIM_COMPLETE: "1", GROK_BIN: wrapper, XAI_API_KEY: "test-only", GROK_COMPANION_DISABLE_BROKER: "1",
      GROK_COMPANION_SESSION_ID: "resume-fixture" };
    const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
    let migrated = false;
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
          const result = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...args], { env, encoding: "utf8", timeout: 15000 });
          assert.equal(result.status, 0, result.stderr);
        } else if (migrated) t.diagnostic(`Retained sentinel; agent exit is unconfirmed: ${root}`);
      } finally {
        for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
    });
    const run = argv => spawnSync(process.execPath, [command, ...argv], { env, encoding: "utf8", timeout: 20000 });
    const migration = run(["state-lock", "migrate", ...args]); assert.equal(migration.status, 0, migration.stderr); migrated = true;
    const initial = run(["task", "--cwd", workspace, "--json", "first task"]);
    assert.equal(initial.status, 0, initial.stderr);
    const firstId = JSON.parse(initial.stdout).jobId;
    const stateFile = path.join(stateDir, "state.json"), state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const first = state.jobs.find(job => job.id === firstId);
    assert.equal(first.status, "completed"); assert.ok(first.grokSessionId);
    assert.equal(first.terminationPending, false, "A must be a settled prior task, not the reason resume is refused");
    assert.equal(first.taskSessionResumable, true, "A must actually be resumable before adding B");
    const next = { id: "partial-task", status: "running", createdAt: "2021-01-01T00:00:00.000Z", updatedAt: "2099-01-01T00:00:00.000Z",
      epoch: first.epoch, jobClass: "task", sessionId: "resume-fixture", grokSessionId: first.grokSessionId,
      taskSessionResumable: false, terminationPending: false };
    const detail = { ...next };
    if (damage === "index-old-epoch") next.epoch = "22222222-2222-4222-8222-222222222222";
    if (damage.startsWith("old-")) {
      next.epoch = detail.epoch = "22222222-2222-4222-8222-222222222222";
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
        if (damage === "old-inconsistent") detail.grokPromptState = "pending";
      }
      if (damage === "old-other-session" || damage === "old-other-host-session") {
        next.grokSessionId = detail.grokSessionId = "other-grok-session";
        if (damage === "old-other-host-session") next.sessionId = detail.sessionId = "other-host-session";
      }
    }
    if (damage === "pending") {
      Object.assign(next, { status: "failed", terminationPending: true, taskSessionResumable: true });
      Object.assign(detail, next);
    }
    if (damage === "status") detail.status = "failed";
    if (damage === "session") detail.grokSessionId = "another-session";
    if (damage === "resumable") detail.taskSessionResumable = true;
    state.jobs.unshift(next);
    const detailPath = path.join(stateDir, "jobs", `${next.id}.json`);
    if (!["missing", "old-missing"].includes(damage)) fs.writeFileSync(detailPath, JSON.stringify(detail), { flag: "wx", mode: 0o600 });
    fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    const beforeState = fs.readFileSync(stateFile, "utf8"), beforeDetail = ["missing", "old-missing"].includes(damage) ? null : fs.readFileSync(detailPath, "utf8");
    const candidate = run(["task-resume-candidate", "--cwd", workspace, "--json"]);
    if (["old-terminal", "old-other-session", "old-other-host-session"].includes(damage)) {
      assert.equal(candidate.status, 0, candidate.stderr);
      assert.equal(JSON.parse(candidate.stdout).candidate?.id, firstId);
    } else if (candidate.status === 0) assert.equal(JSON.parse(candidate.stdout).available, false, `candidate hid the unverified task: ${candidate.stdout}`);
    else assert.match(candidate.stderr, /unverified|inconsistent|unavailable|pending/i);
    assert.equal(fs.readFileSync(stateFile, "utf8"), beforeState);
    if (beforeDetail !== null) assert.equal(fs.readFileSync(detailPath, "utf8"), beforeDetail);
  });
}
