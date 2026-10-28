import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fork } from "node:child_process";
import { once } from "node:events";
import { loadState, migrateStateLock, resolveJobFile, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { makeTempDir } from "./helpers.mjs";

for (const variant of ["epoch", "pid", "start"]) {
  test(`Linux direct registration refuses a stale claim ${variant}`, { skip: process.platform !== "linux", timeout: 45000 }, async t => {
    const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
    process.env.CLAUDE_PLUGIN_DATA = makeTempDir("grok-direct-owner-state-");
    delete process.env.PLUGIN_DATA;
    const workspace = makeTempDir("grok-direct-owner-workspace-");
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
    const job = { id: `direct-owner-${variant}`, workspaceRoot: workspace, title: "Review", jobClass: "review" };
    child = fork(new URL("./fixtures/linux-direct-owner-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    closed = new Promise(resolve => child.once("close", resolve));
    child.send({ job, variant });
    const [started] = await once(child, "message");
    assert.equal(started.type, "started");
    const detail = resolveJobFile(workspace, job.id);
    const before = fs.readFileSync(detail, "utf8");
    const indexedBefore = JSON.stringify(loadState(workspace).jobs.find(entry => entry.id === job.id));
    child.send("register");
    const [result] = await once(child, "message");
    assert.equal(result.type, "rejected");
    assert.equal(fs.readFileSync(detail, "utf8"), before);
    assert.equal(JSON.stringify(loadState(workspace).jobs.find(entry => entry.id === job.id)), indexedBefore);
  });
}
