import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { getProcessSnapshot } from "./process.mjs";
import { assertDarwinPruneContext, createStateJobReader, readJobFile, resolveJobFile, resolveJobLogFile, updateState, withStateSnapshot, writeJobFile } from "./state.mjs";
import { validateOwnedDarwinWorkerLease } from "./darwin-worker-lease.mjs";
import { publishDarwinLeaseSlot, reserveDarwinLeaseSlot, sweepDarwinWorkerLeases, verifyPublishedDarwinLease } from "./darwin-lease-sweep.mjs";
import { publishLinuxLeaseSlot, reserveLinuxLeaseSlot, sweepLinuxWorkerLeases, verifyPublishedLinuxLease } from "./linux-lease-ledger.mjs";

export const SESSION_ID_ENV = "GROK_COMPANION_SESSION_ID";
export const CODEX_SESSION_ID_ENV = "CODEX_THREAD_ID";
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
// 公開後の lease は worker process の終了を証明する。出力後も FD を閉じず、
// process 終了時に OS が回収するまで owner を強参照する。長寿命 process が
// 複数 job を実行すると、その終了まで slot を占有する。
const LINUX_WORKER_OWNERS = new Set();

function pathHasEntry(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function boundedLinuxStateError(value) {
  const limit = 768;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") <= limit) return value;
  const suffix = "… [truncated; see stderr for the full diagnostic]";
  let budget = limit - Buffer.byteLength(JSON.stringify(suffix), "utf8"), prefix = "";
  for (const character of value) {
    const size = Buffer.byteLength(JSON.stringify(character), "utf8") - 2;
    if (size > budget) break;
    prefix += character;
    budget -= size;
  }
  return prefix + suffix;
}

/** agentの応答に依存せず、このworkerが所有するbroker接続だけを閉じる。 */
export function observeBrokerWorkerCancellation(workspaceRoot, jobId, control, options = {}) {
  const read = options.readCandidate ?? createStateJobReader(workspaceRoot, jobId).read;
  const pid = options.pid ?? process.pid;
  const initial = read();
  const startKey = initial.indexed?.processStartKey;
  const matches = current => current && current.id === jobId && current.pid === pid &&
    typeof startKey === "string" && startKey && current.processStartKey === startKey &&
    (process.platform !== "darwin" || (options.ownerToken?.epoch && current.epoch === options.ownerToken.epoch &&
      options.ownerToken.claimToken && current.claimToken === options.ownerToken.claimToken &&
      sameDarwinLease(current.workerLease, options.ownerToken.workerLease))) &&
    (process.platform !== "linux" || (options.ownerToken?.epoch && current.epoch === options.ownerToken.epoch &&
      options.ownerToken.claimToken && current.claimToken === options.ownerToken.claimToken &&
      sameLinuxLease(current.workerLease, options.ownerToken.workerLease))) &&
    current.grokTransport === "broker" && typeof control.brokerGeneration === "string" && control.brokerGeneration &&
    current.grokBrokerGeneration === control.brokerGeneration;
  if (![initial.indexed, initial.stored].every(matches)) throw new Error("Broker worker ownership could not be verified.");
  let disposed = false;
  let timer;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer) (options.clearInterval ?? clearInterval)(timer);
  };
  const check = () => {
    if (disposed) return;
    let candidate;
    try { candidate = read(); } catch { return; }
    const records = [candidate.indexed, candidate.stored];
    if (!records.every(matches) || !records.every(current => current.status === "cancelled" || current.terminationPending === true)) return;
    dispose();
    // closeはその接続のpending RPCだけを拒否し、共有agent停止の証拠にはしない。
    try { void Promise.resolve(control.close()).catch(() => {}); } catch { /* 通常closeとの競合でも再送しない。 */ }
  };
  timer = (options.setInterval ?? setInterval)(check, 100);
  timer.unref?.();
  check();
  return { dispose };
}

function normalizeSessionId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveCurrentSessionId(env = process.env, preferredEnv = SESSION_ID_ENV) {
  return (
    normalizeSessionId(env?.[preferredEnv]) ??
    (preferredEnv === SESSION_ID_ENV ? normalizeSessionId(env?.[CODEX_SESSION_ID_ENV]) : null)
  );
}

export function resolveSessionIdWithFallback(sessionId, env = process.env) {
  return normalizeSessionId(sessionId) ?? resolveCurrentSessionId(env);
}

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

