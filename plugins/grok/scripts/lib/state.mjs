import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { types } from "node:util";
import { inspectPosixStateLockScope, migratePosixStateLock, readPosixStateLockProtocol, withPosixStateLock } from "./posix-state-lock.mjs";
import { getProtectedDarwinJobIds, initializeDarwinLeaseLedger } from "./darwin-lease-sweep.mjs";
import { fdMountId } from "./linux-epoch-recovery.mjs";
import { initializeLinuxLeaseLedger } from "./linux-lease-ledger.mjs";
import { acquireDarwinMigrationGuard, assertDarwinLegacyGuardContext, assertDarwinLegacyLockBackup, prepareDarwinLegacyLockBackup,
  publishDarwinMigrationCompletion, readDarwinLegacyTransition, releaseDarwinLegacyLockName, verifyDarwinMigrationCompletion,
  writeDarwinMigrationManifest } from "./darwin-legacy-lock-migration.mjs";
import { verifyDarwinMigrationInventory as verifyDarwinAdmissionInventory } from "./darwin-migration-inventory.mjs";

import { isActiveJob } from "./job-status.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "grok-companion");
export function stateFallbackTempDir() { return path.dirname(FALLBACK_STATE_ROOT_DIR); }
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_FILE_NAME = "state.lock";
const NATIVE_STATE_LOCK_PROTOCOL = "native-local-v2";
const STATE_LOCK_PROTOCOL_FILE_NAME = "protocol.json";
// 同期callbackの間だけ再利用する。別transactionへfilesystem検証を持ち越さない。
const HELD_STATE_LOCK_SCOPES = new Map();
const DARWIN_STATE_CAPABILITIES = new WeakSet();
const DARWIN_LEGACY_PREFLIGHTS = new WeakMap();
const DARWIN_LEGACY_OFFLINE_AUTHORIZATIONS = new WeakMap();
// 移行の固定 finalize が guard と実 native mutex を保持している間だけ使用する。
// 通常 state context をこの能力へ昇格させない。
const DARWIN_MIGRATION_STATE_CONTEXTS = new WeakMap();
export function assertDarwinMigrationStateContext(context, guardContext, deadline = Infinity) {
  const check = context && DARWIN_MIGRATION_STATE_CONTEXTS.get(context);
  if (!check) throw new Error("Darwin migration state mutex capability is unavailable");
  check(guardContext, deadline);
  return true;
}
export function assertDarwinLegacyOfflineAuthorization(authorization, guardContext, preflightToken, deadline = Infinity) {
  const entry = authorization && DARWIN_LEGACY_OFFLINE_AUTHORIZATIONS.get(authorization);
  if (!entry || entry.guardContext !== guardContext || entry.preflightToken !== preflightToken) {
    throw new Error("Darwin legacy offline authorization capability is unavailable");
  }
  assertDarwinLegacyPreflightToken(preflightToken, guardContext, deadline);
  if (entry.stateDir !== guardContext.stateDir) throw new Error("Darwin legacy offline authorization scope changed");
  return true;
}
export function assertDarwinLegacyPreflightToken(token, guardContext, deadline = Infinity) {
  const entry = token && DARWIN_LEGACY_PREFLIGHTS.get(token);
  if (!entry || entry.guardContext !== guardContext) throw new Error("Darwin legacy preflight token capability is invalid");
  assertDarwinLegacyGuardContext(guardContext, deadline);
  if (entry.stateDir !== guardContext.stateDir) throw new Error("Darwin legacy preflight token state directory changed");
  return entry.oldLock;
}
const LINUX_HISTORY_CAPABILITIES = new WeakSet();
const LINUX_HISTORY_TRANSACTION_PHASES = new WeakSet();
export function assertLinuxHistoryTransactionContext(context) {
  assertLinuxHistoryContext(context);
  if (!LINUX_HISTORY_TRANSACTION_PHASES.has(context)) throw new Error("Linux history internal transaction phase is unavailable");
}
export function assertLinuxHistoryContext(context) {
  if (process.platform !== "linux" || !context || !LINUX_HISTORY_CAPABILITIES.has(context) ||
      context.protocol !== "posix-linux-worker-lease-v6" || !Number.isInteger(context.rootFd) || !context.expectedDirectoryIdentity ||
      !context.expectedHistoryJournalIdentity) {
    throw new Error("Linux v6 state mutex capability is unavailable");
  }
  context.check();
}
const DARWIN_MIGRATION_AUTHORIZATIONS = new WeakMap();
export function assertDarwinMigrationAuthorization(authorization, stateDir, prepare) {
  const entry = authorization && DARWIN_MIGRATION_AUTHORIZATIONS.get(authorization);
  if (process.platform !== "darwin" || !entry || entry.stateDir !== stateDir || entry.prepare !== prepare) {
    throw new Error("Darwin migration requires a verified offline state migration capability");
  }
  if (entry.guardContext) assertDarwinLegacyGuardContext(entry.guardContext);
  return entry.guardContext ?? null;
}
export function assertDarwinPruneContext(context) {
  if (process.platform !== "darwin" || !context || !DARWIN_STATE_CAPABILITIES.has(context) || context.protocol !== "posix-local-v4") {
    throw new Error("Darwin v4 state mutex capability is unavailable");
  }
  context.check();
}
const JOBS_DIR_NAME = "jobs";
const MAX_DARWIN_RECORD_BYTES = 64 * 1024 * 1024;
function validDarwinRecordStat(stat) {
  return typeof process.getuid === "function" && stat.isFile() && !stat.isSymbolicLink() &&
    stat.uid === BigInt(process.getuid()) && (stat.mode & 0o077n) === 0n && stat.nlink === 1n &&
    stat.size <= BigInt(MAX_DARWIN_RECORD_BYTES);
}
const LINUX_RECORD_LIMIT = 64 * 1024 * 1024;
const LINUX_DIR_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const LINUX_READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
function linuxAt(fd, name) { return `/proc/self/fd/${fd}/${name}`; }
function linuxIdentity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function linuxSame(left, right) { return Boolean(left && right && left.dev === right.dev && left.ino === right.ino); }
function linuxChecked(stat, directory) {
  if (typeof process.getuid !== "function" || stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) ||
      stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n || stat.dev <= 0n || stat.ino <= 0n ||
      (!directory && (stat.nlink !== 1n || stat.size > BigInt(LINUX_RECORD_LIMIT)))) throw new Error("Linux state record identity or permissions are invalid");
  return linuxIdentity(stat);
}
function withLinuxRoot(stateDir, run) {
  const held = HELD_STATE_LOCK_SCOPES.get(stateDir);
  const before = linuxChecked(fs.lstatSync(stateDir, { bigint: true }), true);
  const fd = held?.linuxDirs?.stateFd ?? fs.openSync(stateDir, LINUX_DIR_FLAGS);
  const own = !held?.linuxDirs;
  try {
    const mount = fdMountId(fd);
    const check = () => {
      if (!linuxSame(before, linuxChecked(fs.fstatSync(fd, { bigint: true }), true)) ||
          !linuxSame(before, linuxChecked(fs.lstatSync(stateDir, { bigint: true }), true)) || fdMountId(fd) !== mount ||
          (held?.linuxDirs && mount !== held.linuxDirs.mount)) throw new Error("Linux state root changed or crosses a mount boundary");
      held?.checkContext?.();
    };
    check();
    const value = run({ fd, mount, identity: before, check, held });
    check();
    return value;
  } finally { if (own) fs.closeSync(fd); }
}
function withLinuxJobs(root, run, create = false) {
  const name = linuxAt(root.fd, JOBS_DIR_NAME);
  let before;
  try { before = linuxChecked(fs.lstatSync(name, { bigint: true }), true); }
  catch (error) {
    if (error?.code !== "ENOENT" || !create) throw error;
    fs.mkdirSync(name, { mode: 0o700 }); fs.fsyncSync(root.fd);
    before = linuxChecked(fs.lstatSync(name, { bigint: true }), true);
  }
  if (before.dev !== root.identity.dev) throw new Error("Linux jobs directory crosses a filesystem boundary");
  const fd = fs.openSync(name, LINUX_DIR_FLAGS);
  try {
    const check = () => {
      root.check();
      if (!linuxSame(before, linuxChecked(fs.fstatSync(fd, { bigint: true }), true)) ||
          !linuxSame(before, linuxChecked(fs.lstatSync(name, { bigint: true }), true)) || fdMountId(fd) !== root.mount) {
        throw new Error("Linux jobs directory changed or crosses a mount boundary");
      }
    };
    check(); const value = run({ fd, mount: root.mount, identity: before, check, root }); check(); return value;
  } finally { fs.closeSync(fd); }
}
function linuxReadRecord(directory, name) {
  directory.check();
  const file = linuxAt(directory.fd, name);
  const before = fs.lstatSync(file, { bigint: true });
  const identity = linuxChecked(before, false);
  const fd = fs.openSync(file, LINUX_READ_FLAGS);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (identity.dev !== directory.identity.dev || !linuxSame(identity, linuxChecked(opened, false)) || fdMountId(fd) !== directory.mount) throw new Error("Linux record changed or crosses a mount boundary");
    const text = fs.readFileSync(fd, "utf8");
    fs.fsyncSync(fd); fs.fsyncSync(directory.fd);
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    if (!linuxSame(identity, linuxChecked(after, false)) || !linuxSame(identity, linuxChecked(named, false)) ||
        opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) throw new Error("Linux record changed during read");
    directory.check();
    return text;
  } finally { fs.closeSync(fd); }
}
function assertNoLinuxIndexTemp(root) {
  root.check();
  const entries = fs.opendirSync(linuxAt(root.fd, "."));
  let count = 0;
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      if (++count > 4096) throw new Error("Linux state directory inventory exceeds its capacity");
      if (/^state\.json\..*\.tmp$/i.test(entry.name)) throw new Error("Linux state directory contains an unconfirmed temporary index; offline recovery is required");
    }
  } finally { entries.closeSync(); }
  fs.fsyncSync(root.fd);
  root.check();
}
function linuxWriteRecord(directory, name, serialized) {
  if (Buffer.byteLength(serialized, "utf8") > LINUX_RECORD_LIMIT) throw new Error("Linux state record exceeds the readable size limit");
  directory.check();
  const target = linuxAt(directory.fd, name), temporary = linuxAt(directory.fd, `${name}.${randomUUID()}.tmp`);
  let previous = null;
  let previousStat;
  try { previousStat = fs.lstatSync(target, { bigint: true }); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (previousStat) {
    previous = linuxChecked(previousStat, false);
    const previousFd = fs.openSync(target, LINUX_READ_FLAGS);
    try {
      if (previous.dev !== directory.identity.dev || fdMountId(previousFd) !== directory.mount ||
          !linuxSame(previous, linuxChecked(fs.fstatSync(previousFd, { bigint: true }), false))) throw new Error("Linux previous record changed or crosses a mount boundary");
      fs.fsyncSync(previousFd); fs.fsyncSync(directory.fd);
    } finally { fs.closeSync(previousFd); }
  }
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const identity = linuxChecked(fs.fstatSync(fd, { bigint: true }), false);
    if (identity.dev !== directory.identity.dev || fdMountId(fd) !== directory.mount) throw new Error("Linux record crosses a mount boundary");
    const bytes = Buffer.from(serialized);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("Linux record write made no progress");
      offset += written;
    }
    fs.fsyncSync(fd);
    const prepared = fs.fstatSync(fd, { bigint: true });
    if (prepared.size !== BigInt(bytes.length) || !linuxSame(identity, linuxChecked(prepared, false)) ||
        !linuxSame(identity, linuxChecked(fs.lstatSync(temporary, { bigint: true }), false))) throw new Error("Linux prepared record changed");
    directory.check();
    if (previous && !linuxSame(previous, linuxChecked(fs.lstatSync(target, { bigint: true }), false))) throw new Error("Linux previous record changed before publication");
    fs.renameSync(temporary, target);
    fs.fsyncSync(directory.fd);
    if (!linuxSame(identity, linuxChecked(fs.lstatSync(target, { bigint: true }), false))) throw new Error("Linux published record changed");
    directory.check();
  } finally { fs.closeSync(fd); }
}
const LINUX_CONTROL_STEP_BYTES = 4096n;
export function linuxControlReserve(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return 4n * LINUX_CONTROL_STEP_BYTES;
  const terminal = ["completed", "failed", "cancelled"].includes(record.status);
  const pending = record.terminationPending === true;
  const leased = record.workerLease != null;
  const workerStopped = record.workerStopConfirmed === true && record.workerStopProof === "linux-lease-released" &&
    typeof record.workerStopLeaseId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.workerStopLeaseId) &&
    (!leased || record.workerLease?.id === record.workerStopLeaseId) &&
    (record.workerStopProcessStartKey ?? null) === (record.processStartKey ?? null);
  const cancelRequested = record.status === "cancelled" && typeof record.cancelRequestedAt === "string" && Boolean(record.cancelRequestedAt.trim());
  if (terminal && !pending && !leased) return 0n;
  if (terminal && !pending && leased) return workerStopped ? 0n : LINUX_CONTROL_STEP_BYTES;
  let steps = 4n;
  if (cancelRequested) steps--;
  if (cancelRequested && record.grokDirectGeneration &&
      record.grokDirectStopGeneration === record.grokDirectGeneration &&
      ["job-empty", "never-started", "posix-group-empty"].includes(record.grokDirectStopKind)) steps--;
  if (workerStopped) steps--;
  return steps * LINUX_CONTROL_STEP_BYTES;
}
// detail と index を別々に確定する間の staging 余裕。どちらか一方だけが
// 保存されて停止しても、旧側の control reserve は維持する。
export function linuxControlCapacityReserve(record) {
  const reserve = linuxControlReserve(record);
  if (reserve === 0n) return 0n;
  // running/queued には通常の停止操作とは別に、外部障害を failed として
  // 保存する分を確保する。failed 保存後にのみこの一段を消費できる。
  const terminal = record && ["completed", "failed", "cancelled"].includes(record.status);
  return reserve + LINUX_CONTROL_STEP_BYTES + (terminal ? 0n : LINUX_CONTROL_STEP_BYTES);
}
function linuxBudgetInventory(directory, state, name = null) {
  // sweep の逆参照検証と同じ bounded inventory を、同じ state mutex 内で
  // index/detail の公開前に確認する。旧 target の大きさだけを差し引く。
  directory.check();
  if (!state || !Array.isArray(state.jobs) || state.jobs.length > 4096) throw new Error("Linux job history is invalid or exceeds its capacity");
  const reserves = new Map();
  for (const job of state.jobs) {
    if (!job || typeof job.id !== "string" || reserves.has(job.id)) throw new Error("Linux job history has invalid or duplicate IDs");
    reserves.set(job.id, linuxControlCapacityReserve(job));
  }
  const entries = fs.opendirSync(linuxAt(directory.fd, "."));
  let count = 0, total = 0n, targetBytes = 0n;
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      if (++count > 4096 || !entry.isFile()) throw new Error("Linux jobs inventory exceeds its capacity or is unverified");
      if (/\.tmp$/i.test(entry.name)) throw new Error("Linux jobs inventory contains an unconfirmed temporary record; offline recovery is required");
      if (!/\.json$/i.test(entry.name)) continue;
      if (!entry.name.endsWith(".json")) throw new Error("Linux jobs inventory contains an unverified JSON name");
      const file = linuxAt(directory.fd, entry.name), before = fs.lstatSync(file, { bigint: true });
      const identity = linuxChecked(before, false);
      const fd = fs.openSync(file, LINUX_READ_FLAGS);
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (identity.dev !== directory.identity.dev || fdMountId(fd) !== directory.mount ||
            !linuxSame(identity, linuxChecked(opened, false)) || opened.size !== before.size) throw new Error("Linux jobs inventory changed or crosses a mount boundary");
        const detail = JSON.parse(fs.readFileSync(fd, "utf8"));
        fs.fsyncSync(fd);
        const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
        if (!linuxSame(identity, linuxChecked(after, false)) || !linuxSame(identity, linuxChecked(named, false)) ||
            after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
          throw new Error("Linux jobs inventory changed during size inspection");
        }
        total += opened.size;
        if (!detail || typeof detail.id !== "string" || entry.name !== `${detail.id}.json`) throw new Error("Linux jobs inventory contains an unverified detail");
        const reserve = linuxControlCapacityReserve(detail);
        reserves.set(detail.id, reserves.has(detail.id) ? (reserves.get(detail.id) > reserve ? reserves.get(detail.id) : reserve) : reserve);
        if (entry.name === name) targetBytes = opened.size;
      } finally { fs.closeSync(fd); }
    }
  } finally { entries.closeSync(); }
  fs.fsyncSync(directory.fd);
  directory.check();
  return { reserves, total, targetBytes };
}
function checkLinuxDetailBudget(directory, name, serialized, payload) {
  const state = JSON.parse(linuxReadRecord(directory.root, STATE_FILE_NAME));
  const { reserves, total, targetBytes } = linuxBudgetInventory(directory, state, name);
  if (!payload || typeof payload.id !== "string" || name !== `${payload.id}.json`) throw new Error("Linux job detail identity is invalid");
  const previous = reserves.get(payload.id) ?? 0n;
  const next = linuxControlCapacityReserve(payload);
  // 状態が進む detail だけは自分の staging 分を使う。古い index と新しい
  // detail の大きい方の実 control reserve は、途中停止後も残す。
  const targetReserve = previous > next && previous > 0n
    ? previous - LINUX_CONTROL_STEP_BYTES : (previous > next ? previous : next);
  reserves.set(payload.id, targetReserve);
  const controlReserve = [...reserves.values()].reduce((sum, value) => sum + value, 0n);
  if (total - targetBytes + BigInt(Buffer.byteLength(serialized, "utf8")) + controlReserve > BigInt(LINUX_RECORD_LIMIT)) {
    throw new Error("Linux detail aggregate budget exceeds 64 MiB; records were preserved");
  }
}
function checkLinuxIndexBudget(root, payload, serialized) {
  const { reserves } = withLinuxJobs(root, directory => linuxBudgetInventory(directory, payload));
  const controlReserve = [...reserves.values()].reduce((sum, value) => sum + value, 0n);
  if (BigInt(Buffer.byteLength(serialized, "utf8")) + controlReserve > BigInt(LINUX_RECORD_LIMIT)) {
    throw new Error("Linux state index budget exceeds 64 MiB; records were preserved");
  }
}
const MAX_FINISHED_JOBS = 50;
const MAX_REVIEW_GATE_SESSIONS = 50;
// cancelはworkerのcritical section終了を待ってから、同lock内で最大5秒の
// 停止確認を行う。他jobの進捗更新は、その予算と保存処理の余裕を待つ。
// 旧writerの10秒経過回収より短くしても、旧writerとの相互排他は保証できない。
const STATE_LOCK_RETRY_LIMIT = 750;
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

