import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { migrateStateLock, loadState, readJobFile, resolveJobFile, resolveStateDir, updateState } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { makeTempDir } from "./helpers.mjs";

// A one-sided cancellation must not be overwritten by the worker's final
// result; the other record is preserved rather than merged into the first.
test("Linux worker preserves a cancellation present only in the index", { skip: process.platform !== "linux", timeout: 45000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir("grok-partial-cancel-state-");
  delete process.env.PLUGIN_DATA;
  const workspace = makeTempDir("grok-partial-cancel-workspace-");
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
  const job = { id: "partial-cancel", workspaceRoot: workspace, title: "Review", jobClass: "review" };
  child = fork(new URL("./fixtures/tracked-job-claim-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  closed = new Promise(resolve => child.once("close", resolve));
  child.send(job);
  const [started] = await once(child, "message");
  assert.equal(started.type, "started");
  updateState(workspace, state => {
    Object.assign(state.jobs.find(entry => entry.id === job.id), { status: "cancelled", terminationPending: true });
  });
  const detail = resolveJobFile(workspace, job.id);
  const before = fs.readFileSync(detail, "utf8");
  child.send("release");
  const [result] = await once(child, "message");
  assert.equal(result.type, "rejected");
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "cancelled");
  assert.equal(fs.readFileSync(detail, "utf8"), before);
  assert.equal(readJobFile(detail).status, "running");
});