// 同 UID の namespace 非変更を前提に、既存 log の外部 hardlink への追記を拒否する。
export function appendDarwinVerifiedLog(logFile, contents, { create = true } = {}) {
  const { O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (!Number.isInteger(O_NOFOLLOW) || O_NOFOLLOW <= 0 || !Number.isInteger(O_NONBLOCK) || O_NONBLOCK <= 0) {
    throw new Error("Darwin job log requires no-follow and nonblocking open support.");
  }
  const directory = fs.lstatSync(path.dirname(logFile), { bigint: true });
  const uid = BigInt(process.getuid());
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || directory.dev <= 0n) {
    throw new Error("Darwin job log directory identity is invalid.");
  }
  const valid = stat => stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && stat.dev === directory.dev &&
    stat.ino > 0n && stat.nlink === 1n && (stat.mode & 0o7177n) === 0n && (stat.mode & 0o600n) === 0o600n;
  let before;
  try { before = fs.lstatSync(logFile, { bigint: true }); }
  catch (error) { if (error?.code !== "ENOENT" || !create) throw error; }
  if (before && !valid(before)) throw new Error("Darwin job log identity or permissions are invalid.");
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | O_NOFOLLOW | O_NONBLOCK |
    (before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  const fd = fs.openSync(logFile, flags, 0o600);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(logFile, { bigint: true });
    const currentDirectory = fs.lstatSync(path.dirname(logFile), { bigint: true });
    if (!valid(opened) || !valid(named) || opened.dev !== named.dev || opened.ino !== named.ino ||
        (before && (before.dev !== opened.dev || before.ino !== opened.ino)) ||
        !currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() || currentDirectory.uid !== uid ||
        currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino) {
      throw new Error("Darwin job log identity changed or permissions are invalid.");
    }
    fs.writeFileSync(fd, contents, "utf8");
  } finally { fs.closeSync(fd); }
}

export function assertDarwinJobLogPath(context, jobId, logFile) {
  assertDarwinPruneContext(context);
  if (typeof jobId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(jobId) || Buffer.byteLength(jobId, "utf8") > 200) {
    throw new Error("Invalid state job identifier");
  }
  if (logFile != null && (typeof logFile !== "string" || logFile !== path.join(context.stateDir, "jobs", `${jobId}.log`))) {
    throw new Error(`Job ${jobId} log path is not the canonical job log.`);
  }
}

export function appendLogLine(logFile, message, { create = true } = {}) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  const line = `[${nowIso()}] ${normalized}\n`;
  if (process.platform === "darwin") appendDarwinVerifiedLog(logFile, line, { create });
  else fs.appendFileSync(logFile, line, { encoding: "utf8", mode: 0o600 });
}

export function appendLogBlock(logFile, title, body, { create = true } = {}) {
  if (!logFile || !body) {
    return;
  }
  const block = `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`;
  if (process.platform === "darwin") appendDarwinVerifiedLog(logFile, block, { create });
  else fs.appendFileSync(logFile, block, { encoding: "utf8", mode: 0o600 });
}

export function createProcessLookupDiagnostics(logFile) {
  // Darwin の process lookup は診断 callback を使わない。旧記録のパスを
  // mutex の外で書ける callback として公開しない。
  if (!logFile || process.platform === "darwin") return {};
  return {
    onProcessLookupDiagnostic(record) {
      appendLogLine(logFile, `Process lookup diagnostic ${JSON.stringify(record)}`);
    }
  };
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  return withStateSnapshot(workspaceRoot, (state, context) => {
    context.check();
    const logFile = resolveJobLogFile(workspaceRoot, jobId);
    if (state.jobs.some(job => job.id === jobId) || pathHasEntry(resolveJobFile(workspaceRoot, jobId))) {
      throw new Error(`Job ${jobId} already exists; its log was left untouched.`);
    }
    fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (title) appendLogLine(logFile, `Starting ${title}.`, { create: process.platform !== "darwin" });
    context.check();
    return logFile;
  });
}

