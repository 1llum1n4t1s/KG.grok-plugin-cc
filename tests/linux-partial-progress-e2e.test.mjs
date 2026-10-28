import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { loadState, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { makeTempDir } from "./helpers.mjs";

test("a repeated Linux progress event repairs a partially saved update before logging", { skip: process.platform !== "linux", timeout: 45000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir("grok-partial-progress-state-");
  delete process.env.PLUGIN_DATA;
  const workspace = makeTempDir("grok-partial-progress-workspace-");
  const stateDir = resolveStateDir(workspace);
  let migrated = false, child, closed;
  t.after(async () => {
    try {
      if (child) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
      if (migrated) shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  migrated = true;
  const job = { id: "partial-progress", workspaceRoot: workspace, title: "Review", jobClass: "review" };
  child = fork(new URL("./fixtures/linux-partial-progress-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  closed = new Promise(resolve => child.once("close", resolve));
  child.send(job);
  const [started] = await once(child, "message");
  assert.equal(started.type, "started");
  child.send("first");
  const [failed] = await once(child, "message");
  assert.deepEqual(failed, { type: "first-failed", code: "EIO" });
  const detail = resolveJobFile(workspace, job.id);
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).phase, "starting");
  assert.equal(readJobFile(detail).phase, "running");
  assert.equal(fs.readFileSync(started.logFile, "utf8"), "");
  child.send("retry");
  const [retried] = await once(child, "message");
  assert.equal(retried.type, "retried");
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).phase, "running");
  assert.equal(readJobFile(detail).phase, "running");
  assert.match(fs.readFileSync(started.logFile, "utf8"), /progress retry/);
});