export function resolveStateDir(cwd, options) {
  const resolutionOptions = options?.strictWorkspace && options.deadline === undefined
    ? { ...options, deadline: performance.now() + 7500 }
    : options;
  const workspaceRoot = resolveWorkspaceRoot(cwd, resolutionOptions);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch (error) {
    if (options?.strictWorkspace) throw new Error(`Workspace identity could not be resolved: ${workspaceRoot}`, { cause: error });
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(canonicalWorkspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV] || process.env.PLUGIN_DATA;
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  const proposed = path.join(stateRoot, `${slug}-${hash}`);
  let rootStat;
  try { rootStat = fs.lstatSync(stateRoot, { bigint: true }); } catch (error) {
    if (error?.code === "ENOENT") return proposed;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`State root is not a verified directory: ${stateRoot}`);
  const suffix = `-${hash}`;
  const matches = fs.readdirSync(stateRoot).filter(name =>
    (process.platform === "win32" ? name.toLowerCase() : name).endsWith(suffix));
  for (const name of matches) {
    const stat = fs.lstatSync(path.join(stateRoot, name), { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Workspace state candidate is not a verified directory: ${path.join(stateRoot, name)}`);
  }
  const after = fs.lstatSync(stateRoot, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || rootStat.dev !== after.dev || rootStat.ino !== after.ino) {
    throw new Error(`State root changed during workspace resolution: ${stateRoot}`);
  }
  if (matches.length > 1) throw new Error(`Multiple state directories refer to this workspace; stop old runtimes and recover them explicitly: ${stateRoot}`);
  return matches.length ? path.join(stateRoot, matches[0]) : proposed;
}

export function resolveStateFile(cwd, stateDir = resolveStateDir(cwd)) {
  return path.join(stateDir, STATE_FILE_NAME);
}

export function resolveJobsDir(cwd, stateDir = resolveStateDir(cwd)) {
  return path.join(stateDir, JOBS_DIR_NAME);
}

export function ensureStateDir(cwd, stateDir = resolveStateDir(cwd)) {
  requireStateLockMigration(stateDir);
  if (process.platform === "linux") {
    withLinuxRoot(stateDir, root => withLinuxJobs(root, () => {}, Boolean(root.held)));
    return;
  }
  const jobsDir = resolveJobsDir(cwd, stateDir);
  if (process.platform === "darwin") {
    if (!Number.isInteger(fs.constants.O_NOFOLLOW) || fs.constants.O_NOFOLLOW <= 0 ||
        !Number.isInteger(fs.constants.O_NONBLOCK) || fs.constants.O_NONBLOCK <= 0) {
      throw new Error("Darwin state directory requires no-follow and nonblocking open support");
    }
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (fs.constants.O_DIRECTORY ?? 0);
    const valid = stat => stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid()) &&
      (stat.mode & 0o077n) === 0n && stat.dev > 0n && stat.ino > 0n;
    const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
    const rootBefore = fs.lstatSync(stateDir, { bigint: true });
    if (!valid(rootBefore)) throw new Error("Darwin state directory ownership or permissions are invalid");
    const rootFd = fs.openSync(stateDir, flags);
    try {
      if (!valid(fs.fstatSync(rootFd, { bigint: true })) || !same(rootBefore, fs.fstatSync(rootFd, { bigint: true }))) {
        throw new Error("Darwin state directory identity changed");
      }
      let before, created = false;
      try { before = fs.lstatSync(jobsDir, { bigint: true }); }
      catch (error) {
        if (error?.code !== "ENOENT") throw error;
        try { fs.mkdirSync(jobsDir, { mode: 0o700 }); created = true; }
        catch (mkdirError) { if (mkdirError?.code !== "EEXIST") throw mkdirError; }
        before = fs.lstatSync(jobsDir, { bigint: true });
      }
      if (!valid(before) || before.dev !== rootBefore.dev) throw new Error("Darwin jobs directory ownership, permissions or filesystem are invalid");
      const jobsFd = fs.openSync(jobsDir, flags);
      try {
        const opened = fs.fstatSync(jobsFd, { bigint: true });
        if (!valid(opened) || !same(before, opened) || opened.dev !== rootBefore.dev) throw new Error("Darwin jobs directory identity changed");
        if (created) { fs.fsyncSync(jobsFd); fs.fsyncSync(rootFd); }
        const named = fs.lstatSync(jobsDir, { bigint: true }), rootNamed = fs.lstatSync(stateDir, { bigint: true });
        if (!valid(named) || !same(named, opened) || !valid(rootNamed) || !same(rootNamed, rootBefore) ||
            !same(fs.fstatSync(rootFd, { bigint: true }), rootBefore)) throw new Error("Darwin jobs or state directory identity changed");
      } finally { fs.closeSync(jobsFd); }
    } finally { fs.closeSync(rootFd); }
    return;
  }
  let jobsStat;
  try { jobsStat = fs.lstatSync(jobsDir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (jobsStat && (!jobsStat.isDirectory() || jobsStat.isSymbolicLink())) throw new Error(`Jobs directory is not a verified directory: ${jobsDir}`);
  if (!jobsStat) fs.mkdirSync(jobsDir, { mode: 0o700 });
  jobsStat = fs.lstatSync(jobsDir);
  if (!jobsStat.isDirectory() || jobsStat.isSymbolicLink()) throw new Error(`Jobs directory is not a verified directory: ${jobsDir}`);
  try {
    fs.chmodSync(stateDir, 0o700);
    fs.chmodSync(jobsDir, 0o700);
  } catch {
    // Windows では POSIX mode が実質無効。作成自体が成功していれば続行する。
  }
}

export function loadState(cwd, stateDir = resolveStateDir(cwd)) {
  const stateFile = resolveStateFile(cwd, stateDir);
  const strictDarwin = isDarwinStrictState(stateDir);
  const strictRecord = strictDarwin || process.platform === "linux";
  if (!fs.existsSync(stateFile)) {
    if (strictRecord) throw new Error(`Grok state is missing and was left untouched: ${stateFile}`);
    return defaultState();
  }

  try {
    let text;
    if (process.platform === "linux") {
      requireStateLockMigration(stateDir);
      text = withLinuxRoot(stateDir, root => { assertNoLinuxIndexTemp(root); return linuxReadRecord(root, STATE_FILE_NAME); });
    } else if (strictDarwin) {
      const before = fs.lstatSync(stateFile, { bigint: true });
      if (!validDarwinRecordStat(before)) throw new Error("Darwin state is not a verified bounded regular file");
      const fd = fs.openSync(stateFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!validDarwinRecordStat(opened) || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Darwin state changed before read");
        text = fs.readFileSync(fd, "utf8");
        fs.fsyncSync(fd);
        syncDarwinDirectory(stateDir);
        const after = fs.lstatSync(stateFile, { bigint: true });
        const finalStat = fs.fstatSync(fd, { bigint: true });
        if (!validDarwinRecordStat(after) || !validDarwinRecordStat(finalStat) || after.dev !== before.dev || after.ino !== before.ino ||
            finalStat.size !== opened.size || finalStat.mtimeNs !== opened.mtimeNs) throw new Error("Darwin state changed during read");
      } finally { fs.closeSync(fd); }
    } else text = fs.readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(text);
    if (strictRecord && (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.jobs))) {
      throw new Error("State jobs are missing or invalid");
    }
    if (strictRecord) {
      const ids = new Set();
      for (const job of parsed.jobs) {
        if (!job || typeof job.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(job.id) || ids.has(job.id)) {
          throw new Error("State contains an invalid or duplicate job ID");
        }
        ids.add(job.id);
      }
    }
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

function isDarwinStrictState(stateDir) {
  if (process.platform !== "darwin") return false;
  requireStateLockMigration(stateDir);
  return true;
}

function syncDarwinDirectory(directory) {
  const before = fs.lstatSync(directory, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`Darwin state directory is invalid: ${directory}`);
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`Darwin state directory changed: ${directory}`);
    fs.fsyncSync(fd);
    const after = fs.lstatSync(directory, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new Error(`Darwin state directory changed: ${directory}`);
  } finally { fs.closeSync(fd); }
}

function validJobLogReference(job, jobsDir) {
  if (!job || typeof job.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(job.id)) return false;
  return job.logFile == null || (typeof job.logFile === "string" && path.isAbsolute(job.logFile) &&
    path.resolve(job.logFile) === path.resolve(jobsDir, `${job.id}.log`));
}

const DARWIN_JOB_EVIDENCE = ["id", "status", "epoch", "claimToken", "createdAt", "startedAt", "completedAt", "pid", "processStartKey",
  "terminationPending", "grokPromptState", "grokSessionId", "grokTransport", "grokBrokerGeneration", "grokDirectGeneration",
  "grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt",
  "workerStopConfirmed", "workerStopProof", "workerStopLeaseId", "workerStopProcessStartKey"];
function sameDarwinJobEvidence(index, detail) {
  return Boolean(index && detail && DARWIN_JOB_EVIDENCE.every(key => (index[key] ?? null) === (detail[key] ?? null)));
}

function validDarwinStopEvidence(job) {
  const confirmed = job.workerStopConfirmed;
  const proof = job.workerStopProof ?? null, leaseId = job.workerStopLeaseId ?? null, startKey = job.workerStopProcessStartKey ?? null;
  if (confirmed == null) return proof === null && leaseId === null && startKey === null;
  if (confirmed !== true || job.pid != null) return false;
  if (proof === "never-started") return job.startedAt == null && job.processStartKey == null && leaseId === null && startKey === null;
  return proof === "darwin-lease-released" && typeof leaseId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseId) &&
    startKey === (job.processStartKey ?? null);
}

function verifiedDarwinJobForRemoval(job, detail, jobsDir, jobs, epoch) {
  if (!job || !detail || !["completed", "failed", "cancelled"].includes(job.status) ||
      typeof job.createdAt !== "string" || !job.createdAt.trim() || isActiveJob(job) || isActiveJob(detail) ||
      !epoch || job.epoch !== epoch || detail.epoch !== epoch ||
      job.terminationPending !== false || detail.terminationPending !== false ||
      !["terminal", "not-sent"].includes(job.grokPromptState) || job.grokPromptState !== detail.grokPromptState ||
      job.workerLease != null || detail.workerLease != null || !sameDarwinJobEvidence(job, detail) ||
      !validDarwinStopEvidence(job) || !validDarwinStopEvidence(detail) ||
      !validJobLogReference(job, jobsDir) || !validJobLogReference(detail, jobsDir) ||
      (job.logFile ?? null) !== (detail.logFile ?? null) ||
      jobs.filter(other => typeof other?.id === "string" && other.id.toLowerCase() === job.id.toLowerCase()).length !== 1) return false;
  const names = fs.readdirSync(jobsDir);
  for (const name of [`${job.id}.json`, `${job.id}.log`]) {
    const aliases = names.filter(entry => entry.toLowerCase() === name.toLowerCase());
    if (name.endsWith(".json") && (aliases.length !== 1 || aliases[0] !== name)) return false;
    if (name.endsWith(".log") && aliases.length && (aliases.length !== 1 || aliases[0] !== name)) return false;
    if (aliases.length) {
      const stat = fs.lstatSync(path.join(jobsDir, name), { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return false;
    }
  }
  return true;
}

// 旧 writer 停止済みの明示移行でも、片側記録や旧 admission を空 ledger に降格しない。
function verifyDarwinMigrationInventory(stateDir, { allowVerifiedLegacyArtifacts = false, deadline = performance.now() + 7500 } = {}) {
  const byteLimit = 64n * 1024n * 1024n;
  let totalBytes = 0n;
  const checkDeadline = () => { if (performance.now() >= deadline) throw new Error("Darwin migration inventory time limit exceeded"); };
  const boundedNames = directory => {
    checkDeadline();
    const entries = fs.opendirSync(directory), names = [];
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        checkDeadline();
        if (names.length >= 4096) throw new Error("Darwin migration inventory entry limit exceeded");
        names.push(entry.name);
      }
    } finally { entries.closeSync(); }
    checkDeadline();
    return names;
  };
  const charge = size => {
    totalBytes += size;
    if (totalBytes > byteLimit) throw new Error("Darwin migration inventory byte limit exceeded");
    checkDeadline();
  };
  const rootStat = fs.lstatSync(stateDir, { bigint: true });
  const rootEntries = boundedNames(stateDir);
  const allowed = [STATE_LOCK_FILE_NAME, STATE_FILE_NAME, JOBS_DIR_NAME,
    ...(allowVerifiedLegacyArtifacts ? [".darwin-legacy-migration", "broker-v2", "direct-start-v1"] : [])];
  if (rootEntries.some(name => !allowed.includes(name))) {
    throw new Error("Unknown or old Darwin state artifacts require offline recovery");
  }
  const stateFile = path.join(stateDir, STATE_FILE_NAME);
  const jobsDir = path.join(stateDir, JOBS_DIR_NAME);
  let stateStat, jobsStat;
  try { stateStat = fs.lstatSync(stateFile, { bigint: true }); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  try { jobsStat = fs.lstatSync(jobsDir, { bigint: true }); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (jobsStat && (!jobsStat.isDirectory() || jobsStat.isSymbolicLink() || jobsStat.uid !== BigInt(process.getuid()) ||
      (jobsStat.mode & 0o077n) !== 0n || jobsStat.dev !== rootStat.dev)) throw new Error("Old Darwin jobs directory is invalid");
  const names = jobsStat ? boundedNames(jobsDir) : [];
  if (!stateStat) {
    if (names.length) throw new Error("Existing job records without state require offline recovery");
    return;
  }
  const readLegacy = file => {
    const before = fs.lstatSync(file, { bigint: true });
    if (!validDarwinRecordStat(before)) throw new Error("Old Darwin state record is invalid");
    if (before.dev !== rootStat.dev) throw new Error("Old Darwin state record crosses a filesystem boundary");
    charge(before.size);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!validDarwinRecordStat(opened) || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Old Darwin state record changed");
      const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
      checkDeadline();
      fs.fsyncSync(fd);
      syncDarwinDirectory(path.dirname(file));
      const after = fs.fstatSync(fd, { bigint: true });
      const named = fs.lstatSync(file, { bigint: true });
      if (!validDarwinRecordStat(after) || !validDarwinRecordStat(named) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs ||
          named.dev !== opened.dev || named.ino !== opened.ino) throw new Error("Old Darwin state record changed during read");
      return parsed;
    } finally { fs.closeSync(fd); }
  };
  const parsed = readLegacy(stateFile);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.jobs)) throw new Error("Old Darwin state jobs are invalid");
  const jobs = new Map();
  for (const job of parsed.jobs) {
    checkDeadline();
    if (jobs.size >= 4096) throw new Error("Darwin migration inventory job limit exceeded");
    if (!job || typeof job.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(job.id) || jobs.has(job.id) ||
        !validJobLogReference(job, jobsDir) || [...jobs.keys()].some(id => id.toLowerCase() === job.id.toLowerCase()) ||
        ["workerLease", "claimToken", "epoch"].some(key => Object.hasOwn(job, key))) throw new Error("Old Darwin job identity, log or lease is unverified");
    jobs.set(job.id, job);
  }
  const expected = new Set();
  for (const [id, job] of jobs) {
    const detailName = `${id}.json`;
    if (!names.includes(detailName)) throw new Error("Old Darwin job detail is missing");
    const detail = readLegacy(path.join(jobsDir, detailName));
    if (!detail || !sameDarwinJobEvidence(job, detail) || !validJobLogReference(detail, jobsDir) ||
        (job.logFile ?? null) !== (detail.logFile ?? null) ||
        ["workerLease", "claimToken", "epoch"].some(key => Object.hasOwn(detail, key))) throw new Error("Old Darwin job detail is inconsistent");
    expected.add(detailName);
    expected.add(`${id}.log`);
  }
  if (names.some(name => !expected.has(name))) throw new Error("Unreferenced Darwin job files require offline recovery");
  for (const name of names.filter(name => name.endsWith(".log"))) {
    const file = path.join(jobsDir, name), before = fs.lstatSync(file, { bigint: true });
    if (!validDarwinRecordStat(before) || before.dev !== rootStat.dev) throw new Error("Old Darwin job log identity, mode, owner, size or link count is invalid");
    charge(before.size);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!validDarwinRecordStat(opened) || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
          opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) throw new Error("Old Darwin job log changed before verification");
      fs.fsyncSync(fd); checkDeadline();
      const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
      if (!validDarwinRecordStat(after) || !validDarwinRecordStat(named) || after.dev !== before.dev || after.ino !== before.ino ||
          named.dev !== before.dev || named.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
          after.ctimeNs !== before.ctimeNs) throw new Error("Old Darwin job log changed during verification");
    } finally { fs.closeSync(fd); }
  }
  if (jobsStat) syncDarwinDirectory(jobsDir);
  checkDeadline();
}

// 旧 file-lock の固定 preflight。guard は取得済み実 FD を検査し、外部の
// callback や未検証 artifact 名を受け入れない。
export function verifyDarwinLegacyPreflight({ stateDir, guardContext }) {
  const deadline = performance.now() + 7500;
  const checkDeadline = () => { if (performance.now() >= deadline) throw new Error("Darwin migration preflight time limit exceeded"); };
  assertDarwinLegacyGuardContext(guardContext);
  checkDeadline();
  if (stateDir !== guardContext.stateDir || guardContext.fileSystem !== "apfs") throw new Error("Darwin legacy preflight guard scope is invalid");
  const root = fs.lstatSync(stateDir, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink() || String(root.dev) !== guardContext.directoryIdentity?.dev ||
      String(root.ino) !== guardContext.directoryIdentity?.ino) throw new Error("Darwin legacy preflight state directory identity changed");
  const lockFile = path.join(stateDir, STATE_LOCK_FILE_NAME);
  let before;
  try { before = fs.lstatSync(lockFile, { bigint: true }); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (!before || (before.isFile() && !before.isSymbolicLink() && before.nlink === 2n)) {
    // 旧名解除後、または link 後の停止では durable transition と同じ inode の
    // backup を必ず照合する。未知の barrier はこの経路では復旧しない。
    const oldLock = readDarwinLegacyTransition(guardContext, deadline);
    const token = Object.freeze({});
    DARWIN_LEGACY_PREFLIGHTS.set(token, { stateDir, guardContext, oldLock });
    try {
      assertDarwinLegacyLockBackup(guardContext, token, deadline);
      verifyDarwinMigrationInventory(stateDir, { allowVerifiedLegacyArtifacts: true, deadline });
      const scope = { hostId: guardContext.hostId, fileSystem: guardContext.fileSystem, directoryIdentity: guardContext.directoryIdentity };
      verifyDarwinAdmissionInventory({ stateDir, scope, migrationDir: guardContext.migrationDir,
        migrationDirectoryIdentity: guardContext.migrationDirectoryIdentity, guardContext, deadline });
      assertDarwinLegacyLockBackup(guardContext, token, deadline);
      return token;
    } catch (error) {
      DARWIN_LEGACY_PREFLIGHTS.delete(token);
      throw error;
    }
  }
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n ||
      String(before.dev) !== guardContext.directoryIdentity.dev || before.size > 128n ||
      (before.mode & 0o7022n) !== 0n || (before.mode & 0o400n) === 0n) throw new Error("Darwin legacy lock identity or mode is invalid");
  const fd = fs.openSync(lockFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let oldLock;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n || opened.size !== before.size) {
      throw new Error("Darwin legacy lock changed before preflight");
    }
    const contents = fs.readFileSync(fd, "utf8"), after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(lockFile, { bigint: true });
    if (!/^[1-9]\d*\n$/.test(contents) || after.dev !== before.dev || after.ino !== before.ino || named.dev !== before.dev ||
        named.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error("Darwin legacy lock content or identity changed during preflight");
    }
    fs.fsyncSync(fd);
    oldLock = Object.freeze({ dev: String(before.dev), ino: String(before.ino), uid: String(before.uid), gid: String(before.gid),
      mode: String(before.mode), size: String(before.size), sha256: createHash("sha256").update(contents, "utf8").digest("hex") });
  } finally { fs.closeSync(fd); }
  checkDeadline();
  assertDarwinLegacyGuardContext(guardContext);
  checkDeadline();
  verifyDarwinMigrationInventory(stateDir, { allowVerifiedLegacyArtifacts: true, deadline });
  assertDarwinLegacyGuardContext(guardContext);
  checkDeadline();
  const scope = { hostId: guardContext.hostId, fileSystem: guardContext.fileSystem, directoryIdentity: guardContext.directoryIdentity };
  verifyDarwinAdmissionInventory({ stateDir, scope, migrationDir: guardContext.migrationDir,
    migrationDirectoryIdentity: guardContext.migrationDirectoryIdentity, guardContext, deadline });
  assertDarwinLegacyGuardContext(guardContext);
  checkDeadline();
  const token = Object.freeze({});
  DARWIN_LEGACY_PREFLIGHTS.set(token, { stateDir, guardContext, oldLock });
  return token;
}

function prepareDarwinStateGeneration(stateDir, { epoch, directoryIdentity }, guardContext = null) {
  if (guardContext) {
    assertDarwinLegacyGuardContext(guardContext);
    if (guardContext.stateDir !== stateDir || !sameStateLockIdentity(guardContext.directoryIdentity, directoryIdentity)) {
      throw new Error("Darwin legacy generation scope changed");
    }
  }
  verifyDarwinMigrationInventory(stateDir, { allowVerifiedLegacyArtifacts: Boolean(guardContext) });
  if (guardContext) {
    const scope = { hostId: guardContext.hostId, fileSystem: guardContext.fileSystem, directoryIdentity: guardContext.directoryIdentity };
    verifyDarwinAdmissionInventory({ stateDir, scope, migrationDir: guardContext.migrationDir,
      migrationDirectoryIdentity: guardContext.migrationDirectoryIdentity, guardContext });
    assertDarwinLegacyGuardContext(guardContext);
  }
  const stateFile = path.join(stateDir, STATE_FILE_NAME);
  let stat;
  try { stat = fs.lstatSync(stateFile); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (!stat) {
    const jobsDir = path.join(stateDir, JOBS_DIR_NAME);
    let jobsStat;
    try { jobsStat = fs.lstatSync(jobsDir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (jobsStat && (!jobsStat.isDirectory() || jobsStat.isSymbolicLink() || fs.readdirSync(jobsDir).length)) {
      throw new Error("Existing job records without state require offline recovery");
    }
    writeJsonAtomic(stateFile, defaultState());
  } else {
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Existing state is not a regular file");
    const fd = fs.openSync(stateFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("Existing state changed during migration");
      const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.jobs)) throw new Error("Existing state jobs are invalid");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncDarwinDirectory(stateDir);
  }
  initializeDarwinLeaseLedger({ stateDir, epoch, directoryIdentity });
  if (guardContext) assertDarwinLegacyGuardContext(guardContext);
}

// 旧名が解除され、transition と元 inode の durable backup が検証された
// 場合だけ v4 barrier を排他的に準備する。completion はこの入口では発行しない。
export function prepareDarwinLegacyBarrier({ stateDir, guardContext, preflightToken, offlineAuthorization, expectedStateDir, offlineConfirmed, localOnly }) {
  if (offlineConfirmed !== true || localOnly !== true || typeof stateDir !== "string" || !path.isAbsolute(stateDir) ||
      expectedStateDir !== stateDir) throw new Error("Darwin legacy barrier requires explicit offline confirmation and the exact state directory");
  assertDarwinLegacyPreflightToken(preflightToken, guardContext);
  assertDarwinLegacyOfflineAuthorization(offlineAuthorization, guardContext, preflightToken);
  if (guardContext.stateDir !== stateDir) throw new Error("Darwin legacy barrier guard scope changed");
  assertDarwinLegacyLockBackup(guardContext, preflightToken);
  const lockDir = path.join(stateDir, STATE_LOCK_FILE_NAME);
  try {
    fs.lstatSync(lockDir);
    throw new Error("Existing Darwin state barrier was left untouched; offline recovery is required");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  verifyDarwinMigrationInventory(stateDir, { allowVerifiedLegacyArtifacts: true });
  const scope = { hostId: guardContext.hostId, fileSystem: guardContext.fileSystem, directoryIdentity: guardContext.directoryIdentity };
  verifyDarwinAdmissionInventory({ stateDir, scope, migrationDir: guardContext.migrationDir,
    migrationDirectoryIdentity: guardContext.migrationDirectoryIdentity, guardContext });
  assertDarwinLegacyLockBackup(guardContext, preflightToken);
  const prepare = generation => {
    assertDarwinLegacyLockBackup(guardContext, preflightToken);
    prepareDarwinStateGeneration(stateDir, generation, guardContext);
  };
  const authorization = Object.freeze({});
  DARWIN_MIGRATION_AUTHORIZATIONS.set(authorization, { stateDir, prepare, guardContext });
  try { return migratePosixStateLock(stateDir, { expectedStateDir, prepareDarwinGeneration: prepare, darwinAuthorization: authorization }); }
  finally { DARWIN_MIGRATION_AUTHORIZATIONS.delete(authorization); }
}

// この context は guard の後に実 native mutex を取得した間だけ有効。
function withDarwinMigrationStateContext(guardContext, directoryIdentity, protocol, checkLocked, preflightToken, run) {
    const stateDir = guardContext.stateDir;
    if (protocol.protocol !== "posix-local-v4" || typeof checkLocked !== "function" ||
        !sameStateLockIdentity(directoryIdentity, guardContext.directoryIdentity)) throw new Error("Darwin migration mutex scope changed");
    const ownToken = !preflightToken;
    if (ownToken) {
      const oldLock = readDarwinLegacyTransition(guardContext);
      preflightToken = Object.freeze({});
      DARWIN_LEGACY_PREFLIGHTS.set(preflightToken, { stateDir, guardContext, oldLock });
    }
    let active = true;
    const check = (expectedGuard = guardContext, deadline = Infinity) => {
      if (!active || expectedGuard !== guardContext || performance.now() >= deadline) throw new Error("Darwin migration mutex capability expired");
      assertDarwinLegacyGuardContext(guardContext, deadline);
      checkLocked();
      if (performance.now() >= deadline) throw new Error("Darwin migration mutex deadline exceeded");
    };
    const context = Object.freeze({ stateDir, hostId: guardContext.hostId, directoryIdentity: Object.freeze({ ...directoryIdentity }),
      protocol: protocol.protocol, epoch: protocol.epoch, barrierIdentity: protocol.barrierIdentity,
      lockIdentity: protocol.lockIdentity, markerIdentity: protocol.markerIdentity, check() { check(); } });
    DARWIN_STATE_CAPABILITIES.add(context);
    DARWIN_MIGRATION_STATE_CONTEXTS.set(context, check);
    try {
      check();
      return run(context, preflightToken);
    } finally {
      active = false;
      DARWIN_MIGRATION_STATE_CONTEXTS.delete(context);
      DARWIN_STATE_CAPABILITIES.delete(context);
      if (ownToken) DARWIN_LEGACY_PREFLIGHTS.delete(preflightToken);
    }
}

function finalizeDarwinLegacyMigration(stateDir, guardContext, preflightToken) {
  const scope = inspectPosixStateLockScope(stateDir);
  if (scope.hostId !== guardContext.hostId) throw new Error("Darwin migration host changed");
  return withPosixStateLock(stateDir, scope, (directoryIdentity, _dirs, protocol, checkLocked) => {
    return withDarwinMigrationStateContext(guardContext, directoryIdentity, protocol, checkLocked, preflightToken,
      (context, token) => publishDarwinMigrationCompletion(guardContext, context, token));
  }, { timeoutMs: 7500 });
}

/**
 * 同一jobの監視専用reader。workspace/Gitと保存先は作成時だけ解決する。
 * 候補はtransactionではない。停止証拠の保存・最終確定は従来lock内で再照合する。
 */
export function createStateJobReader(cwd, jobId) {
  if (typeof jobId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(jobId)) {
    throw new Error("Invalid state job identifier for a candidate reader.");
  }
  const stateDir = fs.realpathSync.native(resolveStateDir(cwd));
  if (process.platform === "darwin") requireStateLockMigration(stateDir);
  const jobsDir = path.join(stateDir, JOBS_DIR_NAME);
  const stateFile = path.join(stateDir, STATE_FILE_NAME);
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  const lockPath = path.join(stateDir, STATE_LOCK_FILE_NAME);
  const identity = (target) => {
    const stat = fs.lstatSync(target, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.ino <= 0n) throw new Error(`State candidate directory identity is unavailable: ${target}`);
    return stat;
  };
  const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
  const rootIdentity = identity(stateDir);
  const jobsIdentity = identity(jobsDir);
  const lockIdentity = () => {
    try {
      const stat = fs.lstatSync(lockPath, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error("State candidate lock must not be symbolic.");
      return stat.isDirectory() ? stat : null;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };
  const barrier = lockIdentity();
  const scope = barrier ? inspectNativeStateLockScope(stateDir) : null;
  const directoryIdentity = { dev: String(rootIdentity.dev), ino: String(rootIdentity.ino) };
  const initialProtocol = barrier ? readStateLockProtocol(lockPath, scope, directoryIdentity) : null;
  const readJson = (filePath) => {
    let handle;
    try {
      if (process.platform === "linux") {
        const text = withLinuxRoot(stateDir, root => filePath === stateFile
          ? linuxReadRecord(root, STATE_FILE_NAME)
          : withLinuxJobs(root, directory => linuxReadRecord(directory, `${jobId}.json`)));
        return JSON.parse(text);
      }
      const before = fs.lstatSync(filePath, { bigint: true });
      if (before.isSymbolicLink() || !before.isFile() || (process.platform === "darwin" && !validDarwinRecordStat(before))) throw new Error("Candidate record is not a verified bounded regular file.");
      // lstat 後に FIFO へ置換されても open で待ち続けない。
      if (process.platform !== "win32" && (typeof fs.constants.O_NONBLOCK !== "number" || typeof fs.constants.O_NOFOLLOW !== "number")) {
        throw new Error("Candidate record open protection is unavailable.");
      }
      const flags = process.platform === "win32"
        ? "r"
        : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
      handle = fs.openSync(filePath, flags);
      const opened = fs.fstatSync(handle, { bigint: true });
      if (!opened.isFile() || !same(before, opened) || (process.platform === "darwin" && !validDarwinRecordStat(opened))) throw new Error("Candidate record changed during open.");
      const parsed = JSON.parse(fs.readFileSync(handle, "utf8"));
      if (isDarwinStrictState(stateDir)) {
        fs.fsyncSync(handle);
        syncDarwinDirectory(path.dirname(filePath));
        const named = fs.lstatSync(filePath, { bigint: true });
        if (!validDarwinRecordStat(named) || !same(opened, named)) throw new Error("Candidate record changed during sync.");
      }
      const after = fs.fstatSync(handle, { bigint: true });
      if (opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || (process.platform === "darwin" && !validDarwinRecordStat(after))) throw new Error("Candidate record changed during read.");
      return parsed;
    } catch (error) {
      throw new Error(`Grok state candidate record is corrupt or unavailable: ${filePath}`, { cause: error });
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
  };
  return {
    stateDir,
    read() {
      if (!same(rootIdentity, identity(stateDir)) || !same(jobsIdentity, identity(jobsDir))) {
        throw new Error("State candidate directory was replaced; create a new reader explicitly.");
      }
      const currentBarrier = lockIdentity();
      if (Boolean(barrier) !== Boolean(currentBarrier) || (barrier && !same(barrier, currentBarrier))) {
        throw new Error("State candidate lock protocol changed.");
      }
      if (barrier) readStateLockProtocol(lockPath, scope, directoryIdentity);
      const parsed = readJson(stateFile);
      const stored = readJson(jobFile);
      if (!parsed || !Array.isArray(parsed.jobs) || !stored || Array.isArray(stored) || stored.id !== jobId) {
        throw new Error("Grok state candidate records have an invalid shape or job identity.");
      }
      const selected = parsed.jobs.filter(job => job?.id === jobId);
      if (selected.length > 1) throw new Error("Grok state candidate job identity is ambiguous.");
      if (process.platform === "linux" && barrier) {
        const current = readStateLockProtocol(lockPath, scope, directoryIdentity);
        if (current.protocol !== initialProtocol.protocol || current.epoch !== initialProtocol.epoch ||
            !linuxSame(current.leaseDirectoryIdentity, initialProtocol.leaseDirectoryIdentity)) throw new Error("Linux candidate protocol changed during read.");
      }
      return { indexed: selected[0] ?? null, stored };
    }
  };
}

function writeJsonAtomic(filePath, payload) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (process.platform === "linux") {
    const parent = path.dirname(filePath), isJob = path.basename(parent) === JOBS_DIR_NAME;
    const stateDir = isJob ? path.dirname(parent) : parent;
    if (!HELD_STATE_LOCK_SCOPES.get(stateDir)?.linuxDirs) throw new Error("Linux state write requires the state mutex and pinned root");
    const name = path.basename(filePath);
    if ((isJob && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name)) || (!isJob && name !== STATE_FILE_NAME)) throw new Error("Linux state record path is invalid");
    withLinuxRoot(stateDir, root => isJob
      ? withLinuxJobs(root, directory => { checkLinuxDetailBudget(directory, name, serialized, payload); linuxWriteRecord(directory, name, serialized); })
      : (checkLinuxIndexBudget(root, payload, serialized), linuxWriteRecord(root, name, serialized)));
    return;
  }
  if (process.platform === "darwin" && Buffer.byteLength(serialized, "utf8") > MAX_DARWIN_RECORD_BYTES) {
    throw new Error("Darwin state record exceeds the readable size limit");
  }
  const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    if (process.platform === "darwin") {
      const fd = fs.openSync(temporaryPath, "wx", 0o600);
      try { fs.writeFileSync(fd, serialized, "utf8"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    } else fs.writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    if (process.platform === "darwin") syncDarwinDirectory(path.dirname(filePath));
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

export function compareUpdatedAtNewestFirst(left, right) {
  return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
}

function pruneJobs(jobs, cwd, stateDir, epoch, previousJobs = jobs) {
  // Linux では旧 unleased job と回収途中の record を推測して捨てない。
  if (process.platform === "linux") return jobs;
  let finishedJobs = 0;
  const protectedJobs = process.platform === "darwin" && epoch
    ? getProtectedDarwinJobIds({ stateDir: stateDir ?? resolveStateDir(cwd), epoch }) : null;
  return [...jobs]
    .sort(compareUpdatedAtNewestFirst)
    .filter((job) => {
      // 停止を確認できていないジョブは、履歴が増えても追跡と再試行を維持する。
      if (isActiveJob(job)) return true;
      if (!validJobLogReference(job, resolveJobsDir(cwd, stateDir))) return true;
      const previous = previousJobs.find(entry => entry.id === job.id);
      if (previous && !validJobLogReference(previous, resolveJobsDir(cwd, stateDir))) return true;
      // lease の保全・回収を確認できない間は、履歴整理で所有中の記録を消さない。
      if (process.platform === "darwin" && job.workerLease) return true;
      if (process.platform === "darwin") {
        if (!epoch || protectedJobs?.has(job.id)) return true;
        try {
          const detail = readJobFile(path.join(resolveJobsDir(cwd, stateDir), `${job.id}.json`));
          if (!previous || !verifiedDarwinJobForRemoval(job, detail, resolveJobsDir(cwd, stateDir), jobs, epoch) ||
              !verifiedDarwinJobForRemoval(previous, detail, resolveJobsDir(cwd, stateDir), previousJobs, epoch)) return true;
        } catch { return true; }
      }
      if (process.platform === "linux") {
        // 旧世代や片側だけの記録を通常の履歴整理で失わない。
        if (!epoch || job.epoch !== epoch) return true;
        try {
          const detail = readJobFile(path.join(resolveJobsDir(cwd, stateDir), `${job.id}.json`));
          if (detail?.id !== job.id || detail.epoch !== epoch) return true;
        } catch { return true; }
      }
      finishedJobs += 1;
      return finishedJobs <= MAX_FINISHED_JOBS;
    });
}

function pruneReviewGateSessions(sessions, epoch = null) {
  const sorted = (Array.isArray(sessions) ? sessions : [])
    .filter((entry) => typeof entry?.sessionId === "string" && entry.sessionId.trim())
    .sort(compareUpdatedAtNewestFirst);
  if (process.platform !== "linux") return sorted.slice(0, MAX_REVIEW_GATE_SESSIONS);
  // 検証済み epoch がない読取りでは旧記録を削らない。保存時も旧世代は全て保全する。
  let currentSessions = 0;
  return sorted.filter(entry => !epoch || entry.epoch !== epoch || ++currentSessions <= MAX_REVIEW_GATE_SESSIONS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  if (process.platform === "linux" || (process.platform === "darwin" && isDarwinStrictState(resolveStateDir(cwd)))) {
    return withStateSnapshot(cwd, (previous, context) =>
      saveStateWithPreviousJobs(cwd, state, previous.jobs, context.stateDir, context.epoch));
  }
  const previousJobs = loadState(cwd).jobs;
  return saveStateWithPreviousJobs(cwd, state, previousJobs);
}

function saveStateWithPreviousJobs(cwd, state, previousJobs, stateDir = undefined, epoch = null) {
  ensureStateDir(cwd, stateDir);
  const proposedIds = new Set((state.jobs ?? []).map(job => job.id));
  if ((process.platform === "linux" || process.platform === "darwin") && previousJobs.some(job => !proposedIds.has(job.id))) {
    throw new Error("POSIX job history cannot be removed without a verified history transaction");
  }
  for (const previous of previousJobs) {
    if (!proposedIds.has(previous.id) && !validJobLogReference(previous, resolveJobsDir(cwd, stateDir))) {
      throw new Error("Job log reference is unverified; index removal was refused");
    }
  }
  if (process.platform === "darwin" && epoch) {
    const protectedJobs = getProtectedDarwinJobIds({ stateDir: stateDir ?? resolveStateDir(cwd), epoch });
    if (previousJobs.some(job => protectedJobs.has(job.id) && !proposedIds.has(job.id))) {
      throw new Error("Darwin lease history is still protected by its slot");
    }
    for (const previous of previousJobs) {
      if (proposedIds.has(previous.id)) continue;
      const detailFile = path.join(resolveJobsDir(cwd, stateDir), `${previous.id}.json`);
      let detail;
      try { detail = readJobFile(detailFile); }
      catch (error) { throw new Error("Darwin job detail is unavailable; index removal was refused", { cause: error }); }
      if (!verifiedDarwinJobForRemoval(previous, detail, resolveJobsDir(cwd, stateDir), previousJobs, epoch)) {
        throw new Error("Darwin job detail is unconfirmed; index removal was refused");
      }
    }
  }
  const nextJobs = process.platform === "darwin" ? (state.jobs ?? []) : pruneJobs(state.jobs ?? [], cwd, stateDir, epoch, previousJobs);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs,
    reviewGateSessions: pruneReviewGateSessions(state.reviewGateSessions, epoch)
  };

  // 索引の確定が失敗した場合は、従来の索引が参照する成果物を残す。
  writeJsonAtomic(resolveStateFile(cwd, stateDir), nextState);
  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    if (process.platform === "darwin" && job.workerLease) continue;
    if (process.platform === "linux" && (!epoch || job.epoch !== epoch)) continue;
    if (process.platform === "linux") {
      try {
        const detail = readJobFile(path.join(resolveJobsDir(cwd, stateDir), `${job.id}.json`));
        if (detail?.id !== job.id || detail.epoch !== epoch) continue;
      } catch { continue; }
    }
    for (const cleanup of [() => removeJobFile(resolveJobFile(cwd, job.id, stateDir)),
      () => removeFileIfExists(job.logFile == null ? null : path.join(resolveJobsDir(cwd, stateDir), `${job.id}.log`))]) {
      try {
        cleanup();
      } catch {
        // 索引は確定済み。削除できない履歴だけ残し、他の清掃を続ける。
        try {
          process.stderr.write("Grok history artifact cleanup failed; the committed state was retained.\n");
        } catch {
          // 診断の失敗で確定済みの更新を失敗扱いにしない。
        }
      }
    }
  }

  return nextState;
}

function resolveStateLockFile(cwd, stateDir = resolveStateDir(cwd)) {
  return path.join(stateDir, STATE_LOCK_FILE_NAME);
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
 * 年齢だけの回収は、生存する所有者や別ホストの所有者を排除できないため行わない。
 * 旧版の検査後削除との競合を防ぐため、未移行では書込みを拒否する。
 * 明示移行済みの恒久barrierだけが、native mutex経路へ進む。
 */
/** @param {{ timeoutMs?: number, strictWorkspace?: boolean }} options */
function withStateLock(cwd, run, options = {}) {
  const { timeoutMs } = options;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new TypeError("State lock timeout must be a nonnegative finite number");
  }
  const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
  const assertDeadline = () => {
    // 0は待機なしの取得を一度だけ試す。時計の読取り自体の経過で拒否しない。
    if (timeoutMs !== 0 && deadline !== undefined && performance.now() >= deadline) {
      throw new Error("Timed out acquiring Grok state lock");
    }
  };
  const remaining = () => deadline === undefined ? undefined : Math.max(0, deadline - performance.now());
  const stateDir = resolveStateDir(cwd, { ...(deadline === undefined ? {} : { deadline }), strictWorkspace: options.strictWorkspace === true });
  assertDeadline();
  const lockFile = resolveStateLockFile(cwd, stateDir);
  const migrationGuard = acquireExistingDarwinMigrationGuard(stateDir, remaining());
  try {
  // 未移行ではディレクトリ作成やchmodも行わない。旧lockには一切触れない。
  assertStateLockBarrier(stateDir, Boolean(migrationGuard));
  assertDeadline();
  const scope = inspectNativeStateLockScope(stateDir, { timeoutMs: remaining() });
  assertDeadline();
  return withInspectedNativeStateLock(stateDir, (lockedIdentity, linuxDirs, lockedProtocol, checkLocked) => {
    const perform = () => {
    assertDeadline();
    const protocol = readStateLockProtocol(lockFile, scope, lockedIdentity);
    assertDeadline();
    ensureStateDir(cwd, stateDir);
    assertDeadline();
    const verified = readStateLockProtocol(lockFile, scope, lockedIdentity);
    if ((process.platform === "linux" || process.platform === "darwin") && verified.epoch !== protocol.epoch) throw new Error("State lock epoch changed during acquisition");
    if (process.platform === "linux" && (verified.protocol !== protocol.protocol ||
        !linuxSame(verified.leaseDirectoryIdentity, protocol.leaseDirectoryIdentity) ||
        !linuxSame(verified.historyJournalIdentity, protocol.historyJournalIdentity))) throw new Error("Linux state lease or journal identity changed during acquisition");
    assertDeadline();
    let active = true;
    const context = Object.freeze({
      stateDir,
      directoryIdentity: Object.freeze({ ...lockedIdentity }),
      hostId: scope.hostId,
      volumeGuid: scope.volumeGuid ?? null,
      epoch: process.platform === "linux" || process.platform === "darwin" ? verified.epoch : null,
      protocol: process.platform === "linux" || process.platform === "darwin" ? verified.protocol : null,
      rootFd: process.platform === "linux" ? linuxDirs?.stateFd : null,
      expectedDirectoryIdentity: process.platform === "linux" ? Object.freeze({ ...verified.leaseDirectoryIdentity }) : null,
      expectedHistoryJournalIdentity: process.platform === "linux" ? Object.freeze({ ...verified.historyJournalIdentity }) : null,
      stateGeneration: process.platform === "darwin" ? verified.epoch : null,
      check() {
        if (!active) throw new Error("State lock context is no longer active");
        assertDeadline();
        assertNoDarwinLegacyMigration(stateDir);
        if (process.platform === "darwin" || process.platform === "linux") {
          const expected = process.platform === "darwin" ? "posix-local-v4" : "posix-linux-worker-lease-v6";
          if (typeof checkLocked !== "function" || lockedProtocol?.protocol !== expected) throw new Error("POSIX locked protocol identity is unavailable");
          checkLocked();
        }
        const current = readStateLockProtocol(lockFile, scope, lockedIdentity);
        if ((process.platform === "linux" || process.platform === "darwin") && current.epoch !== verified.epoch) throw new Error("State lock epoch changed");
        if (process.platform === "linux" && (current.protocol !== verified.protocol ||
            current.leaseDirectoryIdentity?.dev !== verified.leaseDirectoryIdentity?.dev ||
            current.leaseDirectoryIdentity?.ino !== verified.leaseDirectoryIdentity?.ino ||
            current.historyJournalIdentity?.dev !== verified.historyJournalIdentity?.dev ||
            current.historyJournalIdentity?.ino !== verified.historyJournalIdentity?.ino ||
            !linuxDirs || fdMountId(linuxDirs.stateFd) !== linuxDirs.mount)) throw new Error("Linux state lease identity changed");
        assertDeadline();
      }
    });
    if (process.platform === "darwin" || process.platform === "linux") context.check();
    const held = HELD_STATE_LOCK_SCOPES.get(stateDir);
    if (process.platform === "linux" && held) held.checkContext = context.check;
    if (process.platform === "linux") LINUX_HISTORY_CAPABILITIES.add(context);
    if (process.platform === "darwin") {
      DARWIN_STATE_CAPABILITIES.add(context);
      if (held) held.darwinContext = context;
    }
    try { return run(assertDeadline, stateDir, context); } finally {
      DARWIN_STATE_CAPABILITIES.delete(context);
      LINUX_HISTORY_CAPABILITIES.delete(context);
      if (held) delete held.darwinContext;
      if (held) delete held.checkContext;
      active = false;
    }
    };
    if (!migrationGuard) return perform();
    return withDarwinMigrationStateContext(migrationGuard.context, lockedIdentity, lockedProtocol, checkLocked, null, (migrationContext, token) => {
      const held = HELD_STATE_LOCK_SCOPES.get(stateDir);
      if (!held) throw new Error("Darwin migration state lock scope is unavailable");
      // 保全資料は transaction の開始時に完全照合し、その後は実 guard と
      // native mutex の identity/epoch を再検査する。同 UID による非協調変更は禁止。
      verifyDarwinMigrationCompletion(migrationGuard.context, migrationContext, token);
      held.migrationCheck = () => assertDarwinMigrationStateContext(migrationContext, migrationGuard.context);
      try { return perform(); }
      finally { delete held.migrationCheck; }
    });
  }, { timeoutMs: remaining() }, scope);
  } finally { migrationGuard?.close(); }
}

/** timeoutMs は取得待ちの予算。同期I/O・callback自体は中断できない。 */
export function updateState(cwd, mutate, options) {
  if (typeof mutate !== "function" || types.isAsyncFunction(mutate)) throw new TypeError("State mutator must be synchronous");
  if (options?.afterSave !== undefined && (typeof options.afterSave !== "function" || types.isAsyncFunction(options.afterSave))) {
    throw new TypeError("State afterSave callback must be synchronous");
  }
  return withStateLock(cwd, (assertDeadline, stateDir, context) => {
    const state = loadState(cwd, stateDir);
    assertDeadline();
    // callback が配列や要素を書き換えても、削除対象は更新前の値を維持する。
    const previousJobs = state.jobs.map((job) => ({ ...job }));
    let called = false;
    let duplicate = false;
    let completed = false;
    let stateCommitted = false;
    let stateWriteStarted = false;
    let commitFailed = false;
    let active = true;
    let commitError;
    const commit = () => {
      if (!active) throw new Error("State commit capability is no longer active");
      context.check();
      if (called) {
        duplicate = true;
        throw new Error("State aroundCommit callback may commit only once");
      }
      called = true;
      try {
        const mutationResult = mutate(state, context);
        if (mutationResult && typeof mutationResult.then === "function") {
          void Promise.resolve(mutationResult).catch(() => {});
          throw new TypeError("State mutator must be synchronous");
        }
        context.check();
        stateWriteStarted = true;
        const saved = saveStateWithPreviousJobs(cwd, state, previousJobs, stateDir, context.epoch);
        stateCommitted = true;
        if (options?.afterSave) {
          context.check();
          const result = options.afterSave(saved, context);
          if (result && typeof result.then === "function") {
            void Promise.resolve(result).catch(() => {});
            throw new TypeError("State afterSave callback must be synchronous");
          }
        }
        completed = true;
        return saved;
      } catch (error) {
        commitFailed = true;
        commitError = error;
        throw error;
      }
    };
    try {
      if (options?.aroundCommit === undefined) return commit();
      if (typeof options.aroundCommit !== "function" || types.isAsyncFunction(options.aroundCommit)) {
        throw new TypeError("State aroundCommit callback must be synchronous");
      }
      const result = options.aroundCommit(state, context, commit);
      active = false;
      if (result && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new TypeError("State aroundCommit callback must be synchronous");
      }
      if (commitFailed) throw commitError;
      if (!called || duplicate || !completed) throw new Error("State aroundCommit callback must commit exactly once");
      return result;
    } catch (error) {
      if (!stateCommitted && !stateWriteStarted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      /** @type {Error & { stateCommitted?: boolean, stateCommitOutcome?: string }} */
      const failure = new Error(stateCommitted
        ? `State update was committed, but a follow-up failed: ${message}`
        : `State commit outcome is unknown; inspect state before retrying: ${message}`, { cause: error });
      if (stateCommitted) failure.stateCommitted = true;
      else failure.stateCommitOutcome = "unknown";
      throw failure;
    } finally { active = false; }
  }, options);
}

/** 最新状態の検査と同期enqueueを更新と直列化する。応答待ち・状態保存は行わない。 */
export function withStateSnapshot(cwd, inspect, options) {
  return withStateLock(cwd, (assertDeadline, stateDir, context) => {
    const state = loadState(cwd, stateDir);
    assertDeadline();
    return inspect(state, context);
  }, options);
}

/**
 * 同じOSのsocket namespace内でだけ有効な排他名。
 * 共有ディスクを複数hostから更新するための分散lockではない。
 * Windows専用。NTFS directoryのvolume serial/file IDを使う。
 */
export function resolveNativeStateLockEndpoint(stateDir, { platform = process.platform } = {}) {
  if (platform !== "win32") {
    throw new Error(`Unsupported native state lock platform: ${platform}`);
  }
  const identity = readNativeStateLockIdentity(stateDir);
  return nativeStateLockEndpoint(stateDir, platform, identity);
}

function readNativeStateLockIdentity(stateDir) {
  const stat = fs.statSync(stateDir, { bigint: true });
  if (!stat.isDirectory() || typeof stat.dev !== "bigint" || typeof stat.ino !== "bigint" || stat.dev <= 0n || stat.ino <= 0n) {
    throw new Error(`Native state directory identity is unavailable: ${stateDir}`);
  }
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameStateLockIdentity(left, right) {
  return Boolean(left && right && /^[1-9][0-9]*$/.test(left.dev) && /^[1-9][0-9]*$/.test(left.ino)
    && typeof left.dev === "string" && typeof left.ino === "string" && left.dev === right.dev && left.ino === right.ino);
}

function canonicalStateLockVolumeGuid(value) {
  return typeof value === "string" && /^\\\\\?\\Volume\{[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\}\\$/i.test(value)
    ? value.toLowerCase() : undefined;
}

function nativeStateLockEndpoint(stateDir, platform, identity) {
  if (platform !== "win32") {
    throw new Error(`Unsupported native state lock platform: ${platform}`);
  }
  const name = `windows-directory-v2:${identity.dev}:${identity.ino}`;
  const digest = createHash("sha256").update(name).digest("hex");
  return `\\\\.\\pipe\\grok-state-v2-${digest}`;
}

/**
 * 移行済みの単一host保存先向けの独立mutex。未移行stateは明示移行を必須とする。
 * Windows named pipeはowner死亡時にkernelが解放する。
 * callbackは同期処理に限る。同期bindできないruntimeではcallbackへ入らず失敗する。
 */
export function withNativeStateLock(stateDir, run, { timeoutMs = STATE_LOCK_RETRY_LIMIT * STATE_LOCK_RETRY_INTERVAL_MS } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("Native state lock timeout must be a nonnegative finite number");
  }
  if (process.platform !== "win32") throw new Error(`Unsupported native state lock platform: ${process.platform}`);
  // 低level primitiveの0ms取得を維持する。state writerは検証済みscopeで内部入口を使う。
  return withInspectedNativeStateLock(stateDir, run, { timeoutMs });
}

function withInspectedNativeStateLock(stateDir, run, { timeoutMs = STATE_LOCK_RETRY_LIMIT * STATE_LOCK_RETRY_INTERVAL_MS } = {}, scope = undefined) {
  if ((process.platform === "linux" || process.platform === "darwin") && scope) {
    return withPosixStateLock(stateDir, scope, (identity, linuxDirs, lockedProtocol, checkLocked) => {
      const previous = HELD_STATE_LOCK_SCOPES.get(stateDir);
      HELD_STATE_LOCK_SCOPES.set(stateDir, { scope, identity, linuxDirs });
      try { return run(identity, linuxDirs, lockedProtocol, checkLocked); } finally {
        if (previous) HELD_STATE_LOCK_SCOPES.set(stateDir, previous);
        else HELD_STATE_LOCK_SCOPES.delete(stateDir);
      }
    }, { timeoutMs });
  }
  if (process.platform !== "win32") throw new Error(`Unsupported native state lock platform: ${process.platform}`);
  const identity = process.platform === "win32" ? readNativeStateLockIdentity(stateDir) : undefined;
  if (process.platform === "win32" && scope?.directoryIdentity && !sameStateLockIdentity(scope.directoryIdentity, identity)) {
    throw new Error("Native state directory identity changed after filesystem inspection");
  }
  const endpoint = nativeStateLockEndpoint(stateDir, process.platform, identity);
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const server = net.createServer(socket => socket.destroy());
    // listenの失敗通知は次tickになる。同期関数での取得成否はlisteningで確認する。
    server.on("error", () => {});
    try {
      // clusterでも共有handleに転送せず、このprocess自身がbindする。
      server.listen({ path: endpoint, exclusive: true });
      if (server.listening) {
        server.unref();
        const previous = HELD_STATE_LOCK_SCOPES.get(stateDir);
        if (identity && scope) HELD_STATE_LOCK_SCOPES.set(stateDir, { scope, identity });
        try {
          return run(identity);
        } finally {
          if (previous) HELD_STATE_LOCK_SCOPES.set(stateDir, previous);
          else HELD_STATE_LOCK_SCOPES.delete(stateDir);
        }
      }
    } finally {
      server.close();
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    Atomics.wait(SLEEP_SIGNAL, 0, 0, Math.min(remaining, STATE_LOCK_RETRY_INTERVAL_MS));
  }
  // Nodeはbind失敗のerrnoを次tickで通知するため、同期区間では競合と権限拒否を
  // 識別できない。所有者が存在すると断定したtimeout診断にはしない。
  throw new Error(`Native state lock acquisition failed within ${timeoutMs}ms; contention or a bind permission/path error is possible: ${stateDir}`);
}

function canonicalStateLockPath(stateDir) {
  const missing = [];
  let ancestor = stateDir;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot resolve state lock directory: ${stateDir}`);
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(fs.realpathSync.native(ancestor), ...missing);
}

// Add-Type/compiler/tempを使わず、同じdirectory handleからfilesystemとidentityを読む。
const WINDOWS_STATE_SCOPE_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('StateVolumeProbe'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$module=$assembly.DefineDynamicModule('Native')
$infoBuilder=$module.DefineType('StateFileInformation',[Reflection.TypeAttributes]'Public,Sealed,SequentialLayout',[ValueType])
foreach($name in @('Attributes','CreationLow','CreationHigh','AccessLow','AccessHigh','WriteLow','WriteHigh','VolumeSerial','SizeHigh','SizeLow','Links','IndexHigh','IndexLow')){$null=$infoBuilder.DefineField($name,[uint32],[Reflection.FieldAttributes]::Public)}
$infoType=$infoBuilder.CreateType()
if([Runtime.InteropServices.Marshal]::SizeOf([type]$infoType)-ne 52){throw 'Invalid identity structure'}
$builder=$module.DefineType('StateNative',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
$specs=@(
@{Name='CreateFileW';Return=[Microsoft.Win32.SafeHandles.SafeFileHandle];Args=[type[]]@([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr])},
@{Name='GetFileInformationByHandle';Return=[bool];Args=[type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle],$infoType.MakeByRefType())},
@{Name='GetVolumeInformationByHandleW';Return=[bool];Args=[type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle],[Text.StringBuilder],[uint32],[uint32].MakeByRefType(),[uint32].MakeByRefType(),[uint32].MakeByRefType(),[Text.StringBuilder],[uint32])},
@{Name='GetFinalPathNameByHandleW';Return=[uint32];Args=[type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle],[Text.StringBuilder],[uint32],[uint32])},
@{Name='GetDriveTypeW';Return=[uint32];Args=[type[]]@([string])})
$attributeType=[Runtime.InteropServices.DllImportAttribute]
foreach($spec in $specs){
$method=$builder.DefineMethod($spec.Name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',$spec.Return,$spec.Args)
$attribute=[Reflection.Emit.CustomAttributeBuilder]::new($attributeType.GetConstructor([type[]]@([string])),[object[]]@('kernel32.dll'),[Reflection.FieldInfo[]]@($attributeType.GetField('SetLastError'),$attributeType.GetField('CharSet'),$attributeType.GetField('CallingConvention'),$attributeType.GetField('ExactSpelling')),[object[]]@($true,[Runtime.InteropServices.CharSet]::Unicode,[Runtime.InteropServices.CallingConvention]::Winapi,$true))
$method.SetCustomAttribute($attribute)
}
$native=$builder.CreateType()
$handle=$native.GetMethod('CreateFileW').Invoke($null,[object[]]@($env:GROK_STATE_INSPECT_PATH,[uint32]0,[uint32]7,[IntPtr]::Zero,[uint32]3,[uint32]0x02000000,[IntPtr]::Zero))
if($handle.IsInvalid){$handle.Dispose();throw 'Directory open failed'}
try{
$argsInfo=[object[]]@($handle,[Activator]::CreateInstance($infoType))
if(-not $native.GetMethod('GetFileInformationByHandle').Invoke($null,$argsInfo)){throw 'Directory identity failed'}
$info=$argsInfo[1]
if(($info.Attributes-band 16)-eq 0){throw 'Target is not a directory'}
$fs=[Text.StringBuilder]::new(261)
$argsVolume=[object[]]@($handle,[Text.StringBuilder]::new(261),[uint32]261,[uint32]0,[uint32]0,[uint32]0,$fs,[uint32]261)
if(-not $native.GetMethod('GetVolumeInformationByHandleW').Invoke($null,$argsVolume)){throw 'Volume inspection failed'}
$final=[Text.StringBuilder]::new(32768)
$length=$native.GetMethod('GetFinalPathNameByHandleW').Invoke($null,[object[]]@($handle,$final,[uint32]32768,[uint32]1))
if($length-eq 0-or $length-ge 32768){throw 'Volume GUID unavailable'}
$value=$final.ToString()
if(-not $value.StartsWith('\\?\Volume{',[StringComparison]::OrdinalIgnoreCase)){throw 'Non-local volume'}
$end=$value.IndexOf('}\')
if($end-lt 0){throw 'Invalid volume GUID'}
$volume=$value.Substring(0,$end+2)
$drive=$native.GetMethod('GetDriveTypeW').Invoke($null,[object[]]@($volume))
$index=[uint64]([uint64]$info.IndexHigh*4294967296+[uint64]$info.IndexLow)
$guid=Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid
@{machineGuid=[string]$guid;fileSystem=$fs.ToString();driveType=[int]$drive;volumeGuid=$volume;directoryIdentity=@{dev=$info.VolumeSerial.ToString([Globalization.CultureInfo]::InvariantCulture);ino=$index.ToString([Globalization.CultureInfo]::InvariantCulture)}}|ConvertTo-Json -Compress
}finally{$handle.Dispose()}`;

/** MachineGuidは別IDの検出補助。cloneの識別や他host不在の証明には使わない。 */
/** @param {{ timeoutMs?: number }} options */
function inspectNativeStateLockScope(stateDir, options = {}) {
  const { timeoutMs } = options;
  if (process.platform === "linux" || process.platform === "darwin") return inspectPosixStateLockScope(stateDir, options);
  if (process.platform !== "win32") {
    throw new Error(`State lock migration is unsupported on this platform: ${process.platform}`);
  }
  const canonical = canonicalStateLockPath(stateDir).replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  if (canonical.startsWith("\\\\")) {
    throw new Error("Native state locks require a local fixed drive; UNC/shared state directories are unsupported");
  }
  const root = path.win32.parse(canonical).root;
  if (!/^[a-z]:\\$/i.test(root)) throw new Error("Native state lock volume identity is unavailable");
  let ancestor = stateDir;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("Native state directory identity is unavailable");
    ancestor = parent;
  }
  const expectedIdentity = readNativeStateLockIdentity(ancestor);
  const existingPath = fs.realpathSync.native(ancestor);
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new Error("Timed out acquiring Grok state lock before host/volume inspection");
  }
  let inspection;
  try {
    const powershell = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const output = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_STATE_SCOPE_SCRIPT, "utf16le").toString("base64")], {
      encoding: "utf8", windowsHide: true, timeout: Math.min(5000, Math.ceil(timeoutMs ?? 5000)), maxBuffer: 16384,
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GROK_STATE_INSPECT_PATH: existingPath }
    });
    inspection = JSON.parse(output.replace(/^\uFEFF/, "").trim());
  } catch {
    // 診断へregistry値や子process出力を転載しない。
    throw new Error("Native state lock host/volume identity could not be verified");
  }
  if (inspection.driveType !== 3) {
    throw new Error("Native state locks require a local fixed drive; shared/network/unknown volumes are unsupported");
  }
  if (inspection.fileSystem !== "NTFS") {
    throw new Error("Native state locks require the actual directory filesystem to be NTFS; FAT, ReFS and unknown filesystems are unsupported");
  }
  const volumeGuid = canonicalStateLockVolumeGuid(inspection.volumeGuid);
  if (!volumeGuid) {
    throw new Error("Native state lock volume GUID could not be verified");
  }
  if (!sameStateLockIdentity(inspection.directoryIdentity, expectedIdentity)
      || !sameStateLockIdentity(expectedIdentity, readNativeStateLockIdentity(ancestor))) {
    throw new Error("Native state directory identity changed or does not match the inspected volume handle");
  }
  if (typeof inspection.machineGuid !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(inspection.machineGuid.trim())) {
    throw new Error("Native state lock host identity is unavailable");
  }
  return {
    hostId: createHash("sha256").update(`windows-machineguid:${inspection.machineGuid.trim().toLowerCase()}`).digest("hex"),
    directoryIdentity: expectedIdentity,
    volumeGuid
  };
}

function acquireExistingDarwinMigrationGuard(stateDir, timeoutMs = undefined) {
  if (process.platform !== "darwin") return null;
  const dir = path.join(stateDir, ".darwin-legacy-migration");
  try { fs.lstatSync(dir); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  // runtime は欠けた guard を作り直さない。
  const guard = fs.lstatSync(path.join(dir, "native.lock"));
  if (!guard.isFile() || guard.isSymbolicLink()) throw new Error("Darwin migration guard is invalid");
  return acquireDarwinMigrationGuard(stateDir, timeoutMs === undefined ? 7500 : Math.max(1, timeoutMs));
}

function assertNoDarwinLegacyMigration(stateDir) {
  if (process.platform !== "darwin") return;
  const held = HELD_STATE_LOCK_SCOPES.get(stateDir);
  if (held?.migrationCheck) { held.migrationCheck(); return; }
  if (held) {
    try { fs.lstatSync(path.join(stateDir, ".darwin-legacy-migration")); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    throw new Error("Darwin migration appeared after state mutex acquisition");
  }
  const guard = acquireExistingDarwinMigrationGuard(stateDir);
  if (!guard) return;
  try {
    const scope = inspectPosixStateLockScope(stateDir);
    if (scope.hostId !== guard.context.hostId) throw new Error("Darwin migration host changed");
    withPosixStateLock(stateDir, scope, (identity, _dirs, protocol, checkLocked) =>
      withDarwinMigrationStateContext(guard.context, identity, protocol, checkLocked, null,
        (context, token) => verifyDarwinMigrationCompletion(guard.context, context, token)), { timeoutMs: 7500 });
  } finally { guard.close(); }
}

/** 書込み準備前の読取り専用検査。旧形式を作成・回収・置換しない。 */
function assertStateLockBarrier(stateDir, guardHeld = false) {
  if (!guardHeld) assertNoDarwinLegacyMigration(stateDir);
  if (!["win32", "linux", "darwin"].includes(process.platform)) {
    throw new Error(`State lock migration is unsupported on this platform: ${process.platform}`);
  }
  const lockDir = path.join(stateDir, STATE_LOCK_FILE_NAME);
  let stat;
  try {
    stat = fs.lstatSync(lockDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Grok state lock requires explicit offline migration; existing state and legacy locks were left untouched.\nState directory (data): ${stateDir}\nRun state-lock migrate --offline-confirmed --local-only --expected-state-dir <absolute-state-directory> after stopping every old runtime and keeping it stopped.\nReplace the placeholder with the state directory above, quoted appropriately for your shell.`);
  }
  return lockDir;
}

/** @param {{ timeoutMs?: number }} options */
function requireStateLockMigration(stateDir, options = {}) {
  const { timeoutMs } = options;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new TypeError("State migration guard timeout must be a nonnegative finite number");
  }
  const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
  const assertDeadline = () => {
    if (deadline !== undefined && performance.now() >= deadline) throw new Error("Timed out verifying Grok state lock migration");
  };
  assertDeadline();
  const lockDir = assertStateLockBarrier(stateDir);
  assertDeadline();
  const held = HELD_STATE_LOCK_SCOPES.get(stateDir);
  if (held) {
    readStateLockProtocol(lockDir, held.scope, held.identity);
    assertDeadline();
    return;
  }
  const scope = inspectNativeStateLockScope(stateDir, { timeoutMs: deadline === undefined ? undefined : Math.max(0, deadline - performance.now()) });
  assertDeadline();
  readStateLockProtocol(lockDir, scope);
  assertDeadline();
}