// Darwin は published reservation を両記録に確定してから専用 log を作る。
export function createReservedDarwinJobLog(job, logFile, reservation) {
  if (process.platform !== "darwin" || !reservation) throw new Error("Darwin log reservation is unavailable");
  return withStateSnapshot(job.workspaceRoot, (state, context) => {
    assertDarwinJobLogPath(context, job.id, logFile);
    const indexed = state.jobs.find(current => current.id === job.id);
    const stored = readStoredJobOrNull(job.workspaceRoot, job.id);
    const owner = { epoch: context.epoch, claimToken: reservation.claimToken,
      workerLease: reservation.lease, leaseFd: reservation.fd };
    if (![indexed, stored].every(current => current && current.status === "queued" && current.terminationPending !== true &&
        current.createdAt === reservation.createdAt && current.logFile === logFile)) {
      throw new Error(`Job ${job.id} log reservation changed; no log was created.`);
    }
    verifyPublishedDarwinLease({ context, indexed, stored, owner });
    context.check();
    fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (job.title) appendLogLine(logFile, `Starting ${job.title}.`, { create: false });
    context.check();
    return logFile;
  });
}

export function createReservedLinuxJobLog(job, logFile, reservation) {
  if (process.platform !== "linux" || !reservation) throw new Error("Linux log reservation is unavailable");
  return withStateSnapshot(job.workspaceRoot, (state, context) => {
    const indexed = state.jobs.find(current => current.id === job.id);
    const stored = readStoredJobOrNull(job.workspaceRoot, job.id);
    if (![indexed, stored].every(current => current && current.status === "queued" && current.terminationPending !== true &&
        current.createdAt === reservation.createdAt && current.logFile === logFile)) throw new Error(`Job ${job.id} log reservation changed; no log was created.`);
    verifyPublishedLinuxLease({ context, indexed, stored, owner: reservation.owner, lease: reservation.lease, claimToken: reservation.claimToken });
    context.check();
    fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (job.title) appendLogLine(logFile, `Starting ${job.title}.`);
    context.check();
    return logFile;
  });
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = resolveCurrentSessionId(env, options.sessionIdEnv ?? SESSION_ID_ENV);
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId, ownerToken = null, logFile = null) {
  let lastPhase = null;
  let lastThreadId = null;

  const update = (event, afterSave = null) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      if (process.platform !== "linux" && process.platform !== "darwin") lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.grokSessionId && normalized.grokSessionId !== lastThreadId) {
      if (process.platform !== "linux" && process.platform !== "darwin") lastThreadId = normalized.grokSessionId;
      patch.grokSessionId = normalized.grokSessionId;
      changed = true;
    }

    const owner = typeof ownerToken === "function" ? ownerToken() : ownerToken;
    if (!changed) {
      if ((process.platform !== "linux" && process.platform !== "darwin") || !afterSave) return;
      withStateSnapshot(workspaceRoot, (state, context) => {
        const indexed = state.jobs.find(candidate => candidate.id === jobId);
        const stored = readStoredJobOrNull(workspaceRoot, jobId);
        if (process.platform === "darwin" && !verifyDarwinTrackedOwner(indexed, stored, jobId, owner, context)) return;
        if (process.platform === "darwin") {
          assertDarwinJobLogPath(context, jobId, logFile);
          if (![indexed, stored].every(record => (record.logFile ?? null) === logFile)) throw new Error(`Job ${jobId} log reference changed.`);
        }
        if (process.platform === "linux" && !verifyLinuxTrackedOwner(indexed, stored, jobId, owner, context)) return;
        if (!owner?.epoch || !owner?.startKey || !Number.isInteger(owner?.pid) || owner.pid <= 0 ||
            context.epoch !== owner.epoch || ![indexed, stored].every(record => record && record.id === jobId &&
              record.epoch === owner.epoch && record.pid === owner.pid && record.processStartKey === owner.startKey &&
              !TERMINAL_STATUSES.has(record.status) && record.terminationPending !== true) || indexed.status !== stored.status) return;
        if ((indexed.phase ?? null) !== (stored.phase ?? null) || (indexed.grokSessionId ?? null) !== (stored.grokSessionId ?? null) ||
            (normalized.phase && indexed.phase !== normalized.phase) ||
            (normalized.grokSessionId && indexed.grokSessionId !== normalized.grokSessionId)) {
          throw new Error(`Job ${jobId} progress records are inconsistent.`);
        }
        context.check();
        afterSave();
      });
      return;
    }
    const result = commitNonTerminalTransition(workspaceRoot, jobId, (current) => ({ ...current, ...patch }), { ownerToken: owner, afterSave, logFile });
    if (result.accepted) {
      if (normalized.phase) lastPhase = normalized.phase;
      if (normalized.grokSessionId) lastThreadId = normalized.grokSessionId;
    }
  };
  update.handlesOwnedLog = true;
  return update;
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    const writeLog = () => {
      if (stderr && stderrMessage) process.stderr.write(`[grok] ${stderrMessage}\n`);
      const create = process.platform !== "darwin" || !onEvent?.handlesOwnedLog;
      appendLogLine(logFile, event.message, { create });
      appendLogBlock(logFile, event.logTitle, event.logBody, { create });
    };
    if ((process.platform === "linux" || process.platform === "darwin") && onEvent?.handlesOwnedLog) onEvent(event, writeLog);
    else {
      writeLog();
      onEvent?.(event);
    }
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!pathHasEntry(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export function darwinLeaseDirectory(context, create = false) {
  const root = fs.realpathSync.native(context.stateDir);
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      String(rootStat.dev) !== context.directoryIdentity.dev || String(rootStat.ino) !== context.directoryIdentity.ino) {
    throw new Error("Darwin worker lease state directory changed.");
  }
  const directory = path.join(root, "worker-leases");
  if (create) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid()) ||
      (stat.mode & 0o077n) !== 0n || stat.dev !== rootStat.dev || stat.ino <= 0n) {
    throw new Error("Darwin worker lease directory identity is invalid.");
  }
  context.check();
  return { expectedDirectory: directory, expectedDirectoryIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
    stateGeneration: context.stateGeneration };
}

