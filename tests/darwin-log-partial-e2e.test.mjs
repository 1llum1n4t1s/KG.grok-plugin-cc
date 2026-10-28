import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { loadState, migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

// 故障条件: 部分追記失敗でログの既存接頭部を失う、保存済み state の rollback を誤認する。
test("partial final log write preserves the prefix and reports committed state", { skip: process.platform !== "darwin", timeout: 45000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  t.after(() => { for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  process.env.CLAUDE_PLUGIN_DATA = fs.realpathSync(makeTempDir("grok-log-partial-state-"));
  delete process.env.PLUGIN_DATA;
  const workspace = fs.realpathSync(makeTempDir("grok-log-partial-workspace-"));
  const stateDir = resolveStateDir(workspace);
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const job = { id: "partial-write", workspaceRoot: workspace, title: "Review", jobClass: "review", grokPromptState: "not-sent" };
  const logFile = path.join(stateDir, "jobs", `${job.id}.log`);
  const preload = fileURLToPath(new URL("./fixtures/darwin-log-partial-preload.mjs", import.meta.url));
  const worker = fork(new URL("./fixtures/darwin-log-worker.mjs", import.meta.url), [], {
    execArgv: ["--import", preload], env: { ...process.env, GROK_TEST_PARTIAL_LOG: logFile }, stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  const closed = new Promise(resolve => worker.once("close", resolve));
  t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); await closed; });
  worker.send({ job });
  const [ready] = await once(worker, "message");
  assert.equal(ready.type, "ready", JSON.stringify(ready));
  const prefix = fs.readFileSync(logFile);
  worker.send("finish");
  const [result] = await once(worker, "message");
  assert.equal(result.type, "rejected", JSON.stringify(result));
  assert.equal(result.stateCommitted, true, JSON.stringify(result));
  assert.equal(result.causeCode, "EIO");
  const after = fs.readFileSync(logFile);
  assert.deepEqual(after.subarray(0, prefix.length), prefix);
  assert.equal(after.length, prefix.length + 12);
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "completed");
});
