import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// Isolated post-migration legacy records: no worker lease means neither a PID
// lookup nor a PID/tick match proves that the old worker or turn has stopped.
const mac = { skip: process.platform !== "darwin", timeout: 45000 };
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const hook = fileURLToPath(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url));
for (const operation of ["cancel", "SessionEnd", "status"]) for (const status of operation === "status" ? ["running"] : ["queued", "running", "pending"]) {
  test(`Darwin ${operation} preserves legacy unleased ${status} job evidence`, mac, t => {
    const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
    const root = fs.realpathSync(makeTempDir("grok-darwin-old-unleased-")), data = path.join(root, "data"), workspace = path.join(root, "workspace");
    fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
    process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
    t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } t.diagnostic(`Legacy record fixture retained: ${root}`); });
    const stateDir = resolveStateDir(workspace);
    migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
    const jobs = path.join(stateDir, "jobs"); fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
    const job = { id: "old-unleased", jobClass: "task", sessionId: "legacy-session", createdAt: "2020-01-01T00:00:00.000Z",
      status: status === "pending" ? "failed" : status, terminationPending: status === "pending", pid: operation === "status" ? 2147483647 : null,
      ...(operation === "status" ? { processStartKey: "darwin-lstart-utc-v1:Wed Jan  1 00:00:00 2020" } : {}),
      grokPromptState: status === "queued" ? "not-sent" : "pending", grokSessionId: status === "queued" ? null : "old-turn", logFile: null };
    const detail = path.join(jobs, `${job.id}.json`), index = path.join(stateDir, "state.json");
    fs.writeFileSync(detail, JSON.stringify(job), { flag: "wx", mode: 0o600 });
    fs.writeFileSync(index, JSON.stringify({ version: 1, config: {}, jobs: [job], reviewGateSessions: [] }), { mode: 0o600 });
    const detailBefore = fs.readFileSync(detail), env = { ...process.env, GROK_COMPANION_SESSION_ID: "legacy-session" };
    const result = operation === "cancel"
      ? spawnSync(process.execPath, [cli, "cancel", "--cwd", workspace, "--json", job.id], { env, encoding: "utf8", timeout: 15000 })
      : operation === "status"
        ? spawnSync(process.execPath, [cli, "status", "--cwd", workspace, "--json"], { env, encoding: "utf8", timeout: 15000 })
        : spawnSync(process.execPath, [hook, "SessionEnd"], { env, input: JSON.stringify({ cwd: workspace, session_id: "legacy-session" }), encoding: "utf8", timeout: 15000 });
    if (operation === "cancel") {
      assert.notEqual(result.status, 0, "unleased legacy job must remain unconfirmed");
      assert.match(result.stderr, /lease|unverified|pending|offline/i);
    } else assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(fs.readFileSync(index, "utf8"));
    assert.deepEqual(saved.jobs.find(value => value.id === job.id), job, "legacy index evidence changed");
    assert.deepEqual(fs.readFileSync(detail), detailBefore, "legacy detail evidence changed");
  });
}
