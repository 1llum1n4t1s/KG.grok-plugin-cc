#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { inspectTrackedJobProcess, stopTrackedJobProcess, terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/acp.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { listJobs, readJobFile, resolveJobFile, resolveStateFile, updateState, writeJobFile } from "./lib/state.mjs";
import { appendLogLine, nowIso, resolveSessionIdWithFallback, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// 再エクスポート。定義は tracked-jobs.mjs 側が正で、ここで別に持つと
// 片方だけ変わったときに SessionEnd のジョブ掃除が黙って効かなくなる。
export { SESSION_ID_ENV };
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const jobs = listJobs(workspaceRoot).filter((job) => job.sessionId === sessionId);
  const removableIds = new Set();
  for (const listedJob of jobs) {
    let job = listedJob;
    if (job.status === "queued") {
      // worker の running claim と同じ state lock 内で判定・確定する。
      // 先に claim された場合は最新の running record を停止対象へ回す。
      let cancelledQueued = false;
      updateState(workspaceRoot, (state) => {
        const indexed = state.jobs.find((entry) => entry.id === job.id && entry.sessionId === sessionId);
        if (!indexed) return;
        if (indexed.status !== "queued") {
          job = indexed;
          return;
        }
        const completedAt = nowIso();
        const jobFile = resolveJobFile(workspaceRoot, job.id);
        const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : indexed;
        const cancelled = {
          ...stored,
          status: "cancelled",
          phase: "cancelled",
          pid: null,
          completedAt,
          errorMessage: "Cancelled when the session ended."
        };
        writeJobFile(workspaceRoot, job.id, cancelled);
        Object.assign(indexed, cancelled);
        cancelledQueued = true;
      });
      if (cancelledQueued) continue;
    }
    if (job.status !== "running" && job.terminationPending !== true) {
      removableIds.add(job.id);
      continue;
    }

    const identity = inspectTrackedJobProcess(job.pid, job.processStartKey);
    if (identity === "unavailable") {
      appendLogLine(job.logFile, "SessionEnd could not verify the process identity; job record was retained.");
      continue;
    }
    if (identity === "match") {
      try {
        stopTrackedJobProcess(job.pid, job.processStartKey);
      } catch (error) {
        appendLogLine(job.logFile, `SessionEnd process termination failed: ${error?.message ?? String(error)}`);
        continue;
      }
    }
    removableIds.add(job.id);
  }

  updateState(workspaceRoot, (state) => {
    state.jobs = state.jobs.filter((job) => !removableIds.has(job.id));
    state.reviewGateSessions = state.reviewGateSessions.filter((entry) => entry.sessionId !== sessionId);
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  // 本家は Claude のトランスクリプトのパスも控えていたが、それは
  // `/codex:transfer`（Claude セッションの取り込み）専用だった。
  // Grok に相当機能が無く transfer を落としたため、ここも記録しない。
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  cleanupSessionJobs(cwd, resolveSessionIdWithFallback(input.session_id, process.env));
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const otherActiveJobs = listJobs(workspaceRoot).some((job) => job.status === "queued" || job.status === "running" || job.terminationPending === true);
  if (otherActiveJobs) {
    return;
  }

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint, 250);
  }

  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
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