export function sameDarwinLease(left, right) {
  return Boolean(left && right && ["id", "slot", "path", "dev", "ino", "stateGeneration", "directoryDev", "directoryIno"].every(key => left[key] === right[key]));
}

export function sameLinuxLease(left, right) {
  return Boolean(left && right && ["id", "slot", "path", "dev", "ino", "stateGeneration"].every(key => left[key] === right[key]));
}

export function verifyLinuxTrackedOwner(indexed, stored, jobId, owner, context) {
  if (!owner?.epoch || !owner?.startKey || !owner?.claimToken || !owner?.workerLease || !owner?.leaseOwner ||
      !Number.isInteger(owner?.pid) || owner.pid <= 0 || context.epoch !== owner.epoch ||
      ![indexed, stored].every(record => record && record.id === jobId && record.epoch === owner.epoch &&
        record.pid === owner.pid && record.processStartKey === owner.startKey && record.createdAt === owner.createdAt &&
        record.claimToken === owner.claimToken && sameLinuxLease(record.workerLease, owner.workerLease))) return false;
  verifyPublishedLinuxLease({ context, indexed, stored, owner: owner.leaseOwner, lease: owner.workerLease, claimToken: owner.claimToken });
  return true;
}

export function verifyDarwinTrackedOwner(indexed, stored, jobId, owner, context) {
  if (!owner?.epoch || !owner?.startKey || !owner?.claimToken || !owner?.workerLease ||
      !Number.isSafeInteger(owner?.leaseFd) || !Number.isInteger(owner?.pid) || owner.pid <= 0 ||
      context.stateGeneration !== owner.epoch || ![indexed, stored].every(record => record && record.id === jobId &&
        record.epoch === owner.epoch && record.pid === owner.pid && record.processStartKey === owner.startKey &&
        record.createdAt === owner.createdAt && record.claimToken === owner.claimToken && sameDarwinLease(record.workerLease, owner.workerLease))) return false;
  const current = darwinLeaseDirectory(context);
  if (current.expectedDirectoryIdentity.dev !== owner.workerLease.directoryDev ||
      current.expectedDirectoryIdentity.ino !== owner.workerLease.directoryIno) return false;
  validateOwnedDarwinWorkerLease({ ...current, fd: owner.leaseFd, lease: owner.workerLease });
  verifyPublishedDarwinLease({ context, indexed, stored, owner });
  return true;
}

