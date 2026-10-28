import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";

// 失敗条件: hook冒頭/後半のGit再照会が共通deadlineを継承しない、async境界で
// scopeが失われる、期限切れ時に未確認jobやbroker記録を削除する、coldな検証3回と
// ACKの正常経路が1250ms枠に収まらない、前処理後に2200msの全体予算を更新する。
const hook = fs.readFileSync(new URL("../plugins/grok/scripts/session-lifecycle-hook.mjs", import.meta.url), "utf8");
const source = hook.slice(hook.indexOf("async function handleSessionEnd"), hook.indexOf("async function main"));
for (const outcome of ["complete", "non-git", "pending", "initial-timeout", "cleanup-timeout"]) {
  test(`SessionEnd scopes every workspace lookup and retains uncertain records: ${outcome}`, async () => {
    let scoped = false;
    let scopes = 0;
    let status = "running";
    let idleCleanup = 0;
    const check = () => assert.equal(scoped, true, "Every hook workspace lookup must inherit the same deadline");
    const context = vm.createContext({ performance: { now: () => 100 }, process: { env: {}, cwd: () => "workspace" },
      withWorkspaceDeadline: async (deadline, callback) => {
        assert.equal(deadline, 2300); scopes += 1; scoped = true;
        try { return await callback(); } finally { scoped = false; }
      },
      loadBrokerSession: () => { check(); if (outcome === "initial-timeout") throw Error("Git deadline exceeded"); return { generation: "broker" }; },
      resolveSessionIdWithFallback: () => "session",
      cleanupSessionJobs: async (_cwd, sessionId, options) => {
        check(); assert.equal(sessionId, "session"); assert.equal(options.processLookupDeadline, 2300);
        await Promise.resolve(); check();
        status = ["pending", "cleanup-timeout"].includes(outcome) ? "pending" : "complete";
        if (outcome === "cleanup-timeout") throw Error("Git deadline exceeded");
      },
      resolveWorkspaceRoot: cwd => { check(); return cwd; },
      listJobs: () => { check(); return status === "complete" ? [] : [{ status }]; },
      isActiveJob: job => ["running", "pending"].includes(job.status),
      cleanupIdleBrokerSession: async (_cwd, broker, options) => {
        check(); assert.equal(broker.generation, "broker"); assert.ok(options.timeoutMs <= 1800); idleCleanup += 1;
      }
    });
    vm.runInContext(source, context);
    const operation = context.handleSessionEnd({ cwd: outcome === "non-git" ? "plain-folder" : "workspace", session_id: "session" });
    if (outcome.endsWith("timeout")) await assert.rejects(operation, /Git deadline exceeded/);
    else await operation;
    assert.equal(scopes, 1);
    assert.equal(scoped, false);
    assert.equal(idleCleanup, ["complete", "non-git"].includes(outcome) ? 1 : 0);
    assert.equal(status, outcome === "initial-timeout" ? "running" : ["pending", "cleanup-timeout"].includes(outcome) ? "pending" : "complete");
  });
}

