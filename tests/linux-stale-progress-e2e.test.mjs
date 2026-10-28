import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { loadState, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir, updateState, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { makeTempDir } from "./helpers.mjs";

test("a stale Linux worker cannot append progress to the replacement owner's log", { skip: process.platform !== "linux", timeout: 45000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir("grok-stale-progress-state-");
  delete process.env.PLUGIN_DATA;
  const workspace = makeTempDir("grok-stale-progress-workspace-");
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
  const job = { id: "replacement-owner", workspaceRoot: workspace, title: "Review", jobClass: "review" };
  child = fork(new URL("./fixtures/linux-owner-progress-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  closed = new Promise(resolve => child.once("close", resolve));
  child.send(job);
  const [started] = await once(child, "message");
  assert.equal(started.type, "started");
  for (let i = 0; i < 2; i += 1) {
    child.send("progress");
    const [response] = await once(child, "message");
    assert.equal(response.type, "progress-returned");
  }
  const waitForBoundaries = async expected => {
    const deadline = Date.now() + 5000;
    while (stderr.split("__progress_boundary__\n").length - 1 < expected && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(stderr.split("__progress_boundary__\n").length - 1, expected);
  };
  await waitForBoundaries(2);
  const normalStderr = stderr.replaceAll("__progress_boundary__\n", "");
  assert.equal(normalStderr.split("old worker progress").length - 1, 2);
  assert.equal(fs.readFileSync(started.logFile, "utf8").split("old worker progress").length - 1, 2);
  updateState(workspace, state => {
    const indexed = state.jobs.find(entry => entry.id === job.id);
    const stored = readJobFile(resolveJobFile(workspace, job.id));
    const replacement = { pid: process.pid, processStartKey: "new-owner" };
    Object.assign(indexed, replacement);
    writeJobFile(workspace, job.id, { ...stored, ...replacement });
  });
  const originalLog = fs.readFileSync(started.logFile, "utf8");
  const originalRecord = JSON.stringify(loadState(workspace).jobs.find(entry => entry.id === job.id));
  child.send("progress");
  const [response] = await once(child, "message");
  assert.ok(["progress-returned", "rejected"].includes(response.type));
  if (response.type === "progress-returned") {
    await waitForBoundaries(3);
    assert.equal(stderr.replaceAll("__progress_boundary__\n", ""), normalStderr);
  }
  assert.equal(fs.readFileSync(started.logFile, "utf8"), originalLog);
  assert.equal(JSON.stringify(loadState(workspace).jobs.find(entry => entry.id === job.id)), originalRecord);
});