/** ID を提示する前に、worker の lease と queued 予約を両保存先へ登録する。 */
export function reserveDarwinTrackedJob(job, options = {}) {
  if (process.platform !== "darwin") throw new Error("Darwin worker reservation is only supported on macOS.");
  if (job.grokPromptState !== undefined && job.grokPromptState !== "not-sent") {
    throw new Error(`Job ${job.id} has an invalid initial prompt state.`);
  }
  const claimToken = randomUUID();
  const createdAt = job.createdAt ?? nowIso();
  const reserve = () => {
    let acquired;
    try {
    updateState(job.workspaceRoot, (state, context) => {
      if (!acquired) throw new Error(`Job ${job.id} has no worker lease reservation.`);
      assertDarwinJobLogPath(context, job.id, options.logFile ?? job.logFile ?? null);
      const queued = { ...job, createdAt, status: "queued", phase: "queued", pid: null, processStartKey: null,
        grokPromptState: "not-sent", logFile: options.logFile ?? job.logFile ?? null,
        epoch: context.stateGeneration, workerLease: acquired.lease, claimToken };
      context.check();
      writeJobFile(job.workspaceRoot, job.id, queued);
      state.jobs.unshift({ ...queued, updatedAt: nowIso() });
    }, { aroundCommit(state, context, commit) {
      const existing = state.jobs.find(entry => entry.id === job.id);
      if (existing || pathHasEntry(resolveJobFile(job.workspaceRoot, job.id))) {
        const stored = readStoredJobOrNull(job.workspaceRoot, job.id);
        throw new Error(`Job ${job.id} is already ${stored?.status ?? existing?.status ?? "registered"}; the worker will not start.`);
      }
      acquired = reserveDarwinLeaseSlot({ context, jobId: job.id, claimToken, createdAt });
      const saved = commit();
      publishDarwinLeaseSlot({ context, slot: acquired.slot, claimToken, lease: acquired.lease, fd: acquired.fd, jobId: job.id });
      return saved;
    } });
      return { ...acquired, claimToken, createdAt };
    } catch (error) {
      if (acquired) fs.closeSync(acquired.fd);
      throw error;
    }
  };
  try { return reserve(); }
  catch (error) {
    if (error?.code !== "GROK_DARWIN_LEASE_CAPACITY") throw error;
    // 満杯時だけ mutex を解放して bounded sweep し、一度だけ再予約する。
    sweepDarwinWorkerLeases(job.workspaceRoot, { maxEntries: 16, timeoutMs: 5000, stopAfterReclaim: true });
    return reserve();
  }
}

export function reserveLinuxTrackedJob(job, options = {}) {
  if (process.platform !== "linux") throw new Error("Linux worker reservation is only supported on Linux.");
  if (job.grokPromptState !== undefined && job.grokPromptState !== "not-sent") throw new Error(`Job ${job.id} has an invalid initial prompt state.`);
  const claimToken = randomUUID(), createdAt = job.createdAt ?? nowIso();
  const reserve = () => {
    let acquired, queuedRecord;
    try {
      updateState(job.workspaceRoot, (state, context) => {
        if (!acquired || !queuedRecord) throw new Error(`Job ${job.id} has no worker lease reservation.`);
        const queued = { ...queuedRecord, workerLease: acquired.lease };
        context.check();
        writeJobFile(job.workspaceRoot, job.id, queued);
        state.jobs.unshift({ ...queued, updatedAt: nowIso() });
      }, { aroundCommit(state, context, commit) {
        // ledger の読取上限に達した後、予約だけを残して publish が失敗しないよう、
        // 同一 mutex 内で全 record の保存前に拒否する。
        if (!Array.isArray(state.jobs) || state.jobs.length >= 4096) throw new Error("Linux job history is full; records were preserved and offline recovery is required.");
        const existing = state.jobs.find(entry => entry.id === job.id);
        if (existing || pathHasEntry(resolveJobFile(job.workspaceRoot, job.id))) throw new Error(`Job ${job.id} is already registered; the worker will not start.`);
        queuedRecord = { ...job, createdAt, status: "queued", phase: "queued", pid: null, processStartKey: null,
          grokPromptState: "not-sent", logFile: options.logFile ?? job.logFile ?? null, epoch: context.epoch, claimToken };
        delete queuedRecord.workerLease;
        acquired = reserveLinuxLeaseSlot({ context, jobId: job.id, claimToken, createdAt, queuedRecord });
        LINUX_WORKER_OWNERS.add(acquired.owner);
        const saved = commit();
        publishLinuxLeaseSlot({ context, jobId: job.id, claimToken, lease: acquired.lease, owner: acquired.owner });
        return saved;
      } });
      return { ...acquired, claimToken, createdAt };
    } catch (error) { throw error; }
  };
  try { return reserve(); }
  catch (error) {
    if (error?.code !== "GROK_LINUX_LEASE_CAPACITY") throw error;
    sweepLinuxWorkerLeases(job.workspaceRoot, { maxEntries: 16, timeoutMs: 5000, stopAfterReclaim: true });
    return reserve();
  }
}