test("actual workspace deadline scope preserves non-Git fallback through SessionEnd shutdown dispatch", async () => {
  const workspace = fs.readFileSync(new URL("../plugins/grok/scripts/lib/workspace.mjs", import.meta.url), "utf8");
  let now = 100;
  let requests = 0;
  const lookups = [];
  const context = vm.createContext({ AsyncLocalStorage, performance: { now: () => now }, process: { env: {} },
    ensureGitRepository: (cwd, options) => {
      lookups.push(options.deadline);
      assert.equal(options.deadline, 2300);
      now += 50;
      throw Object.assign(Error("This command must run inside a Git repository."), { code: "GROK_NOT_GIT_REPOSITORY" });
    },
    loadBrokerSession: cwd => { assert.equal(context.resolveWorkspaceRoot(cwd), cwd); return { generation: "owned-broker" }; },
    resolveSessionIdWithFallback: () => "session",
    cleanupSessionJobs: async cwd => { assert.equal(context.resolveWorkspaceRoot(cwd), cwd); await Promise.resolve(); },
    listJobs: cwd => { assert.equal(context.resolveWorkspaceRoot(cwd), cwd); return []; }, isActiveJob: () => false,
    cleanupIdleBrokerSession: async (cwd, broker, options) => {
      assert.equal(context.resolveWorkspaceRoot(cwd), cwd);
      assert.equal(broker.generation, "owned-broker"); assert.ok(options.timeoutMs > 0); requests += 1;
    }
  });
  vm.runInContext(workspace.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), context);
  vm.runInContext(source, context);
  await context.handleSessionEnd({ cwd: "/not-a-repository", session_id: "session" });
  assert.equal(requests, 1);
  assert.equal(lookups.length, 5);

  const broker = fs.readFileSync(new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url), "utf8");
  const cleanupStart = broker.indexOf("export async function cleanupIdleBrokerSession(");
  const cleanup = broker.slice(cleanupStart, broker.indexOf("function brokerHasExited(", cleanupStart)).replace(/^export /gm, "");
  for (const scenario of [
    { prior: 0, budget: 1800, jobs: [] },
    { prior: 800, budget: 1400, jobs: [] },
    { prior: 2100, budget: 100, jobs: [] },
    { prior: 0, budget: 1800, jobs: [{ id: "finished", status: "completed" }] },
    { prior: 2200, budget: 0, jobs: [] }
  ]) {
    let clock = 100;
    let jobs = scenario.jobs.map(job => ({ ...job }));
    let cleanupResult;
    let notifications = 0;
    let updates = 0;
    let deletions = 0;
    let inspections = 0;
    let recordsRetained = true;
    const session = { generation: "cold-broker", ownerPlatform: "win32", pid: 123 };
    const cold = vm.createContext({
      performance: { now: () => clock }, process: { platform: "win32", env: {} },
      BROKER_IDLE_SHUTDOWN_ACK_TIMEOUT_MS: 750,
      withWorkspaceDeadline: async (deadline, callback) => {
        assert.equal(deadline, 2300);
        return callback();
      },
      loadBrokerSession: () => session,
      resolveSessionIdWithFallback: () => "session",
      cleanupSessionJobs: async (_cwd, _sessionId, options) => {
        assert.equal(options.processLookupDeadline, 2300);
        clock += scenario.prior;
        jobs = jobs.filter(job => job.status !== "completed");
      },
      resolveWorkspaceRoot: cwd => cwd, listJobs: () => jobs, isActiveJob: () => false,
      brokerCleanupPaths: () => ({}), sameBrokerSession: (left, right) => left.generation === right.generation,
      brokerRemaining: deadline => Math.max(0, deadline - clock),
      withBrokerRecoverySnapshot: (cwd, epoch, deadline, callback) => {
        assert.equal(cwd, "workspace");
        assert.equal(epoch, session.epoch);
        assert.equal(deadline, Math.min(1900 + scenario.prior, 2300));
        assert.ok(clock < deadline);
        return callback();
      },
      withBrokerStateScope: (_cwd, callback, deadline) => {
        assert.ok(clock < deadline, "An expired validation scope must not start");
        if (clock + 400 >= deadline) {
          clock = deadline;
          throw Error("Cold handle inspection deadline exceeded");
        }
        clock += 400;
        inspections += 1;
        return callback();
      },
      requestIdleBrokerShutdown: async (_session, timeoutMs, options) => {
        assert.ok(timeoutMs > 0 && timeoutMs <= 750);
        if (!options.beforeSend()) return false;
        assert.ok(clock < 2300);
        notifications += 1;
        clock += 100;
        return true;
      },
      readBrokerAdmission: () => ({ pending: false }), requireBrokerStateMigration() {},
      recordBrokerShutdown: () => { assert.ok(clock < 2300); updates += 1; return "saved"; },
      brokerHasExited: () => true,
      cleanupBrokerArtifacts: (_cwd, _session, _anchor, deadline) => {
        assert.ok(clock < deadline && clock < 2300);
        deletions += 1;
        recordsRetained = false;
        return true;
      }
    });
    vm.runInContext(cleanup, cold);
    const actualCleanup = cold.cleanupIdleBrokerSession;
    cold.cleanupIdleBrokerSession = async (cwd, owned, options) => {
      assert.equal(options.timeoutMs, scenario.budget, `cleanup budget after ${scenario.prior}ms`);
      cleanupResult = await actualCleanup(cwd, owned, options);
    };
    vm.runInContext(source, cold);
    const ended = cold.handleSessionEnd({ cwd: "workspace", session_id: "session" });
    if (scenario.prior === 2100) await assert.rejects(ended, /deadline/i);
    else await ended;
    assert.ok(clock <= 2300, "SessionEnd must retain its original 2200ms deadline");
    assert.deepEqual(jobs, []);
    if (scenario.prior < 2100) {
      assert.equal(cleanupResult, true);
      assert.equal(inspections, 3);
      assert.equal(notifications, 1);
      assert.equal(updates, 1);
      assert.equal(deletions, 1);
      assert.equal(recordsRetained, false);
    } else {
      assert.equal(notifications, 0);
      assert.equal(updates, 0);
      assert.equal(deletions, 0);
      assert.equal(recordsRetained, true);
    }
  }
});
