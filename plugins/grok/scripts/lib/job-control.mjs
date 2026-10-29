import fs from "node:fs";

import { getSessionRuntimeStatus } from "./grok.mjs";
import { isActiveJob, looksLikeVerificationCommand } from "./job-status.mjs";
import { getProcessSnapshot, inspectTrackedJobProcess } from "./process.mjs";
import { assertDarwinPruneContext, assertLinuxHistoryContext, compareUpdatedAtNewestFirst, getConfig, listJobs, readJobFile, resolveJobFile, resolveStateDir, updateState, withStateLockMigrationScope, writeJobFile } from "./state.mjs";
import { darwinLeaseDirectory, resolveSessionIdWithFallback, sameDarwinLease, sameLinuxLease } from "./tracked-jobs.mjs";
import { withAvailableDarwinLease } from "./darwin-worker-lease.mjs";
import { verifyPublishedDarwinLeaseRecords } from "./darwin-lease-sweep.mjs";
import { withAvailableLinuxLease } from "./linux-worker-lease.mjs";
import { verifyPublishedLinuxLeaseRecords } from "./linux-lease-ledger.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort(compareUpdatedAtNewestFirst);
}

function getCurrentSessionId(options = {}) {
  return resolveSessionIdWithFallback(options.sessionId, options.env ?? process.env);
}

export function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const raw = fs.readFileSync(logFile, "utf8");
  if (Number.isSafeInteger(maxLines) && maxLines > 0) {
    const lines = [];
    let end = raw.length;
    while (end > 0 && lines.length < maxLines) {
      const start = raw.lastIndexOf("\n", end - 1);
      const line = raw.slice(start + 1, end).trimEnd();
      if (line.startsWith("[")) {
        const message = stripLogPrefix(line);
        if (message && !isProgressBlockTitle(message)) lines.push(message);
      }
      end = start;
    }
    return lines.reverse();
  }

  // 0・負数・小数などには既存の slice(-maxLines) の意味を保つ。
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting grok") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("grok error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      isActiveJob(job) || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      !isActiveJob(job) && (job.status === "completed" || job.status === "failed" || job.status === "cancelled")
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId, context = undefined) {
  if (context) {
    if (process.platform === "darwin") assertDarwinPruneContext(context);
    else if (process.platform === "linux") assertLinuxHistoryContext(context);
    else context.check();
  }
  const jobFile = resolveJobFile(workspaceRoot, jobId, context?.stateDir);
  if (!fs.existsSync(jobFile)) {
    context?.check();
    return null;
  }
  const result = readJobFile(jobFile);
  context?.check();
  return result;
}

/**
 * ジョブ ID として受け付ける形。
 * 参照はスラッシュコマンドの自由記述から来るので、ID になり得ない文字列は
 * 検索する前に弾く。シェルのメタ文字が紛れ込んだまま先へ流れるのも防ぐ。
 */
const JOB_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STALE_QUEUED_JOB_MS = 60_000;

function validProcessStartKey(startKey) {
  if (typeof startKey !== "string") return false;
  if (process.platform === "win32") return /^win32-filetime:[1-9]\d{16,18}$/.test(startKey);
  if (process.platform === "linux") return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/i.test(startKey);
  if (process.platform === "darwin") {
    const match = /^darwin-lstart-utc-v1:(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}([1-9]|[12]\d|3[01]) ((?:[01]\d|2[0-3])):([0-5]\d):([0-5]\d) (\d{4})$/.exec(startKey);
    if (!match) return false;
    const [, weekday, month, day, hour, minute, second, year] = match;
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const date = new Date(Date.UTC(Number(year), months.indexOf(month), Number(day), Number(hour), Number(minute), Number(second)));
    return Number(year) >= 1970 && date.getUTCFullYear() === Number(year) && date.getUTCMonth() === months.indexOf(month) &&
      date.getUTCDate() === Number(day) && ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()] === weekday;
  }
  return false;
}

