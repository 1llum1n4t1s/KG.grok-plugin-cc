import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { loadState, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { makeTempDir } from "./helpers.mjs";

for (const outcome of ["success", "failure"]) {
  test(`Linux ${outcome} record is saved even when the final log cannot be written`, { skip: process.platform !== "linux", timeout: 45000 }, async t => {
    const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
    process.env.CLAUDE_PLUGIN_DATA = makeTempDir("grok-log-failure-state-");
    delete process.env.PLUGIN_DATA;
    const workspace = makeTempDir("grok-log-failure-workspace-");
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
    const job = { id: `log-${outcome}`, workspaceRoot: workspace, title: "Review", jobClass: "review" };
    child = fork(new URL("./fixtures/linux-log-failure-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    closed = new Promise(resolve => child.once("close", resolve));
    child.send({ job, outcome });
    const [started] = await once(child, "message");
    assert.equal(started.type, "started");
    // Preserve the original log and make subsequent append fail with EISDIR.
    fs.renameSync(started.logFile, `${started.logFile}.preserved`);
    fs.mkdirSync(started.logFile);
    child.send("release");
    const [result] = await once(child, "message");
    assert.equal(result.type, "rejected");
    assert.match(result.diagnostic, /EISDIR|directory/i);
    if (outcome === "failure") assert.match(result.diagnostic, /runner exploded/);
    const expected = outcome === "success" ? "completed" : "failed";
    assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, expected);
    assert.equal(readJobFile(resolveJobFile(workspace, job.id)).status, expected);
    assert.equal(fs.statSync(`${started.logFile}.preserved`).isFile(), true);
  });
}

test("Linux preserves the runner error when its job detail becomes unreadable", { skip: process.platform !== "linux", timeout: 45000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir("grok-detail-failure-state-");
  delete process.env.PLUGIN_DATA;
  const workspace = makeTempDir("grok-detail-failure-workspace-");
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
  const job = { id: "corrupt-detail", workspaceRoot: workspace, title: "Review", jobClass: "review" };
  child = fork(new URL("./fixtures/linux-log-failure-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  closed = new Promise(resolve => child.once("close", resolve));
  child.send({ job, outcome: "failure" });
  const [started] = await once(child, "message");
  assert.equal(started.type, "started");
  const detail = resolveJobFile(workspace, job.id);
  fs.renameSync(detail, `${detail}.preserved`);
  fs.writeFileSync(detail, "not JSON\n");
  child.send("release");
  const [result] = await once(child, "message");
  assert.equal(result.type, "rejected");
  assert.match(result.diagnostic, /runner exploded/);
  assert.match(result.diagnostic, /corrupt/i);
  assert.equal(loadState(workspace).jobs.find(entry => entry.id === job.id).status, "running");
  assert.equal(fs.readFileSync(detail, "utf8"), "not JSON\n");
  assert.equal(fs.statSync(`${detail}.preserved`).isFile(), true);
});
