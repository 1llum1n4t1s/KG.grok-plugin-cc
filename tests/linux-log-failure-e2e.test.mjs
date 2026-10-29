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
    child.send({ job, outcome, failAppend: true });
    const [started] = await once(child, "message");
    assert.equal(started.type, "started");
    const originalLog = fs.readFileSync(started.logFile, "utf8");
    assert.equal(fs.statSync(started.logFile).isFile(), true);
    child.send("release");
    const [result] = await once(child, "message");
    assert.equal(result.type, "rejected");
    assert.match(result.diagnostic, /EIO/);
    assert.equal(result.injectedAppends.length, 1);
    assert.match(result.injectedAppends[0], outcome === "success" ? /Final output/ : /Failure diagnostic/);
    if (outcome === "failure") assert.match(result.diagnostic, /runner exploded/);
    const expected = outcome === "success" ? "completed" : "failed";
    const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    assert.equal(indexed.status, expected);
    assert.equal(stored.status, expected);
    if (outcome === "failure") {
      assert.match(indexed.errorMessage, /runner exploded/);
      assert.match(stored.errorMessage, /runner exploded/);
    } else assert.equal(stored.rendered, "result");
    assert.equal(fs.statSync(started.logFile).isFile(), true);
    assert.equal(fs.readFileSync(started.logFile, "utf8"), originalLog);
  });
}

test("Linux refuses a non-regular log while preserving the running record", { skip: process.platform !== "linux", timeout: 45000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir("grok-log-inventory-state-");
  delete process.env.PLUGIN_DATA;
  const workspace = makeTempDir("grok-log-inventory-workspace-");
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
  const job = { id: "nonregular-log", workspaceRoot: workspace, title: "Review", jobClass: "review" };
  child = fork(new URL("./fixtures/linux-log-failure-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  closed = new Promise(resolve => child.once("close", resolve));
  child.send({ job, outcome: "success" });
  const [started] = await once(child, "message");
  assert.equal(started.type, "started");
  const detail = resolveJobFile(workspace, job.id);
  const beforeState = JSON.stringify(loadState(workspace));
  const beforeDetail = fs.readFileSync(detail, "utf8");
  const beforeLog = fs.readFileSync(started.logFile, "utf8");
  fs.renameSync(started.logFile, `${started.logFile}.preserved`);
  fs.mkdirSync(started.logFile);
  child.send("release");
  const [result] = await once(child, "message");
  assert.equal(result.type, "rejected");
  assert.match(result.diagnostic, /inventory.*unverified/i);
  assert.equal(JSON.stringify(loadState(workspace)), beforeState);
  assert.equal(fs.readFileSync(detail, "utf8"), beforeDetail);
  assert.equal(fs.statSync(started.logFile).isDirectory(), true);
  assert.equal(fs.readFileSync(`${started.logFile}.preserved`, "utf8"), beforeLog);
});

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