function reconcileOrphanedJobs(workspaceRoot) {
  const now = Date.now();
  const candidates = listJobs(workspaceRoot).filter(candidate => candidate.status === "queued" || candidate.status === "running");
  if (!candidates.length) return;
  const turnEvidenceFields = ["grokPromptState", "grokSessionId", "grokTransport", "grokBrokerGeneration",
    "grokDirectGeneration", "grokDirectOwnerPid", "grokDirectOwnerStartKey"];
  const sameOrphanTurnEvidence = (indexed, stored) =>
    turnEvidenceFields.every(key => (indexed[key] ?? null) === (stored[key] ?? null));
  withStateLockMigrationScope(resolveStateDir(workspaceRoot), check => {
    for (const candidate of candidates) {
      check();
      const candidateDetail = readStoredJob(workspaceRoot, candidate.id);
      if (process.platform === "linux" && (!candidateDetail || candidate.epoch !== check.epoch ||
          candidateDetail.id !== candidate.id || candidateDetail.epoch !== check.epoch)) continue;
      if ((process.platform === "darwin" || process.platform === "linux") && (candidate.workerLease || candidateDetail?.workerLease)) {
        const sameLease = process.platform === "linux" ? sameLinuxLease : sameDarwinLease;
        const unconfirmed = {};
        try {
          updateState(workspaceRoot, (state, context) => {
            const indexed = state.jobs.find(entry => entry.id === candidate.id);
            const stored = readStoredJob(workspaceRoot, candidate.id, context);
            const matchingTurnEvidence = sameOrphanTurnEvidence(indexed, stored);
            const terminationPending = !matchingTurnEvidence || indexed.terminationPending === true || stored.terminationPending === true ||
              (indexed.grokPromptState !== "not-sent" && indexed.grokPromptState !== "terminal");
            const patch = { status: "failed", phase: terminationPending ? "termination-pending" : "failed", terminationPending,
              pid: null, completedAt: new Date(now).toISOString(), errorMessage: "Job process exited without recording a final result.",
              workerStopConfirmed: true, workerStopProof: process.platform === "linux" ? "linux-lease-released" : "darwin-lease-released", workerStopLeaseId: indexed.workerLease.id,
              workerStopProcessStartKey: indexed.processStartKey ?? null };
            context.check();
            writeJobFile(workspaceRoot, indexed.id, { ...stored, ...patch }, context);
            Object.assign(indexed, patch);
          }, { aroundCommit: (state, context, commit) => {
            const indexed = state.jobs.find(entry => entry.id === candidate.id);
            const stored = readStoredJob(workspaceRoot, candidate.id, context);
            if (indexed && stored && indexed.epoch === context.epoch && stored.epoch === context.epoch &&
                indexed.createdAt === stored.createdAt && indexed.claimToken && indexed.claimToken === stored.claimToken &&
                sameLease(indexed.workerLease, stored.workerLease) &&
                (indexed.status !== stored.status || indexed.pid !== stored.pid)) {
              throw new Error(`Job ${candidate.id} has partially saved worker state; both records were preserved. Stop all runtimes and inspect the records before offline recovery.`);
            }
            const same = record => record && record.id === candidate.id && record.createdAt === candidate.createdAt &&
              record.startedAt === candidate.startedAt && record.status === candidate.status && record.pid === candidate.pid &&
              record.processStartKey === candidate.processStartKey && record.epoch === context.epoch &&
              record.claimToken && record.claimToken === candidate.claimToken && sameLease(record.workerLease, candidate.workerLease);
            if (context.epoch !== check.epoch || ![indexed, stored].every(same) || !["queued", "running"].includes(indexed.status)) throw unconfirmed;
            if (process.platform === "linux") {
              const observedLease = withAvailableLinuxLease(indexed.workerLease, context, () => {
                verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
                context.check();
                return commit();
              });
              if (observedLease.status !== "available") throw unconfirmed;
              return observedLease.value;
            }
            const leaseContext = darwinLeaseDirectory(context);
            if (leaseContext.expectedDirectoryIdentity.dev !== indexed.workerLease.directoryDev ||
                leaseContext.expectedDirectoryIdentity.ino !== indexed.workerLease.directoryIno) throw unconfirmed;
            const observedLease = withAvailableDarwinLease(indexed.workerLease, leaseContext, () => {
              verifyPublishedDarwinLeaseRecords({ context, indexed, stored, lease: indexed.workerLease });
              context.check();
              return commit();
            });
            if (observedLease.status !== "available") throw unconfirmed;
            return observedLease.value;
          } });
        } catch (error) { if (error !== unconfirmed) throw error; }
        continue;
      }
      // 旧世代の lease 不在は停止の証拠にならない。
      if (["linux", "darwin"].includes(process.platform)) continue;
      const observed = { ...candidate, ...candidateDetail };
      const queuedCandidate = observed.status === "queued" && now - Date.parse(observed.createdAt ?? observed.updatedAt ?? "") > STALE_QUEUED_JOB_MS;
      let exited = false;
      if (observed.status === "running" && Number.isInteger(observed.pid) && validProcessStartKey(observed.processStartKey)) {
        const identity = inspectTrackedJobProcess(observed.pid, observed.processStartKey, { getProcessSnapshotImpl: (pid, options) => {
          check();
          const snapshot = getProcessSnapshot(pid, options);
          return validProcessStartKey(snapshot?.startKey) ? snapshot : null;
        } });
        exited = identity === "absent" || identity === "mismatch";
      }
      if (!queuedCandidate && !exited) continue;
      check();
      updateState(workspaceRoot, (state, context) => {
        const indexed = state.jobs.find((entry) => entry.id === candidate.id);
        if (!indexed) return;
        const stored = readStoredJob(workspaceRoot, candidate.id, context);
        const job = { ...indexed, ...stored };
        const queuedTooLong = job.status === "queued" && now - Date.parse(job.createdAt ?? job.updatedAt ?? "") > STALE_QUEUED_JOB_MS;
        // ロック外の照会と確定の間に、別世代や完了状態が記録された場合は触らない。
        const sameWorker = record => record && record.id === observed.id && record.createdAt === observed.createdAt &&
          record.status === "running" && record.pid === observed.pid && record.processStartKey === observed.processStartKey;
        const runningProcessExited = exited && sameWorker(indexed) && (!stored || sameWorker(stored));
        if (!queuedTooLong && !runningProcessExited) return;

        const completedAt = new Date(now).toISOString();
        const errorMessage = queuedTooLong
          ? "Job process did not start within 60 seconds."
          : "Job process exited without recording a final result.";
        // 索引と詳細のどちらかだけを採用すると、送信済みの turn を未送信と誤認し得る。
        // 欠落・矛盾があるときは各原本を保ち、終了証拠が揃うまで保留する。
        const matchingTurnEvidence = stored && sameOrphanTurnEvidence(indexed, stored);
        const terminationPending = !matchingTurnEvidence || indexed.terminationPending === true || stored?.terminationPending === true ||
          (job.grokPromptState !== "not-sent" && job.grokPromptState !== "terminal");
        const patch = { status: "failed", phase: terminationPending ? "termination-pending" : "failed",
          terminationPending, pid: null, completedAt, errorMessage };
        if (stored) writeJobFile(workspaceRoot, job.id, { ...stored, ...patch }, context);
        Object.assign(indexed, patch);
      });
    }
  });
}