function commitNonTerminalTransition(workspaceRoot, jobId, buildNext, { claim = false, reservation = null, ownerToken = null, afterSave = null, logFile = null } = {}) {
  let accepted = false;
  let nextRecord = null;
  const rejectedEpoch = {};
  try { updateState(workspaceRoot, (state, context) => {
    const index = state.jobs.findIndex((candidate) => candidate.id === jobId);
    const indexed = index === -1 ? null : state.jobs[index];
    const stored = readStoredJobOrNull(workspaceRoot, jobId);
    if (claim && process.platform === "linux") {
      if (!reservation?.claimToken || !reservation?.lease || !reservation?.owner || reservation.lease.stateGeneration !== context.epoch ||
          ![indexed, stored].every(record => record && record.id === jobId && record.status === "queued" &&
            record.terminationPending !== true && record.pid == null && record.processStartKey == null &&
            record.createdAt === reservation.createdAt && record.epoch === context.epoch &&
            record.claimToken === reservation.claimToken && sameLinuxLease(record.workerLease, reservation.lease))) throw rejectedEpoch;
      verifyPublishedLinuxLease({ context, indexed, stored, owner: reservation.owner, lease: reservation.lease, claimToken: reservation.claimToken });
    } else if (claim && process.platform === "darwin") {
      const current = darwinLeaseDirectory(context);
      if (!reservation?.claimToken || !reservation?.lease || current.stateGeneration !== reservation.lease.stateGeneration ||
          current.expectedDirectoryIdentity.dev !== reservation.lease.directoryDev || current.expectedDirectoryIdentity.ino !== reservation.lease.directoryIno ||
          ![indexed, stored].every(record => record && record.id === jobId && record.status === "queued" &&
            record.terminationPending !== true && record.pid == null && record.processStartKey == null &&
            record.createdAt === reservation.createdAt && record.epoch === current.stateGeneration &&
            record.claimToken === reservation.claimToken && sameDarwinLease(record.workerLease, reservation.lease))) throw rejectedEpoch;
      validateOwnedDarwinWorkerLease({ ...current, fd: reservation.fd, lease: reservation.lease });
      verifyPublishedDarwinLease({ context, indexed, stored, owner: { epoch: context.epoch,
        claimToken: reservation.claimToken, workerLease: reservation.lease, leaseFd: reservation.fd } });
    } else if (claim && (indexed || pathHasEntry(resolveJobFile(workspaceRoot, jobId)))) throw rejectedEpoch;
    if (!claim && process.platform === "linux" && (!ownerToken?.epoch || !ownerToken?.startKey ||
        !Number.isInteger(ownerToken?.pid) || ownerToken.pid <= 0 || context.epoch !== ownerToken.epoch ||
        ![indexed, stored].every(record => record && record.id === jobId && record.epoch === ownerToken.epoch &&
          record.pid === ownerToken.pid && record.processStartKey === ownerToken.startKey))) throw rejectedEpoch;
    if (!claim && process.platform === "linux" && !verifyLinuxTrackedOwner(indexed, stored, jobId, ownerToken, context)) throw rejectedEpoch;
    if (!claim && process.platform === "darwin" && !verifyDarwinTrackedOwner(indexed, stored, jobId, ownerToken, context)) throw rejectedEpoch;
    if (!claim && (process.platform === "linux" || process.platform === "darwin") && (indexed.status !== stored.status ||
        [indexed, stored].some(record => TERMINAL_STATUSES.has(record.status) || record.terminationPending === true))) throw rejectedEpoch;
    const current = { ...(indexed ?? {}), ...(stored ?? {}) };
    if (TERMINAL_STATUSES.has(current.status) || current.terminationPending === true) {
      return;
    }

    nextRecord = buildNext(current);
    if (process.platform === "linux" || process.platform === "darwin") nextRecord = { ...nextRecord, epoch: context.epoch };
    context.check();
    writeJobFile(workspaceRoot, jobId, nextRecord);
    const timestamp = nowIso();
    const { result: _result, rendered: _rendered, request: _request, ...summaryRecord } = nextRecord;
    const indexedRecord = { ...summaryRecord, updatedAt: timestamp };
    if (index === -1) state.jobs.unshift(indexedRecord);
    else state.jobs[index] = { ...indexed, ...indexedRecord };
    accepted = true;
  }, (process.platform === "linux" || process.platform === "darwin") && afterSave ? { afterSave: (state, context) => {
    if (!accepted) return;
    const indexed = state.jobs.find(candidate => candidate.id === jobId);
    // 履歴上限で除去されたら、保存後にログを再作成しない。
    if (!indexed) return;
    const stored = readStoredJobOrNull(workspaceRoot, jobId);
    const fields = ["id", "epoch", "createdAt", "startedAt", "pid", "processStartKey", "status", "logFile"];
    if (![indexed, stored].every(record => record && fields.every(key => record[key] === nextRecord[key])) ||
        context.epoch !== ownerToken?.epoch || nextRecord.epoch !== ownerToken?.epoch ||
        nextRecord.processStartKey !== ownerToken?.startKey) {
      throw new Error(`Job ${jobId} changed before its log was written.`);
    }
    if (process.platform === "darwin") {
      assertDarwinJobLogPath(context, jobId, logFile);
      if (![indexed, stored].every(record => (record.logFile ?? null) === logFile)) throw new Error(`Job ${jobId} log reference changed.`);
      if (![indexed, stored].every(record => record.claimToken === ownerToken?.claimToken && sameDarwinLease(record.workerLease, ownerToken?.workerLease))) {
        throw new Error(`Job ${jobId} worker lease changed before its log was written.`);
      }
      const leaseContext = darwinLeaseDirectory(context);
      if (leaseContext.expectedDirectoryIdentity.dev !== ownerToken.workerLease.directoryDev ||
          leaseContext.expectedDirectoryIdentity.ino !== ownerToken.workerLease.directoryIno) throw new Error(`Job ${jobId} worker lease directory changed.`);
      validateOwnedDarwinWorkerLease({ ...leaseContext, fd: ownerToken.leaseFd, lease: ownerToken.workerLease });
      verifyPublishedDarwinLease({ context, indexed, stored, owner: ownerToken });
    }
    if (process.platform === "linux") {
      if (![indexed, stored].every(record => record.claimToken === ownerToken?.claimToken && sameLinuxLease(record.workerLease, ownerToken?.workerLease))) {
        throw new Error(`Job ${jobId} worker lease changed before its log was written.`);
      }
      verifyPublishedLinuxLease({ context, indexed, stored, owner: ownerToken.leaseOwner, lease: ownerToken.workerLease, claimToken: ownerToken.claimToken });
    }
    context.check();
    return afterSave();
  } } : undefined); } catch (error) {
    if (error !== rejectedEpoch) throw error;
  }
  return { accepted, record: nextRecord };
}