export { requireStateLockMigration };

/**
 * broker等の同期処理向けの短命な読取り検証。mutexの所有や相互排他を意味しない。
 * checkは副作用の直前に呼び、callback外・Promiseへ持ち出してはならない。
 * @param {{ timeoutMs?: number }} options
 */
export function withStateLockMigrationScope(stateDir, run, options = {}) {
  const { timeoutMs } = options;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new TypeError("State migration scope timeout must be a nonnegative finite number");
  }
  const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
  const assertDeadline = () => {
    if (deadline !== undefined && performance.now() >= deadline) throw new Error("Timed out verifying Grok state lock migration scope");
  };
  assertDeadline();
  const lockDir = assertStateLockBarrier(stateDir);
  assertDeadline();
  // HELD_STATE_LOCK_SCOPESは参照・登録しない。開始ごとに実handleを照会する。
  const scope = inspectNativeStateLockScope(stateDir, { timeoutMs: deadline === undefined ? undefined : Math.max(0, deadline - performance.now()) });
  assertDeadline();
  const identity = scope.directoryIdentity ?? readNativeStateLockIdentity(stateDir);
  const initialProtocol = readStateLockProtocol(lockDir, scope, identity);
  let active = true;
  const check = () => {
    if (!active) throw new Error("State migration scope check has expired; only synchronous callback use is allowed");
    assertDeadline();
    assertNoDarwinLegacyMigration(stateDir);
    const current = readStateLockProtocol(lockDir, scope, identity);
    if ((process.platform === "linux" || process.platform === "darwin") && current.epoch !== initialProtocol.epoch) throw new Error("State lock epoch changed");
    assertDeadline();
  };
  Object.defineProperty(check, "epoch", { value: process.platform === "linux" || process.platform === "darwin" ? initialProtocol.epoch : null });
  Object.freeze(check);
  try {
    check();
    const result = run(check);
    if (result && typeof result.then === "function") throw new TypeError("State migration scope callback must be synchronous; thenable results are not allowed");
    check();
    return result;
  } finally {
    active = false;
  }
}