/** @param {(job: any) => boolean} [predicate] */
function matchJobReference(jobs, reference, predicate = () => true, options = {}) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  if (!JOB_REFERENCE_PATTERN.test(reference)) {
    throw new Error(
      `"${reference}" is not a valid job id. Run /grok:status to list known jobs.`
    );
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  if (options.allowMissing) return null;
  throw new Error(`No job found for "${reference}". Run /grok:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileOrphanedJobs(workspaceRoot);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter(isActiveJob)
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => !isActiveJob(job)) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => !isActiveJob(job) && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(options.env, workspaceRoot),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /grok:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentSessionId();
  if (!reference && !sessionId) {
    throw new Error("Pass a job id to /grok:result when no current session id is available.");
  }
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  if (!reference) {
    const finishedJobs = jobs.filter((job) => !isActiveJob(job) && (job.status === "completed" || job.status === "failed" || job.status === "cancelled"));
    if (finishedJobs.length > 1) {
      throw new Error("Multiple finished Grok jobs exist for this session. Pass the exact job id to /grok:result.");
    }
  }
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => !isActiveJob(job) && (job.status === "completed" || job.status === "failed" || job.status === "cancelled"),
    { allowMissing: true }
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, isActiveJob, { allowMissing: true });
  if (active) {
    if (active.terminationPending) {
      throw new Error(`Job ${active.id} still needs process termination. Retry /grok:cancel ${active.id}.`);
    }
    throw new Error(`Job ${active.id} is still ${active.status}. Check /grok:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /grok:status to inspect active jobs.`);
  }

  throw new Error("No finished Grok jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter(isActiveJob);

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const currentSessionId = getCurrentSessionId(options);
  if (!currentSessionId) {
    throw new Error("No active Grok jobs to cancel for a known session. Pass an exact job id.");
  }
  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Grok jobs are active. Pass a job id to /grok:cancel.");
  }

  throw new Error("No active Grok jobs to cancel for this session.");
}
