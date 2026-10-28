import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { inspectTrackedJobProcess } from "../plugins/grok/scripts/lib/process.mjs";
import { isActiveJob } from "../plugins/grok/scripts/lib/job-status.mjs";

// 失敗条件: index/fileの片側queuedを未起動証拠へ昇格する、取消保存後の両側世代
// 交換を旧jobの確定へ使う。PID/startKeyが空でもcreatedAt/startedAtを省略しない。
const companion = fs.readFileSync(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url), "utf8");
const cancelSource = companion.slice(companion.indexOf("async function handleCancel"), companion.indexOf("async function main"));
const hook = fs.readFileSync(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url), "utf8");
const hookSource = hook.slice(hook.indexOf("async function cleanupOwnedSessionJobs"), hook.indexOf("function handleSessionStart"));
for (const platform of ["win32", "linux", "darwin"]) {
for (const race of ["consistent", "legacy", "index-running", "file-running", "file-missing", "read-createdAt", "read-startedAt", "read-broker", "commit-createdAt", "commit-startedAt", "commit-broker"]) {
  test(`queued cancel never completes from mixed or replaced generations: ${platform}/${race}`, async () => {
    const indexed = { id: "job", epoch: "current-epoch", status: race === "index-running" ? "running" : "queued", pid: null,
      createdAt: race === "legacy" ? undefined : "original", grokPromptState: "not-sent", grokTransport: "broker", grokBrokerGeneration: "generation" };
    let stored = race === "file-missing" ? null : { ...indexed, status: race === "file-running" ? "running" : "queued" };
    let output = 0;
    let mutations = 0;
    const replace = () => { for (const current of [indexed, stored]) {
      if (race.endsWith("createdAt")) current.createdAt = "replacement";
      if (race.endsWith("startedAt")) current.startedAt = "replacement";
      if (race.endsWith("broker")) current.grokBrokerGeneration = "replacement";
    } };
    const context = vm.createContext({ process: { platform, env: {}, stderr: { write() {} } },
      parseCommandInput: () => ({ options: {}, positionals: [] }), resolveCommandCwd: () => "virtual",
      resolveCancelableJob: () => ({ workspaceRoot: "virtual", job: indexed }), isActiveJob,
      updateState: (_root, callback) => { mutations += 1; if (mutations === 2 && race.startsWith("commit-")) replace(); callback({ jobs: [indexed] }, { epoch: "current-epoch" }); },
      withStateSnapshot: (_root, callback) => { if (race.startsWith("read-")) replace(); return callback({ jobs: [indexed] }, { epoch: "current-epoch" }); },
      readStoredJob: () => stored, writeJobFile: (_root, _id, value) => { stored = value; }, nowIso: () => "now", appendLogLine() {},
      setTimeout: () => ({ unref() {} }), createProcessLookupDiagnostics: () => ({}),
      inspectTrackedJobProcess: (pid, key) => inspectTrackedJobProcess(pid, key, { platform }),
      stopTrackedJobProcess: () => assert.fail("An unowned PID must never be stopped"),
      outputCommandResult: () => { output += 1; }, renderCancelReport: () => "report"
    });
    vm.runInContext(cancelSource, context);
    const before = JSON.stringify([indexed, stored]);
    const operation = context.handleCancel([]);
    if (race === "legacy") {
      await assert.rejects(operation, /cancellation request was not recorded/i);
      assert.equal(JSON.stringify([indexed, stored]), before);
      assert.equal(output, 0);
      return;
    }
    if (race === "consistent") await operation;
    else await assert.rejects(operation, /pending|verify|generation|epoch changed before interruption/i);
    assert.equal(output, race === "consistent" ? 1 : 0);
    assert.equal(indexed.terminationPending, platform === "linux" && race === "file-missing" ? undefined : race !== "consistent");
  });
}
for (const race of ["index-running", "file-running", "file-missing", "legacy", "different-createdAt"]) {
  test(`SessionEnd keeps mixed queued originals pending: ${platform}/${race}`, async () => {
    const indexed = { id: "job", epoch: "current-epoch", sessionId: "session", status: race === "index-running" ? "running" : "queued", pid: null,
      createdAt: race === "legacy" ? undefined : "original", grokPromptState: "not-sent" };
    let stored = race === "file-missing" ? null : { ...indexed, status: race === "file-running" ? "running" : "queued" };
    if (race === "different-createdAt") stored.createdAt = "replacement";
    const state = { jobs: [indexed], reviewGateSessions: [] };
    const context = vm.createContext({ process: { platform, stderr: { write() {} } }, performance: { now: () => 0 }, isActiveJob,
      fs: { existsSync: path => path === "state" || stored !== null }, resolveWorkspaceRoot: () => "virtual", resolveStateFile: () => "state", resolveJobFile: () => "job",
      readJobFile: () => stored, writeJobFile: (_root, _id, value) => { stored = value; }, updateState: (_root, callback) => callback(state, { epoch: "current-epoch" }),
      nowIso: () => "now", appendLogLine() {}, createProcessLookupDiagnostics: () => ({}),
      inspectTrackedJobProcess: (pid, key) => inspectTrackedJobProcess(pid, key, { platform }) });
    vm.runInContext(hookSource, context);
    await context.cleanupSessionJobs("virtual", "session");
    assert.equal(state.jobs.length, 1);
    assert.equal(indexed.terminationPending, platform === "linux" && race === "file-missing" ? undefined : true);
    if (race === "file-missing") {
      assert.equal(stored, null);
      assert.equal(indexed.status, platform === "linux" ? "queued" : "cancelled");
      assert.equal(indexed.phase, platform === "linux" ? undefined : "termination-pending");
      assert.equal(indexed.cancelRequestedAt, platform === "linux" ? undefined : "now");
    } else {
      assert.equal(stored.terminationPending, true);
    }
    if (race === "different-createdAt") {
      assert.equal(indexed.createdAt, "original");
      assert.equal(stored.createdAt, "replacement");
    }
  });
}
}
