import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { loadState, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir, updateState, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { makeTempDir } from "./helpers.mjs";

for (const variant of ["epoch", "created", "same"]) {
  test(`cancel compares selected job generation: ${variant}`, { skip: variant === "epoch" ? process.platform !== "linux" : !["linux", "darwin"].includes(process.platform), timeout: 45000 }, async t => {
    const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
    const testRoot = fs.realpathSync(makeTempDir("grok-cancel-generation-"));
    process.env.CLAUDE_PLUGIN_DATA = testRoot;
    delete process.env.PLUGIN_DATA;
    const workspace = fs.realpathSync(makeTempDir("grok-cancel-workspace-"));
    const stateDir = resolveStateDir(workspace);
    let migrated = false, child, closed, worker, workerClosed;
    t.after(async () => {
      try {
        if (child) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await closed;
        }
        if (worker) {
          if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
          await workerClosed;
        }
        if (migrated && process.platform === "linux") shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
    const { epoch } = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
    migrated = true;
    const job = { id: "selected-job", workspaceRoot: workspace, status: "queued",
      createdAt: "2000-01-01T00:00:00.000Z", grokPromptState: "not-sent" };
    worker = fork(new URL("./fixtures/tracked-job-claim-worker.mjs", import.meta.url), [],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    workerClosed = new Promise(resolve => worker.once("close", resolve));
    worker.send(job);
    const [started] = await once(worker, "message");
    assert.equal(started.type, "started", JSON.stringify(started));
    if (variant === "epoch") {
      updateState(workspace, (state, context) => {
        const indexed = state.jobs.find(entry => entry.id === job.id);
        const oldEpoch = randomUUID();
        const stored = readJobFile(resolveJobFile(workspace, job.id));
        writeJobFile(workspace, job.id, { ...stored, epoch: oldEpoch }, context);
        indexed.epoch = oldEpoch;
      });
    }
    const stateFile = path.join(stateDir, "state.json"), detailFile = resolveJobFile(workspace, job.id), marker = path.join(testRoot, "race-injected");
    const env = { ...process.env, GROK_CANCEL_TEST_STATE: stateFile, GROK_CANCEL_TEST_DETAIL: detailFile,
      GROK_CANCEL_TEST_ROOT: testRoot, GROK_CANCEL_TEST_WORKSPACE: workspace, GROK_CANCEL_TEST_JOB: job.id, GROK_CANCEL_TEST_MARKER: marker, GROK_CANCEL_TEST_EPOCH: epoch ?? "", GROK_CANCEL_TEST_VARIANT: variant };
    child = spawn(process.execPath, ["--import", new URL("./fixtures/linux-cancel-selection-race.mjs", import.meta.url).href,
      new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url).pathname, "cancel", "--cwd", workspace, "--json", job.id],
    { env, stdio: ["ignore", "ignore", "pipe"] });
    closed = new Promise(resolve => child.once("close", resolve));
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    await closed;
    assert.ok(fs.existsSync(marker), "selection race was not injected");
    const replacement = JSON.parse(fs.readFileSync(marker, "utf8"));
    const indexed = loadState(workspace).jobs.find(entry => entry.id === job.id);
    if (variant === "same") assert.equal(indexed.status, "cancelled", stderr);
    else {
      assert.equal(indexed.status, "running", stderr);
      assert.equal(indexed.createdAt, replacement.createdAt);
      assert.equal(indexed.epoch, replacement.epoch);
      assert.equal(JSON.parse(fs.readFileSync(detailFile, "utf8")).status, "running");
    }
  });
}
