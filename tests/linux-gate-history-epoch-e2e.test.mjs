import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";

// 先行失敗条件: 現 epoch の更新時に旧 gate の読込・保存上限で原本が失われる。
test("new prompt preserves more than the gate history limit from prior epochs", { skip: process.platform !== "linux" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-gate-history-"));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(workspace); fs.mkdirSync(data);
  const previous = { claude: process.env.CLAUDE_PLUGIN_DATA, plugin: process.env.PLUGIN_DATA };
  process.env.CLAUDE_PLUGIN_DATA = data; process.env.PLUGIN_DATA = data;
  const stateDir = resolveStateDir(workspace);
  let migrated = false;
  t.after(() => {
    try {
      if (!migrated) { t.diagnostic(`Retained unconfirmed sentinel fixture: ${root}`); return; }
      assert.equal(shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir }).stopped, true);
    } finally {
      if (previous.claude === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous.claude;
      if (previous.plugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previous.plugin;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { epoch } = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  migrated = true;
  const oldEpoch = randomUUID();
  const old = Array.from({ length: 55 }, (_, i) => ({ sessionId: `old-${i}`, epoch: oldEpoch,
    pendingReason: `pending-${i}`, updatedAt: `2000-01-${String(i % 28 + 1).padStart(2, "0")}T00:00:00.000Z` }));
  old.push({ sessionId: "missing-epoch", pendingReason: "unverified", updatedAt: "1999-01-01T00:00:00.000Z" });
  const stateFile = path.join(stateDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [], reviewGateSessions: old }));
  const hook = path.resolve("plugins/grok/scripts/stop-review-gate-hook.mjs");
  const result = spawnSync(process.execPath, [hook], { cwd: workspace,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data }, encoding: "utf8", timeout: 15000,
    input: JSON.stringify({ cwd: workspace, session_id: "current", hook_event_name: "UserPromptSubmit", turn_id: "turn" }) });
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8")).reviewGateSessions;
  t.diagnostic(`old retained=${saved.filter(entry => entry.epoch === oldEpoch || !entry.epoch).length}/${old.length}`);
  for (const entry of old) assert.deepEqual(saved.find(current => current.sessionId === entry.sessionId), entry);
  assert.ok(saved.some(entry => entry.sessionId === "current" && entry.epoch === epoch));
});