export async function runTrackedJob(job, runner, options = {}) {
  const reservation = process.platform === "darwin" ? options.reservation ?? reserveDarwinTrackedJob(job, options)
    : process.platform === "linux" ? options.reservation ?? reserveLinuxTrackedJob(job, options) : null;
  if (process.platform === "linux" && reservation) LINUX_WORKER_OWNERS.add(reservation.owner);
  return await runTrackedJobWithReservation(job, runner, options, reservation);
}

async function runTrackedJobWithReservation(job, runner, options, reservation) {
  // Windows のプロセス照会が一時的に失敗しても起動できるようにする。
  // 停止対象の同一性を確認できるまで、ジョブを登録せず短時間だけ再試行する。
  const readSnapshot = options.getProcessSnapshotImpl ?? getProcessSnapshot;
  let processStartKey = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    processStartKey = readSnapshot(process.pid, createProcessLookupDiagnostics(options.logFile ?? job.logFile))?.startKey;
    if (processStartKey) break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!processStartKey) {
    throw new Error("Cannot verify the Grok job process identity for cancellation.");
  }
  const runningRecord = {
    ...job,
    ...(reservation ? { createdAt: reservation.createdAt, workerLease: reservation.lease, claimToken: reservation.claimToken } : {}),
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    processStartKey,
    logFile: options.logFile ?? job.logFile ?? null
  };
  const claim = commitNonTerminalTransition(job.workspaceRoot, job.id, () => runningRecord, { claim: true, reservation });
  if (!claim.accepted) {
    const stored = readStoredJobOrNull(job.workspaceRoot, job.id);
    throw new Error(`Job ${job.id} is already ${stored?.status ?? "registered or unavailable"}; the worker will not start.`);
  }
  const ownerToken = { epoch: claim.record.epoch ?? null, pid: runningRecord.pid, startKey: runningRecord.processStartKey,
    ...(reservation ? { claimToken: reservation.claimToken, workerLease: reservation.lease, leaseFd: reservation.fd,
      leaseOwner: reservation.owner, createdAt: reservation.createdAt } : {}) };

  try {
    const execution = await runner(ownerToken);
    // exitStatus はランタイムの status 文字列（"completed" / "failed" ほか）。
    // 本家 Codex 版は数値の終了コードだったので `=== 0` で比較していたが、
    // そのままだと全ジョブが failed として記録されてしまう。
    const completionStatus = execution.exitStatus === "completed" ? "completed" : "failed";
    const completedAt = nowIso();
    const completion = commitNonTerminalTransition(job.workspaceRoot, job.id, (current) => {
      const stopUnconfirmed = execution.turnStopUnconfirmed === true || current.grokPromptState === "starting";
      return {
        ...current,
        status: completionStatus,
        terminationPending: stopUnconfirmed,
        grokPromptState: stopUnconfirmed ? "pending" : "terminal",
        grokSessionId: execution.grokSessionId ?? null,
        ...(current.jobClass === "task" ? { taskSessionResumable: !stopUnconfirmed && Boolean(execution.grokSessionId) } : {}),
        pid: null,
        phase: stopUnconfirmed ? "termination-pending" : completionStatus === "completed" ? "done" : "failed",
        completedAt,
        result: execution.payload,
        rendered: execution.rendered,
        summary: execution.summary
      };
    }, { ownerToken, ...(process.platform === "linux" || process.platform === "darwin" ? {
      logFile: options.logFile ?? job.logFile ?? null,
      afterSave: () => appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered, { create: false })
    } : {}) });
    if (!completion.accepted) {
      throw new Error(`Job ${job.id} was cancelled or became terminal or termination pending before completion; its output was not committed.`);
    }
    if (process.platform !== "linux" && process.platform !== "darwin") appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const fullErrorMessage = error instanceof Error ? error.message : String(error);
    const errorMessage = process.platform === "linux" ? boundedLinuxStateError(fullErrorMessage) : fullErrorMessage;
    let existing;
    try { existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord; }
    catch (readError) {
      if (process.platform !== "linux" && process.platform !== "darwin") throw readError;
      /** @type {AggregateError & { turnStopUnconfirmed?: boolean }} */
      const combined = new AggregateError([error, readError], `Job ${job.id} failed: ${fullErrorMessage}; its record could not be read.`, { cause: error });
      if (error?.turnStopUnconfirmed === true) combined.turnStopUnconfirmed = true;
      throw combined;
    }
    const diagnostic = error instanceof Error
      ? [
          error.stack,
          error.cause ? `Cause: ${String(error.cause)}` : null,
          "code" in error && error.code ? `Code: ${String(error.code)}` : null
        ]
          .filter(Boolean)
          .join("\n")
      : String(error);
    if (process.platform !== "linux" && process.platform !== "darwin") appendLogBlock(options.logFile ?? job.logFile ?? existing.logFile ?? null, "Failure diagnostic", diagnostic);
    const completedAt = nowIso();
    let failure;
    try { failure = commitNonTerminalTransition(job.workspaceRoot, job.id, (current) => ({
      ...current,
      status: "failed",
      phase: error?.turnStopUnconfirmed === true || ["starting", "pending"].includes(current.grokPromptState) ? "termination-pending" : "failed",
      terminationPending: error?.turnStopUnconfirmed === true || ["starting", "pending"].includes(current.grokPromptState),
      ...(error?.turnStopUnconfirmed === true ? { grokPromptState: "pending" } : {}),
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    }), { ownerToken, ...(process.platform === "linux" || process.platform === "darwin" ? {
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null,
      afterSave: () => appendLogBlock(options.logFile ?? job.logFile ?? existing.logFile ?? null, "Failure diagnostic", diagnostic, { create: false })
    } : {}) }); } catch (failureError) {
      if (process.platform === "linux" || process.platform === "darwin") {
        throw new AggregateError([error, failureError], `Job ${job.id} failed: ${fullErrorMessage}; failure state or log could not be saved.`, { cause: error });
      }
      throw failureError;
    }
    if (!failure.accepted && existing.status === "cancelled") {
      throw error;
    }
    throw error;
  }
}
