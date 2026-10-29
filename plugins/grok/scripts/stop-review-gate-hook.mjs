#!/usr/bin/env node

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { getGrokAvailability } from "./lib/grok.mjs";
import { isActiveJob } from "./lib/job-status.mjs";
import { collectWorkingTreeSnapshot, buildWorkingTreeSnapshotDiff, READ_ONLY_GIT_GLOBAL_ARGS } from "./lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  clearReviewGateSession,
  getConfig,
  getReviewGateSession,
  listJobs,
  updateState,
  withStateSnapshot
} from "./lib/state.mjs";
import { filterJobsForCurrentSession, sortJobsNewestFirst } from "./lib/job-control.mjs";
import { resolveSessionIdWithFallback, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot, withWorkspaceDeadline } from "./lib/workspace.mjs";
import { readHookInput } from "./lib/fs.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const STOP_REVIEW_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const FALLBACK_TURN_KEY = "session-turn";
const STOP_REVIEW_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const STOP_REVIEW_MAX_COMPRESSED_SNAPSHOT_BYTES = 1024 * 1024;
const STOP_REVIEW_MAX_TOTAL_CIPHERTEXT_BYTES = 8 * 1024 * 1024;

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function buildStopReviewPrompt(input = {}, pendingReason = null, evidence = "") {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const assistantResponseBlock = lastAssistantMessage
    ? ["Previous assistant response:", lastAssistantMessage].join("\n")
    : "";
  const pendingReviewBlock = pendingReason
    ? [
        "Outstanding blocker from the previous stop-gate review:",
        pendingReason,
        "Verify that the current edits resolve this blocker before returning ALLOW."
      ].join("\n")
    : "";
  return interpolateTemplate(template, {
    ASSISTANT_RESPONSE_BLOCK: assistantResponseBlock,
    PENDING_REVIEW_BLOCK: pendingReviewBlock,
    TURN_DIFF_BLOCK: evidence,
    READ_ONLY_GIT_PREFIX: `git ${READ_ONLY_GIT_GLOBAL_ARGS.join(" ")}`
  });
}

function buildSetupNote(cwd) {
  const availability = getGrokAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Grok is not set up for the review gate.${detail} Run /grok:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      retryWithoutChanges: true,
      reason:
        "The stop-time Grok review task returned no final output. Run /grok:review manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, retryWithoutChanges: false, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      retryWithoutChanges: false,
      reason: `Grok stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    retryWithoutChanges: true,
    reason:
      "The stop-time Grok review task returned an unexpected answer. Run /grok:review manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}, pendingReason = null, evidence = "") {
  const scriptPath = path.join(SCRIPT_DIR, "grok-companion.mjs");
  const prompt = buildStopReviewPrompt(input, pendingReason, evidence);
  const sessionId = resolveSessionIdWithFallback(input.session_id, process.env);
  const childEnv = {
    ...process.env,
    ...(sessionId ? { [SESSION_ID_ENV]: sessionId } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", "--stop-gate"], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    input: prompt,
    maxBuffer: STOP_REVIEW_MAX_BUFFER_BYTES,
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (/** @type {Error & { code?: string }} */ (result.error)?.code === "ETIMEDOUT") {
    return {
      ok: false,
      retryWithoutChanges: true,
      reason:
        "The stop-time Grok review task timed out after 15 minutes. Run /grok:review manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      retryWithoutChanges: true,
      reason: detail
        ? `The stop-time Grok review task failed: ${detail}`
        : "The stop-time Grok review task failed. Run /grok:review manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      retryWithoutChanges: true,
      reason:
        "The stop-time Grok review task returned invalid JSON. Run /grok:review manually or bypass the gate."
    };
  }
}

function getTurnKey(input = {}) {
  return String(input.turn_id ?? "").trim() || String(input.prompt_id ?? "").trim() || FALLBACK_TURN_KEY;
}

const PROMPT_BASELINE_TIMEOUT_MS = 45_000;
const BASELINE_STATE_LOCK_TIMEOUT_MS = 7_500;

function remainingBaselineTime(deadline, limit = Infinity) {
  if (deadline === undefined) return limit;
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("Grok review gate baseline deadline expired.");
  return Math.min(limit, Math.max(1, Math.ceil(remaining)));
}

function tryGetWorkingTreeSnapshot(workspaceRoot, options = {}) {
  try {
    return collectWorkingTreeSnapshot(workspaceRoot, options);
  } catch {
    logNote("Grok review gate could not snapshot the working tree; review cannot proceed safely.");
    return null;
  }
}

function protectSnapshotPayload(payload, unprotect = false, deadline = undefined) {
  if (process.platform !== "win32" || !process.env.SystemRoot) {
    throw new Error("Protected stop-gate snapshot storage is unavailable.");
  }
  const operation = unprotect ? "Unprotect" : "Protect";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())",
    "$entropy = [Text.Encoding]::UTF8.GetBytes('grok-stop-gate-v1')",
    `$result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($result))"
  ].join("; ");
  const result = spawnSync(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: payload, encoding: "utf8", timeout: remainingBaselineTime(deadline, 10_000), windowsHide: true,
      maxBuffer: 2 * STOP_REVIEW_MAX_COMPRESSED_SNAPSHOT_BYTES
    });
  if (result.error || result.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.stdout ?? "")) {
    throw new Error("Protected stop-gate snapshot storage is unavailable.");
  }
  return result.stdout;
}