function readStateLockProtocol(lockDir, scope, lockedIdentity = undefined) {
  if (process.platform === "linux" || process.platform === "darwin") {
    const parsed = readPosixStateLockProtocol(lockDir, scope, lockedIdentity);
    if (process.platform === "linux" && (typeof parsed?.epoch !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.epoch))) {
      throw new Error("Linux state lock epoch is missing or invalid; offline recovery is required");
    }
    return parsed;
  }
  const marker = path.join(lockDir, STATE_LOCK_PROTOCOL_FILE_NAME);
  let parsed;
  try {
    const stat = fs.lstatSync(marker);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("invalid protocol file");
    parsed = JSON.parse(fs.readFileSync(marker, "utf8"));
  } catch {
    throw new Error(`State lock migration protocol is incomplete or invalid; rerun the explicit offline migration: ${lockDir}`);
  }
  if (parsed?.protocol !== NATIVE_STATE_LOCK_PROTOCOL || parsed?.localOnly !== true) {
    throw new Error(`Unsupported state lock protocol: ${lockDir}`);
  }
  if (!scope?.hostId || parsed.hostId !== scope.hostId) {
    throw new Error(`Native state lock belongs to a different or unknown host: ${lockDir}`);
  }
  const markerVolumeGuid = canonicalStateLockVolumeGuid(parsed.volumeGuid);
  if (!markerVolumeGuid || markerVolumeGuid !== canonicalStateLockVolumeGuid(scope.volumeGuid)) {
    throw new Error(`Native state volume identity is missing, invalid or belongs to a different volume: ${lockDir}`);
  }
  const currentIdentity = readNativeStateLockIdentity(path.dirname(lockDir));
  if (!sameStateLockIdentity(parsed.directoryIdentity, currentIdentity)
      || (lockedIdentity !== undefined && !sameStateLockIdentity(lockedIdentity, currentIdentity))) {
    throw new Error(`Native state directory identity changed or does not match its migration protocol: ${lockDir}`);
  }
  return parsed;
}

