#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { performance } from "node:perf_hooks";

import { inspectTrackedJobProcess, stopTrackedJobProcess } from "./lib/process.mjs";
import { isActiveJob } from "./lib/job-status.mjs";
import { interruptGrokTurn } from "./lib/grok.mjs";
import { waitForDirectAgentStop } from "./lib/direct-agent-control.mjs";
import {
  cleanupIdleBrokerSession,
  loadBrokerSession,
} from "./lib/broker-lifecycle.mjs";
import { listJobs, loadState, readJobFile, resolveJobFile, resolveStateFile, updateState, withStateSnapshot, writeJobFile } from "./lib/state.mjs";
import { appendLogLine, createProcessLookupDiagnostics, hasGenerationIdentity, nowIso, resolveSessionIdWithFallback, sameDarwinLease, sameLinuxLease, sameTurnEvidence, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { verifyPublishedDarwinLeaseRecords } from "./lib/darwin-lease-sweep.mjs";
import { verifyPublishedLinuxLeaseRecords } from "./lib/linux-lease-ledger.mjs";
import { resolveWorkspaceRoot, withWorkspaceDeadline } from "./lib/workspace.mjs";
import { readHookInput } from "./lib/fs.mjs";

// 再エクスポート。定義は tracked-jobs.mjs 側が正で、ここで別に持つと
// 片方だけ変わったときに SessionEnd のジョブ掃除が黙って効かなくなる。
export { SESSION_ID_ENV };
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

async function cleanupOwnedSessionJobs(cwd, workspaceRoot, sessionId, appendCleanupLog, options = {}) {
  const deadline = options.processLookupDeadline ?? performance.now() + 2200;
  const remaining = () => Math.max(0, deadline - performance.now());
  const sameGenerationIdentity = (current, expected) => current && expected &&
    (process.platform !== "linux" || (current.epoch === expected.epoch && current.claimToken === expected.claimToken &&
      ((!current.workerLease && !expected.workerLease) || sameLinuxLease(current.workerLease, expected.workerLease)))) &&
    (process.platform !== "darwin" || (current.epoch === expected.epoch && current.claimToken === expected.claimToken &&
      ((!current.workerLease && !expected.workerLease) || sameDarwinLease(current.workerLease, expected.workerLease)))) &&
    ["id", "sessionId", "createdAt", "startedAt", "processStartKey", "grokTransport", "grokBrokerGeneration",
      "grokDirectGeneration", "grokDirectOwnerPid", "grokDirectOwnerStartKey"].every(key => current[key] === expected[key]);
  const matchesGeneration = (current, expected) => sameGenerationIdentity(current, expected) && current.sessionId === sessionId &&
    current.status === expected.status && current.terminationPending === expected.terminationPending;
  const directStopped = (current, expected) => current.grokDirectOwnerPid === expected.grokDirectOwnerPid &&
    current.grokDirectOwnerStartKey === expected.grokDirectOwnerStartKey &&
    current.grokDirectStopGeneration === expected.grokDirectGeneration &&
    ["job-empty", "never-started", "posix-group-empty"].includes(current.grokDirectStopKind);
  const pending = [];
  const removable = new Map();
  const terminalWithoutFile = new Set();
  const confirmedWorkers = new Set();
  const workerStopped = (current, expected) => hasGenerationIdentity(expected) && matchesGeneration(current, expected) && current.status === "cancelled" && current.pid == null &&
    current.createdAt === expected.createdAt && current.startedAt === expected.startedAt && current.workerStopConfirmed === true &&
    current.workerStopProcessStartKey === (expected.processStartKey ?? null) &&
    current.workerStopProof === (expected.processStartKey == null ? "never-started" : "process-exited");
  // 全jobへの要求を先に保存し、終了待ち中はownerのACK/terminal保存を妨げない。
  const noCurrentWork = {};
  try { updateState(workspaceRoot, (state, context) => {
    let hasCurrentJob = false;
    for (const indexed of state.jobs.filter(job => job.sessionId === sessionId)) {
      const jobFile = resolveJobFile(workspaceRoot, indexed.id);
      const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
      // 旧 unleased record の PID や欠落から worker/turn 停止を推測しない。
      if (process.platform === "darwin" && (!indexed.workerLease || !stored?.workerLease)) continue;
      // lease を持つ worker には取消意図だけ保存し、独立した停止証拠まで清掃しない。
      if ((process.platform === "darwin" && (indexed.workerLease || stored?.workerLease)) || process.platform === "linux") {
        if (process.platform === "linux" && (!context.epoch || indexed.epoch !== context.epoch || !stored || stored.epoch !== context.epoch)) continue;
        hasCurrentJob = true;
        if (!stored || !context.epoch || indexed.epoch !== context.epoch || stored.epoch !== context.epoch ||
            !sameGenerationIdentity(indexed, stored) || !sameTurnEvidence(indexed, stored) || !isActiveJob(indexed)) continue;
        if (process.platform === "linux") {
          if (!indexed.workerLease || !stored.workerLease || !indexed.claimToken) continue;
          verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
        } else verifyPublishedDarwinLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
        const intent = { status: "cancelled", phase: "termination-pending", terminationPending: true,
          workerStopConfirmed: false, workerStopProof: null, workerStopProcessStartKey: null,
          cancelRequestedAt: nowIso(), errorMessage: "Cancelled when the session ended." };
        writeJobFile(workspaceRoot, indexed.id, { ...stored, ...intent });
        Object.assign(indexed, intent);
        pending.push({ ...indexed });
        continue;
      }
      hasCurrentJob = true;
      if (stored && !sameGenerationIdentity(indexed, stored)) {
        // 原本が別世代ならmergeで同一化しない。各世代を残して停止判断を保留する。
        const pendingRecord = record => ({ ...record, status: "cancelled", phase: "termination-pending", terminationPending: true,
          workerStopConfirmed: false, workerStopProof: null, workerStopProcessStartKey: null });
        writeJobFile(workspaceRoot, indexed.id, pendingRecord(stored));
        Object.assign(indexed, pendingRecord(indexed));
        continue;
      }
      if ((!stored && isActiveJob(indexed)) || (stored && !sameTurnEvidence(indexed, stored))) {
        // 不一致や欠落した証拠を他方から補わず、各原本に取消要求だけを残す。
        if (isActiveJob(indexed)) {
          const intent = { status: "cancelled", phase: "termination-pending", terminationPending: true,
            cancelRequestedAt: nowIso(), errorMessage: "Cancelled when the session ended." };
          if (stored) writeJobFile(workspaceRoot, indexed.id, { ...stored, ...intent });
          Object.assign(indexed, intent);
        }
        continue;
      }
      const current = { ...indexed, ...stored };
      if (current.sessionId !== sessionId) continue;
      const queuedUnclaimed = typeof current.createdAt === "string" && Boolean(current.createdAt.trim()) &&
        [indexed, stored].every(record => matchesGeneration(record, current) && record.status === "queued" &&
        record.terminationPending !== true && record.pid == null && record.processStartKey == null);
      if (queuedUnclaimed) {
        const cancelled = { ...current, status: "cancelled", phase: "cancelled", pid: null,
          completedAt: nowIso(), errorMessage: "Cancelled when the session ended." };
        writeJobFile(workspaceRoot, current.id, cancelled);
        Object.assign(indexed, cancelled);
      } else if (current.status === "queued" || indexed.status === "queued" || indexed.status === "running" || current.status === "running" || current.terminationPending === true) {
        const confirmedWorker = [indexed, stored].every(record => workerStopped(record, current));
        if (confirmedWorker) confirmedWorkers.add(current.id);
        const workerEvidence = confirmedWorker ? { workerStopConfirmed: true, workerStopProof: current.workerStopProof,
          workerStopProcessStartKey: current.workerStopProcessStartKey }
          : { workerStopConfirmed: false, workerStopProof: null, workerStopProcessStartKey: null };
        const cancelled = { ...current, status: "cancelled", phase: "termination-pending", terminationPending: true,
          ...workerEvidence, cancelRequestedAt: nowIso(), errorMessage: "Cancelled when the session ended." };
        writeJobFile(workspaceRoot, current.id, cancelled);
        Object.assign(indexed, cancelled);
        pending.push(cancelled);
      } else {
        removable.set(current.id, current);
        if (!stored && hasGenerationIdentity(current) && ["completed", "failed", "cancelled"].includes(current.status)) terminalWithoutFile.add(current.id);
      }
    }
    if (process.platform === "linux" && !hasCurrentJob && !state.reviewGateSessions.some(entry =>
      entry.sessionId === sessionId && context.epoch && entry.epoch === context.epoch)) throw noCurrentWork;
  }, { timeoutMs: remaining() }); } catch (error) {
    if (error === noCurrentWork) return;
    throw error;
  }
  // 同じ共有brokerへの通知はexecution/generationで限定し、broker自体は止めない。
  const confirmations = await Promise.all(pending.map(async job => {
    try {
      if (remaining() <= 0) return false;
      if (process.platform === "linux") withStateSnapshot(workspaceRoot, (state, context) => {
        const indexed = state.jobs.find(current => current.id === job.id);
        const jobFile = resolveJobFile(workspaceRoot, job.id);
        const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
        if (!context.epoch || job.epoch !== context.epoch || ![indexed, stored].every(current => matchesGeneration(current, job))) {
          throw new Error("SessionEnd job epoch changed before interruption.");
        }
      }, { timeoutMs: remaining() });
      if (job.grokTransport === "direct" && job.grokDirectGeneration) {
        return await waitForDirectAgentStop(workspaceRoot, job.id, job,
          { timeoutMs: remaining() });
      }
      if (job.grokPromptState === "not-sent") return true;
      if (job.grokTransport !== "broker" || !job.grokBrokerGeneration) return false;
      let timer;
      try {
        return await Promise.race([
          interruptGrokTurn(cwd, { sessionId: job.grokSessionId, executionId: job.id,
            transport: job.grokTransport, brokerGeneration: job.grokBrokerGeneration }).then(result => result.stopConfirmed === true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), remaining()); timer.unref?.(); })
        ]);
      } finally { if (timer) clearTimeout(timer); }
    } catch (error) {
      appendCleanupLog(job.logFile, `SessionEnd agent stop remains pending: ${error?.message ?? String(error)}`);
      return false;
    }
  }));
  for (const [index, job] of pending.entries()) {
    if (!confirmations[index]) continue;
    if ((process.platform === "darwin" || process.platform === "linux") && job.workerLease) continue;
    if (process.platform === "linux") {
      try {
        withStateSnapshot(workspaceRoot, (state, context) => {
          const indexed = state.jobs.find(current => current.id === job.id);
          const jobFile = resolveJobFile(workspaceRoot, job.id);
          const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
          if (!context.epoch || job.epoch !== context.epoch || ![indexed, stored].every(current => matchesGeneration(current, job))) {
            throw new Error("SessionEnd job epoch changed before process lookup.");
          }
        }, { timeoutMs: remaining() });
      } catch { continue; }
    }
    const lookupOptions = { ...createProcessLookupDiagnostics(job.logFile), processLookupDeadline: deadline };
    const identity = confirmedWorkers.has(job.id) ? "absent" : inspectTrackedJobProcess(job.pid, job.processStartKey, lookupOptions);
    if (identity === "unavailable") continue;
    try {
      if (identity === "match") {
        const stopWorker = () => stopTrackedJobProcess(job.pid, job.processStartKey, lookupOptions);
        if (process.platform === "win32") {
          withStateSnapshot(workspaceRoot, state => {
            const indexed = state.jobs.find(current => current.id === job.id);
            const jobFile = resolveJobFile(workspaceRoot, job.id);
            const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
            if (![indexed, stored].every(current => matchesGeneration(current, job) &&
                (job.grokTransport !== "direct" || !job.grokDirectGeneration || directStopped(current, job)))) {
              throw new Error("SessionEnd worker generation or direct ACK changed before stop.");
            }
            stopWorker();
          }, { timeoutMs: remaining() });
        } else stopWorker();
      }
      removable.set(job.id, job);
    } catch (error) {
      appendCleanupLog(job.logFile, `SessionEnd worker exit remains pending: ${error?.message ?? String(error)}`);
    }
  }
  // 待機中に置換された個体や世代を消さない。directは両保存先のACKも再確認する。
  updateState(workspaceRoot, (state, context) => {
    state.jobs = state.jobs.filter(current => {
      if (process.platform === "linux" || process.platform === "darwin") return true;
      const expected = removable.get(current.id);
      if (!expected || !matchesGeneration(current, expected)) return true;
      const jobFile = resolveJobFile(workspaceRoot, current.id);
      const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
      if (terminalWithoutFile.has(current.id)) {
        // 初回も最終lock内もfileがなく、同じ完了世代の索引だけを整理する。
        return stored !== null || ["createdAt", "startedAt", "completedAt", "cancelledAt"].some(key => current[key] !== expected[key]);
      }
      if (confirmedWorkers.has(current.id) && ![current, stored].every(record => workerStopped(record, expected))) return true;
      return !matchesGeneration(stored, expected) || !sameTurnEvidence(current, stored) || !sameTurnEvidence(current, expected) ||
        (expected.terminationPending === true && expected.grokTransport === "direct" &&
        expected.grokDirectGeneration && ![current, stored].every(record => directStopped(record, expected)));
    });
    state.reviewGateSessions = state.reviewGateSessions.filter(entry => entry.sessionId !== sessionId ||
      (process.platform === "linux" && (!context.epoch || entry.epoch !== context.epoch)));
  }, { timeoutMs: remaining() });
}