function encodeBaselineSnapshot(snapshot, workspaceRoot, sessionId, turnKey, captureNonce, capturedAt, deadline = undefined) {
  remainingBaselineTime(deadline);
  const canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  const serialized = Buffer.from(JSON.stringify({ version: 1, workspaceRoot: canonicalWorkspaceRoot, sessionId, turnKey, captureNonce, capturedAt, snapshot }));
  if (serialized.length > STOP_REVIEW_MAX_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds storage limit.");
  const compressed = deflateRawSync(serialized);
  if (compressed.length > STOP_REVIEW_MAX_COMPRESSED_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds storage limit.");
  return { version: 1, ciphertext: protectSnapshotPayload(compressed.toString("base64"), false, deadline) };
}

function decodeBaselineSnapshot(value, workspaceRoot, sessionId, turnKey, captureNonce, capturedAt) {
  if (value?.version !== 1 || typeof value.ciphertext !== "string" ||
      value.ciphertext.length > 2 * STOP_REVIEW_MAX_COMPRESSED_SNAPSHOT_BYTES) {
    throw new Error("Protected turn baseline is unavailable.");
  }
  const compressed = Buffer.from(protectSnapshotPayload(value.ciphertext, true), "base64");
  if (compressed.length > STOP_REVIEW_MAX_COMPRESSED_SNAPSHOT_BYTES) throw new Error("Snapshot exceeds storage limit.");
  const envelope = JSON.parse(inflateRawSync(compressed, { maxOutputLength: STOP_REVIEW_MAX_SNAPSHOT_BYTES }).toString("utf8"));
  if (envelope.version !== 1 || envelope.workspaceRoot !== fs.realpathSync.native(workspaceRoot) ||
      envelope.sessionId !== sessionId || envelope.turnKey !== turnKey || !captureNonce ||
      envelope.captureNonce !== captureNonce || !capturedAt || envelope.capturedAt !== capturedAt || !envelope.snapshot?.fingerprint) {
    throw new Error("Protected turn baseline scope does not match.");
  }
  return envelope.snapshot;
}

// nonce の照合と更新を state lock 内で行い、新しいターンや別ジョブを消さない。
function updateCurrentGateSession(workspaceRoot, sessionId, nonce, replacement, deadline = undefined) {
  let updated = false;
  updateState(workspaceRoot, (state, context) => {
    const index = state.reviewGateSessions.findIndex((entry) => entry.sessionId === sessionId &&
      (process.platform !== "linux" || (context?.epoch && entry.epoch === context.epoch)));
    if (index < 0 || state.reviewGateSessions[index].baselineNonce !== nonce) return;
    if (replacement?.baselineSnapshot) {
      const total = state.reviewGateSessions.reduce((bytes, entry, i) => bytes + String(
        (i === index ? replacement.baselineSnapshot : entry.baselineSnapshot)?.ciphertext ?? ""
      ).length, 0);
      if (total > STOP_REVIEW_MAX_TOTAL_CIPHERTEXT_BYTES) return;
    }
    if (replacement) state.reviewGateSessions[index] = { ...state.reviewGateSessions[index], ...replacement };
    else state.reviewGateSessions.splice(index, 1);
    updated = true;
  }, deadline === undefined ? undefined : { timeoutMs: remainingBaselineTime(deadline, BASELINE_STATE_LOCK_TIMEOUT_MS) });
  return updated;
}

function recordTurnBaseline(workspaceRoot, input, sessionId, deadline) {
  if (!sessionId || !getConfig(workspaceRoot).stopReviewGate) {
    return;
  }
  const baselineNonce = randomUUID();
  const turnKey = getTurnKey(input);
  const capturedAt = new Date().toISOString();
  updateState(workspaceRoot, (state, context) => {
    const current = entry => entry.sessionId === sessionId &&
      (process.platform !== "linux" || (context?.epoch && entry.epoch === context.epoch));
    if (process.platform === "linux" && !context?.epoch) throw new Error("State epoch is unavailable.");
    const previous = state.reviewGateSessions.find(current);
    state.reviewGateSessions = state.reviewGateSessions.filter(entry => !current(entry));
    state.reviewGateSessions.unshift({ sessionId, ...(process.platform === "linux" ? { epoch: context.epoch } : {}), turnKey, baselineNonce, capturedAt,
      baselineFingerprint: null, baselineSnapshot: null, pendingReviewedFingerprint: null,
      pendingReason: previous?.pendingReason ?? null,
      retryWithoutChanges: Boolean(previous?.retryWithoutChanges), updatedAt: capturedAt });
  }, { timeoutMs: remainingBaselineTime(deadline, BASELINE_STATE_LOCK_TIMEOUT_MS) });
  try {
    const snapshot = tryGetWorkingTreeSnapshot(workspaceRoot, { deadline });
    if (!snapshot) return;
    const baselineSnapshot = encodeBaselineSnapshot(snapshot, workspaceRoot, sessionId, turnKey, baselineNonce, capturedAt, deadline);
    if (!updateCurrentGateSession(workspaceRoot, sessionId, baselineNonce, {
      baselineFingerprint: snapshot.fingerprint, baselineSnapshot
    }, deadline)) logNote("Grok review gate could not retain its protected baseline within the storage limit or active turn.");
  } catch {
    logNote("Grok review gate could not protect its turn baseline; review remains incomplete.");
  }
}

function main(input) {
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const deadline = input.hook_event_name === "UserPromptSubmit" ? performance.now() + PROMPT_BASELINE_TIMEOUT_MS : undefined;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  try {
    return handleHookEvent(input, cwd, workspaceRoot, config, deadline);
  } catch (error) {
    if (input.hook_event_name === "UserPromptSubmit" || !config.stopReviewGate) throw error;
    logNote("Grok review gate could not access or update the state needed to complete the review.");
    emitDecision({ decision: "block", reason: "Grok stop-time review is incomplete: unable to complete the review or access its state. Resolve the error or explicitly disable the gate with /grok:setup --disable-review-gate." });
  }
}

function handleHookEvent(input, cwd, workspaceRoot, config, deadline) {
  const sessionId = resolveSessionIdWithFallback(input.session_id, process.env);
  if (input.hook_event_name === "UserPromptSubmit") {
    if (!sessionId || !config.stopReviewGate) return;
    try {
      return withWorkspaceDeadline(deadline, () => {
        recordTurnBaseline(workspaceRoot, input, sessionId, deadline);
      });
    } catch {
      // 旧 baseline を無効化できないまま次ターンを始めると、turn_id が無い
      // ホストでは旧 snapshot を同じターンの証拠として再利用してしまう。
      logNote("Grok review gate could not initialize the turn baseline. Retry the prompt after resolving the workspace or state lock.");
      process.exitCode = 2;
      return;
    }
  }

  const jobs = sortJobsNewestFirst(
    filterJobsForCurrentSession(listJobs(workspaceRoot), {
      sessionId: input.session_id,
      env: process.env
    })
  );
  const runningJob = jobs.find(isActiveJob);
  const runningTaskNote = runningJob
    ? runningJob.terminationPending
      ? `Grok task ${runningJob.id} still needs process termination. Retry /grok:cancel ${runningJob.id} before ending the session.`
      : `Grok task ${runningJob.id} is still running. Check /grok:status and use /grok:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    if (process.platform === "linux") {
      updateState(workspaceRoot, (state, context) => {
        state.reviewGateSessions = state.reviewGateSessions.filter(entry => entry.sessionId !== sessionId || entry.epoch !== context.epoch);
      });
    } else clearReviewGateSession(workspaceRoot, sessionId);
    logNote(runningTaskNote);
    return;
  }

  const gateSession = process.platform === "linux"
    ? withStateSnapshot(workspaceRoot, (state, context) => state.reviewGateSessions.find(entry =>
      entry.sessionId === sessionId && context.epoch && entry.epoch === context.epoch) ?? null)
    : getReviewGateSession(workspaceRoot, sessionId);
  function blockIncomplete(detail) {
    const reason = `Grok stop-time review is incomplete: ${detail} No completed review is recorded. Resolve collection or explicitly disable the gate with /grok:setup --disable-review-gate.`;
    emitDecision({ decision: "block", reason: runningTaskNote ? `${runningTaskNote} ${reason}` : reason });
  }
  const currentSnapshot = tryGetWorkingTreeSnapshot(workspaceRoot);
  if (!currentSnapshot) {
    blockIncomplete("unable to collect a safe working tree snapshot.");
    return;
  }
  let baselineSnapshot;
  try {
    if (!gateSession?.baselineNonce || gateSession.turnKey !== getTurnKey(input)) throw new Error("Missing baseline");
    baselineSnapshot = decodeBaselineSnapshot(gateSession.baselineSnapshot, workspaceRoot, sessionId, getTurnKey(input), gateSession.baselineNonce, gateSession.capturedAt);
    if (baselineSnapshot.fingerprint !== gateSession.baselineFingerprint) throw new Error("Baseline mismatch");
  } catch {
    blockIncomplete("a protected baseline for this turn is unavailable; submit a new user turn to capture it.");
    return;
  }
  const gateStillCurrent = () => process.platform !== "linux" || withStateSnapshot(workspaceRoot, (state, context) =>
    Boolean(context.epoch && gateSession.epoch === context.epoch && state.reviewGateSessions.some(entry =>
      entry.sessionId === sessionId && entry.epoch === context.epoch && entry.baselineNonce === gateSession.baselineNonce)));
  if (!gateStillCurrent()) {
    blockIncomplete("the active state epoch or turn changed while checking the baseline.");
    return;
  }
  const unchangedTurn = baselineSnapshot.fingerprint === currentSnapshot.fingerprint;
  const unchangedSinceReview = gateSession.pendingReviewedFingerprint === currentSnapshot.fingerprint;
  if ((unchangedTurn || unchangedSinceReview) && gateSession?.pendingReason && !gateSession.retryWithoutChanges) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${gateSession.pendingReason}` : gateSession.pendingReason
    });
    return;
  }
  if (unchangedTurn && !gateSession?.pendingReason) {
    if (!updateCurrentGateSession(workspaceRoot, sessionId, gateSession.baselineNonce, null)) {
      blockIncomplete("the active turn changed while checking the baseline.");
      return;
    }
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    blockIncomplete(setupNote);
    return;
  }

  let evidence;
  try {
    const diff = buildWorkingTreeSnapshotDiff(baselineSnapshot, currentSnapshot);
    if (!diff.complete || diff.fingerprint !== currentSnapshot.fingerprint || !diff.context) throw new Error("Incomplete diff");
    evidence = diff.context;
  } catch {
    blockIncomplete("the exact turn diff could not be collected completely.");
    return;
  }
  if (!gateStillCurrent()) {
    blockIncomplete("the active state epoch or turn changed before review.");
    return;
  }
  const review = runStopReview(cwd, input, gateSession?.pendingReason ?? null, evidence);
  const reviewedSnapshot = tryGetWorkingTreeSnapshot(workspaceRoot);
  if (!reviewedSnapshot || reviewedSnapshot.fingerprint !== currentSnapshot.fingerprint) {
    blockIncomplete("the working tree changed during review or could not be revalidated.");
    return;
  }
  if (!review.ok) {
    const updated = updateCurrentGateSession(workspaceRoot, sessionId, gateSession.baselineNonce, {
      pendingReason: review.reason,
      pendingReviewedFingerprint: currentSnapshot.fingerprint,
      retryWithoutChanges: review.retryWithoutChanges
    });
    if (!updated) {
      blockIncomplete("the active turn changed during review.");
      return;
    }
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  if (!updateCurrentGateSession(workspaceRoot, sessionId, gateSession.baselineNonce, null)) {
    blockIncomplete("the active turn changed during review.");
    return;
  }
  logNote(runningTaskNote);
}

try {
  main(await readHookInput());
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