function verifyNativeStateLockCapability(stateDir) {
  const endpoint = `${resolveNativeStateLockEndpoint(stateDir)}-probe-${randomUUID()}`;
  const servers = [];
  const bind = () => {
    const server = net.createServer(socket => socket.destroy());
    server.on("error", () => {});
    servers.push(server);
    server.listen({ path: endpoint, exclusive: true });
    return server;
  };
  try {
    const first = bind();
    if (!first.listening || bind().listening) throw new Error("Native synchronous lock capability is unavailable");
    first.close();
    if (!bind().listening) throw new Error("Native same-tick lock release capability is unavailable");
  } finally {
    for (const server of servers) if (server.listening) server.close();
  }
}

/**
 * 旧runtimeの全停止と再起動禁止、他hostと同時利用しないことは呼出者の明示前提。
 * 自動検出による保証ではない。旧lock fileの削除や移行のrollback削除は行わない。
 */
export function migrateStateLock(cwd, { offlineConfirmed = false, localOnly = false, allOldProcessesStopped = false, expectedStateDir = undefined, onDarwinMigrationStep = undefined } = {}) {
  if (offlineConfirmed !== true || localOnly !== true) {
    throw new Error("Explicit offline confirmation is required: stop every old runtime and keep it stopped; --local-only confirms that no other host will concurrently use this state directory");
  }
  if (process.platform === "linux" || process.platform === "darwin") {
    const stateDir = resolveStateDir(cwd);
    if (process.platform === "darwin") {
      let legacy;
      try { legacy = fs.lstatSync(path.join(stateDir, STATE_LOCK_FILE_NAME)); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      let evidence;
      try { evidence = fs.lstatSync(path.join(stateDir, ".darwin-legacy-migration")); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if ((legacy?.isFile() && !legacy.isSymbolicLink()) || evidence) {
        if (allOldProcessesStopped !== true) {
          throw new Error("Darwin legacy file-lock migration requires --all-old-processes-stopped; existing state was left untouched");
        }
        if (typeof expectedStateDir !== "string" || !path.isAbsolute(expectedStateDir) || expectedStateDir !== stateDir) {
          throw new Error("Darwin legacy migration requires the exact absolute state directory; existing state was left untouched");
        }
        // 固定呼び出しは completion と consumer が揃うまで実行しない。
        const completionProtocolAvailable = false;
        if (!completionProtocolAvailable) throw new Error("Darwin migration completion evidence is unavailable; existing state was left untouched");
        const guard = acquireDarwinMigrationGuard(stateDir);
        try {
          const guardContext = guard.context;
          const preflightToken = verifyDarwinLegacyPreflight({ stateDir, guardContext });
          const offlineAuthorization = Object.freeze({});
          DARWIN_LEGACY_OFFLINE_AUTHORIZATIONS.set(offlineAuthorization, { stateDir, guardContext, preflightToken });
          try {
            writeDarwinMigrationManifest(guardContext, preflightToken, offlineAuthorization);
            prepareDarwinLegacyLockBackup(guardContext, preflightToken, offlineAuthorization);
            releaseDarwinLegacyLockName(guardContext, preflightToken, offlineAuthorization);
            const migrated = prepareDarwinLegacyBarrier({ stateDir, guardContext, preflightToken, offlineAuthorization,
              expectedStateDir, offlineConfirmed, localOnly });
            finalizeDarwinLegacyMigration(stateDir, guardContext, preflightToken);
            return migrated;
          } finally { DARWIN_LEGACY_OFFLINE_AUTHORIZATIONS.delete(offlineAuthorization); }
        } finally { guard.close(); }
      }
    }
    const migrationOptions = { expectedStateDir, onDarwinMigrationStep,
      ...(process.platform === "linux" ? { prepareLinuxGeneration: (context) => {
        const root = { fd: context.rootFd, mount: fdMountId(context.rootFd), identity: context.directoryIdentity, check: context.check };
        assertNoLinuxIndexTemp(root);
        withLinuxJobs(root, () => {}, true);
        const statePath = linuxAt(root.fd, STATE_FILE_NAME);
        let exists = true;
        try { fs.lstatSync(statePath, { bigint: true }); }
        catch (error) { if (error?.code === "ENOENT") exists = false; else throw error; }
        if (!exists) {
          withLinuxJobs(root, jobs => {
            if (fs.readdirSync(linuxAt(jobs.fd, ".")).length) throw new Error("Existing job records without state require offline recovery");
          });
          linuxWriteRecord(root, STATE_FILE_NAME, `${JSON.stringify(defaultState(), null, 2)}\n`);
        } else {
          const parsed = JSON.parse(linuxReadRecord(root, STATE_FILE_NAME));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.jobs)) throw new Error("Existing Linux state jobs are invalid");
        }
        initializeLinuxLeaseLedger({ context });
      } } : {}),
      ...(process.platform === "darwin" ? { prepareDarwinGeneration: generation => prepareDarwinStateGeneration(stateDir, generation) } : {}) };
    if (process.platform !== "darwin") return migratePosixStateLock(stateDir, migrationOptions);
    const authorization = Object.freeze({});
    DARWIN_MIGRATION_AUTHORIZATIONS.set(authorization, { stateDir, prepare: migrationOptions.prepareDarwinGeneration });
    try { return migratePosixStateLock(stateDir, { ...migrationOptions, darwinAuthorization: authorization }); }
    finally { DARWIN_MIGRATION_AUTHORIZATIONS.delete(authorization); }
  }
  if (process.platform !== "win32") {
    throw new Error(`State lock migration is unsupported on this platform: ${process.platform}`);
  }
  const stateDir = resolveStateDir(cwd);
  if (expectedStateDir !== undefined) {
    if (typeof expectedStateDir !== "string" || !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(expectedStateDir)) {
      throw new Error("Expected state directory must be an absolute path (--expected-state-dir)");
    }
    const identity = value => path.win32.normalize(canonicalStateLockPath(value)).replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").toLowerCase();
    if (identity(expectedStateDir) !== identity(stateDir)) {
      throw new Error(`Expected state directory does not match the effective state directory; no migration was performed. Expected: ${expectedStateDir}; effective: ${stateDir}. Use the host's reported state directory and matching host data environment`);
    }
  }
  inspectNativeStateLockScope(stateDir);
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const scope = inspectNativeStateLockScope(stateDir);
  const volumeGuid = canonicalStateLockVolumeGuid(scope.volumeGuid);
  if (!volumeGuid) throw new Error("Native state lock volume GUID could not be verified");
  verifyNativeStateLockCapability(stateDir);
  const migrated = withInspectedNativeStateLock(stateDir, (lockedIdentity) => {
    if (!sameStateLockIdentity(lockedIdentity, readNativeStateLockIdentity(stateDir))) throw new Error("Native state directory identity changed during migration");
    const lockDir = resolveStateLockFile(cwd, stateDir);
    let existing;
    try { existing = fs.lstatSync(lockDir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
      throw new Error(`Existing legacy/symbolic state lock was left untouched; offline recovery is required: ${lockDir}`);
    }
    if (existing) {
      const marker = path.join(lockDir, STATE_LOCK_PROTOCOL_FILE_NAME);
      if (fs.existsSync(marker)) {
        return readStateLockProtocol(lockDir, scope, lockedIdentity);
      }
      for (const entry of fs.readdirSync(lockDir)) {
        const stat = fs.lstatSync(path.join(lockDir, entry));
        if (!/^prepared-[a-zA-Z0-9-]+\.json$/.test(entry) || stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`Unknown state lock migration artifact was left untouched: ${lockDir}`);
        }
      }
    } else {
      // この時点で旧writerがwxに成功していればmkdirが失敗し、置換しない。
      fs.mkdirSync(lockDir, { mode: 0o700 });
    }
    const payload = { protocol: NATIVE_STATE_LOCK_PROTOCOL, localOnly: true, hostId: scope.hostId, directoryIdentity: lockedIdentity, volumeGuid };
    const prepared = path.join(lockDir, `prepared-${randomUUID()}.json`);
    const handle = fs.openSync(prepared, "wx", 0o600);
    try {
      fs.writeFileSync(handle, `${JSON.stringify(payload)}\n`, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    try {
      // 原子的なno-replace公開。preparedは途中失敗後も再利用・上書き・削除しない。
      fs.linkSync(prepared, path.join(lockDir, STATE_LOCK_PROTOCOL_FILE_NAME));
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return readStateLockProtocol(lockDir, scope, lockedIdentity);
    }
    return readStateLockProtocol(lockDir, scope, lockedIdentity);
  }, {}, scope);
  return { ...migrated, stateDir };
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

export function writeJobFile(cwd, jobId, payload, context = undefined) {
  assertDarwinJobIdentifier(jobId);
  if (context) {
    if (process.platform === "darwin") assertDarwinPruneContext(context);
    else if (process.platform === "linux") assertLinuxHistoryContext(context);
    else context.check();
  }
  const stateDir = context?.stateDir ?? resolveStateDir(cwd);
  let darwinContext;
  if (process.platform === "darwin") {
    darwinContext = HELD_STATE_LOCK_SCOPES.get(stateDir)?.darwinContext;
    assertDarwinPruneContext(darwinContext);
  }
  ensureStateDir(cwd, stateDir);
  const jobFile = resolveJobFile(cwd, jobId, stateDir);
  if (process.platform === "darwin") assertDarwinPruneContext(darwinContext);
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
    if (process.platform === "linux") {
      const jobsDir = path.dirname(jobFile), stateDir = path.dirname(jobsDir), name = path.basename(jobFile);
      if (path.basename(jobsDir) !== JOBS_DIR_NAME || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(name)) throw new Error("Linux job record path is invalid");
      requireStateLockMigration(stateDir);
      return JSON.parse(withLinuxRoot(stateDir, root => withLinuxJobs(root, directory => linuxReadRecord(directory, name))));
    }
    if (process.platform !== "darwin") return JSON.parse(fs.readFileSync(jobFile, "utf8"));
    const before = fs.lstatSync(jobFile, { bigint: true });
    if (!validDarwinRecordStat(before)) throw new Error("Darwin job record is not a verified bounded regular file");
    const fd = fs.openSync(jobFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!validDarwinRecordStat(opened) || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Darwin job record changed before read");
      const result = JSON.parse(fs.readFileSync(fd, "utf8"));
      fs.fsyncSync(fd);
      syncDarwinDirectory(path.dirname(jobFile));
      const after = fs.fstatSync(fd, { bigint: true });
      const named = fs.lstatSync(jobFile, { bigint: true });
      if (!validDarwinRecordStat(named) || !validDarwinRecordStat(after) || named.dev !== opened.dev || named.ino !== opened.ino ||
          after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) throw new Error("Darwin job record changed during read");
      return result;
    } finally { fs.closeSync(fd); }
  } catch (error) {
    throw new Error(`Grok job record is corrupt: ${jobFile}`, { cause: error });
  }
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

function assertDarwinJobIdentifier(jobId) {
  if (process.platform !== "darwin") return;
  if (typeof jobId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(jobId) || Buffer.byteLength(jobId, "utf8") > 200) {
    throw new Error("Invalid state job identifier");
  }
}

export function resolveJobLogFile(cwd, jobId) {
  assertDarwinJobIdentifier(jobId);
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId, stateDir = resolveStateDir(cwd)) {
  assertDarwinJobIdentifier(jobId);
  ensureStateDir(cwd, stateDir);
  return path.join(resolveJobsDir(cwd, stateDir), `${jobId}.json`);
}
