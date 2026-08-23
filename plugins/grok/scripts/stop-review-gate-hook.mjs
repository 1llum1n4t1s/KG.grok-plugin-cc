#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getGrokAvailability } from "./lib/grok.mjs";
import { getWorkingTreeFingerprint } from "./lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  clearReviewGateSession,
  getConfig,
  getReviewGateSession,
  listJobs,
  setReviewGateSession
} from "./lib/state.mjs";
import { filterJobsForCurrentSession, sortJobsNewestFirst } from "./lib/job-control.mjs";
import { resolveSessionIdWithFallback, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const STOP_REVIEW_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const FALLBACK_TURN_KEY = "session-turn";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function buildStopReviewPrompt(input = {}, pendingReason = null) {
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
    PENDING_REVIEW_BLOCK: pendingReviewBlock
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

function runStopReview(cwd, input = {}, pendingReason = null) {
  const scriptPath = path.join(SCRIPT_DIR, "grok-companion.mjs");
  const prompt = buildStopReviewPrompt(input, pendingReason);
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

  if (result.error?.code === "ETIMEDOUT") {
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
  return String(input.turn_id ?? "").trim() || FALLBACK_TURN_KEY;
}

function tryGetWorkingTreeFingerprint(workspaceRoot) {
  try {
    return getWorkingTreeFingerprint(workspaceRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logNote(`Grok review gate could not snapshot the working tree; unchanged-turn skipping is disabled: ${message}`);
    return null;
  }
}

function recordTurnBaseline(workspaceRoot, input, sessionId) {
  if (!sessionId || !getConfig(workspaceRoot).stopReviewGate) {
    return;
  }
  const baselineFingerprint = tryGetWorkingTreeFingerprint(workspaceRoot);
  if (!baselineFingerprint) {
    return;
  }
  const previous = getReviewGateSession(workspaceRoot, sessionId);
  setReviewGateSession(workspaceRoot, sessionId, {
    turnKey: getTurnKey(input),
    baselineFingerprint,
    pendingReason: previous?.pendingReason ?? null,
    retryWithoutChanges: Boolean(previous?.retryWithoutChanges)
  });
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const sessionId = resolveSessionIdWithFallback(input.session_id, process.env);

  if (input.hook_event_name === "UserPromptSubmit") {
    recordTurnBaseline(workspaceRoot, input, sessionId);
    return;
  }

  const jobs = sortJobsNewestFirst(
    filterJobsForCurrentSession(listJobs(workspaceRoot), {
      sessionId: input.session_id,
      env: process.env
    })
  );
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Grok task ${runningJob.id} is still running. Check /grok:status and use /grok:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    clearReviewGateSession(workspaceRoot, sessionId);
    logNote(runningTaskNote);
    return;
  }

  const gateSession = getReviewGateSession(workspaceRoot, sessionId);
  const currentFingerprint = tryGetWorkingTreeFingerprint(workspaceRoot);
  const unchangedTurn = Boolean(
    gateSession?.baselineFingerprint &&
      currentFingerprint &&
      gateSession.turnKey === getTurnKey(input) &&
      gateSession.baselineFingerprint === currentFingerprint
  );
  if (unchangedTurn && gateSession?.pendingReason && !gateSession.retryWithoutChanges) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${gateSession.pendingReason}` : gateSession.pendingReason
    });
    return;
  }
  if (unchangedTurn && !gateSession?.pendingReason) {
    clearReviewGateSession(workspaceRoot, sessionId);
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input, gateSession?.pendingReason ?? null);
  if (!review.ok) {
    setReviewGateSession(workspaceRoot, sessionId, {
      turnKey: null,
      baselineFingerprint: null,
      pendingReason: review.reason,
      retryWithoutChanges: review.retryWithoutChanges
    });
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  clearReviewGateSession(workspaceRoot, sessionId);
  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
