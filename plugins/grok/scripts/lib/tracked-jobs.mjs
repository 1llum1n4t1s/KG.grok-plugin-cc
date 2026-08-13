import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, updateState, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "GROK_COMPANION_SESSION_ID";
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      grokSessionId: typeof value.grokSessionId === "string" && value.grokSessionId.trim() ? value.grokSessionId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    grokSessionId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, { encoding: "utf8", mode: 0o600 });
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, { encoding: "utf8", mode: 0o600 });
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600 });
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.grokSessionId && normalized.grokSessionId !== lastThreadId) {
      lastThreadId = normalized.grokSessionId;
      patch.grokSessionId = normalized.grokSessionId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    commitNonTerminalTransition(workspaceRoot, jobId, (current) => ({ ...current, ...patch }));
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[grok] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function commitNonTerminalTransition(workspaceRoot, jobId, buildNext) {
  let accepted = false;
  let nextRecord = null;
  updateState(workspaceRoot, (state) => {
    const index = state.jobs.findIndex((candidate) => candidate.id === jobId);
    const indexed = index === -1 ? null : state.jobs[index];
    const stored = readStoredJobOrNull(workspaceRoot, jobId);
    const current = { ...(indexed ?? {}), ...(stored ?? {}) };
    if (TERMINAL_STATUSES.has(current.status)) {
      return;
    }

    nextRecord = buildNext(current);
    writeJobFile(workspaceRoot, jobId, nextRecord);
    const timestamp = nowIso();
    const { result: _result, rendered: _rendered, request: _request, ...summaryRecord } = nextRecord;
    const indexedRecord = { ...summaryRecord, updatedAt: timestamp };
    if (index === -1) state.jobs.unshift(indexedRecord);
    else state.jobs[index] = { ...indexed, ...indexedRecord };
    accepted = true;
  });
  return { accepted, record: nextRecord };
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  const claim = commitNonTerminalTransition(job.workspaceRoot, job.id, () => runningRecord);
  if (!claim.accepted) {
    const stored = readStoredJobOrNull(job.workspaceRoot, job.id);
    throw new Error(`Job ${job.id} is already ${stored?.status ?? "terminal"}; the worker will not start.`);
  }

  try {
    const execution = await runner();
    // exitStatus はランタイムの status 文字列（"completed" / "failed" ほか）。
    // 本家 Codex 版は数値の終了コードだったので `=== 0` で比較していたが、
    // そのままだと全ジョブが failed として記録されてしまう。
    const completionStatus = execution.exitStatus === "completed" ? "completed" : "failed";
    const completedAt = nowIso();
    const completion = commitNonTerminalTransition(job.workspaceRoot, job.id, (current) => ({
      ...current,
      status: completionStatus,
      grokSessionId: execution.grokSessionId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered,
      summary: execution.summary
    }));
    if (!completion.accepted) {
      return execution;
    }
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const diagnostic = error instanceof Error
      ? [
          error.stack,
          error.cause ? `Cause: ${String(error.cause)}` : null,
          "code" in error && error.code ? `Code: ${String(error.code)}` : null
        ]
          .filter(Boolean)
          .join("\n")
      : String(error);
    appendLogBlock(options.logFile ?? job.logFile ?? existing.logFile ?? null, "Failure diagnostic", diagnostic);
    const completedAt = nowIso();
    const failure = commitNonTerminalTransition(job.workspaceRoot, job.id, (current) => ({
      ...current,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    }));
    if (!failure.accepted && existing.status === "cancelled") {
      throw error;
    }
    throw error;
  }
}
