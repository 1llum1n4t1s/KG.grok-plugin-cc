import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "grok-companion");
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_FILE_NAME = "state.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const MAX_REVIEW_GATE_SESSIONS = 50;
/** ロックを持ったまま落ちたプロセスの置き土産を無効にするまでの時間。 */
const STATE_LOCK_STALE_MS = 10000;
const STATE_LOCK_RETRY_LIMIT = 50;
const STATE_LOCK_RETRY_INTERVAL_MS = 10;
/** 同期関数の中で待つための待避先。state 更新は同期 API で書かれている。 */
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: [],
    reviewGateSessions: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(resolveStateDir(cwd), 0o700);
    fs.chmodSync(resolveJobsDir(cwd), 0o700);
  } catch {
    // Windows では POSIX mode が実質無効。作成自体が成功していれば続行する。
  }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      reviewGateSessions: pruneReviewGateSessions(parsed.reviewGateSessions)
    };
  } catch (error) {
    throw new Error(`Grok state is corrupt and was left untouched: ${stateFile}`, { cause: error });
  }
}

function writeJsonAtomic(filePath, payload) {
  const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Windows では POSIX mode が実質無効。
    }
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function pruneReviewGateSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : [])
    .filter((entry) => typeof entry?.sessionId === "string" && entry.sessionId.trim())
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_REVIEW_GATE_SESSIONS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs,
    reviewGateSessions: pruneReviewGateSessions(state.reviewGateSessions)
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeJsonAtomic(resolveStateFile(cwd), nextState);
  return nextState;
}

function resolveStateLockFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_LOCK_FILE_NAME);
}

/**
 * state.json 更新の排他ロック。
 *
 * この state は前景コマンド・detached なタスクワーカー・`/grok:cancel` の
 * 3 種類のプロセスから同時に触られる。ロック無しで read-modify-write すると
 * 後から書いた側が相手の更新を丸ごと消し、止めたはずのジョブが
 * running のまま残ったり、進行中ジョブのログが消えたりする。
 *
 * ロックが取れない場合は fail closed にする。競合した read-modify-write で
 * cancel や完了記録を消すより、呼び出し元へ再試行可能な失敗を返す。
 */
function withStateLock(cwd, run) {
  ensureStateDir(cwd);
  const lockFile = resolveStateLockFile(cwd);
  let held = false;

  for (let attempt = 0; attempt < STATE_LOCK_RETRY_LIMIT && !held; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
      held = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        break;
      }
    }

    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > STATE_LOCK_STALE_MS) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
    } catch {
      continue;
    }

    Atomics.wait(SLEEP_SIGNAL, 0, 0, STATE_LOCK_RETRY_INTERVAL_MS);
  }

  if (!held) {
    throw new Error(`Timed out acquiring Grok state lock: ${lockFile}`);
  }

  try {
    return run();
  } finally {
    if (held) {
      try {
        fs.rmSync(lockFile, { force: true });
      } catch {
        // 後始末の失敗は更新の成否に影響しない。
      }
    }
  }
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function getReviewGateSession(cwd, sessionId) {
  if (!sessionId) {
    return null;
  }
  return loadState(cwd).reviewGateSessions.find((entry) => entry.sessionId === sessionId) ?? null;
}

export function setReviewGateSession(cwd, sessionId, value) {
  if (!sessionId) {
    return null;
  }
  return updateState(cwd, (state) => {
    const existing = state.reviewGateSessions.find((entry) => entry.sessionId === sessionId) ?? {};
    state.reviewGateSessions = state.reviewGateSessions.filter((entry) => entry.sessionId !== sessionId);
    state.reviewGateSessions.unshift({
      ...existing,
      ...value,
      sessionId,
      updatedAt: nowIso()
    });
  });
}

export function clearReviewGateSession(cwd, sessionId) {
  if (!sessionId) {
    return null;
  }
  return updateState(cwd, (state) => {
    state.reviewGateSessions = state.reviewGateSessions.filter((entry) => entry.sessionId !== sessionId);
  });
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeJsonAtomic(jobFile, payload);
  return jobFile;
}

/**
 * ジョブ JSON を読む。
 *
 * 書き込みは atomic rename だが、旧版や外部破損の診断性を保つため、
 * 読めないファイルを「存在しない」と偽らず明示エラーにする。
 */
export function readJobFile(jobFile) {
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch (error) {
    throw new Error(`Grok job record is corrupt: ${jobFile}`, { cause: error });
  }
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