async function cleanupSessionJobs(cwd, sessionId, options = {}) {
  function appendCleanupLog(logFile, message) {
    if (process.platform === "linux" || process.platform === "darwin") {
      // 非同期停止待ちの後に旧 record の log パスへ直接書かない。
      try { process.stderr.write(`Grok SessionEnd: ${String(message)}\n`); } catch { /* stderr 切断時も保留を維持する。 */ }
      return;
    }
    try {
      appendLogLine(logFile, message);
    } catch {
      // 補助ログが書けなくても、保留記録と後続ジョブの停止を守る。
      try {
        process.stderr.write("Grok SessionEnd could not append the cleanup diagnostic.\n");
      } catch {
        // stderr の切断でも停止処理を続ける。
      }
    }
  }
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    // v3 は欠落を空の状態と解釈せず、broker の cleanup に進まない。
    if (process.platform === "darwin") loadState(workspaceRoot);
    return;
  }
  return cleanupOwnedSessionJobs(cwd, workspaceRoot, sessionId, appendCleanupLog, options);
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  // 本家は Claude のトランスクリプトのパスも控えていたが、それは
  // `/codex:transfer`（Claude セッションの取り込み）専用だった。
  // Grok に相当機能が無く transfer を落としたため、ここも記録しない。
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const started = performance.now();
  return withWorkspaceDeadline(started + 2200, async () => {
    const cwd = input.cwd || process.cwd();
    // 手動 endpoint は所有・世代を証明できないため停止対象にしない。
    const brokerSession = loadBrokerSession(cwd);

    await cleanupSessionJobs(cwd, resolveSessionIdWithFallback(input.session_id, process.env), { processLookupDeadline: started + 2200 });
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    if (process.platform === "linux") {
      const hasUnverifiedJobs = withStateSnapshot(workspaceRoot, (state, context) => state.jobs.some(job => {
        if (job.sessionId !== resolveSessionIdWithFallback(input.session_id, process.env)) return false;
        const jobFile = resolveJobFile(workspaceRoot, job.id);
        const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
        if (!context.epoch || job.epoch !== context.epoch || !stored || stored.id !== job.id || stored.epoch !== context.epoch ||
            !job.claimToken || !sameLinuxLease(job.workerLease, stored.workerLease)) return true;
        verifyPublishedLinuxLeaseRecords({ context, indexed: job, stored, lease: job.workerLease });
        return false;
      }), { timeoutMs: Math.max(0, 2200 - (performance.now() - started)) });
      if (hasUnverifiedJobs) return;
    }
    const otherActiveJobs = listJobs(workspaceRoot).some(isActiveJob);
    if (otherActiveJobs) {
      return;
    }

    // hook 全体の3秒枠へ起動の余裕を残し、終了不明なら記録を次回へ保持する。
    await cleanupIdleBrokerSession(cwd, brokerSession, { timeoutMs: Math.min(1800, Math.max(0, 2200 - (performance.now() - started))) });
  });
}

async function main() {
  const input = await readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
