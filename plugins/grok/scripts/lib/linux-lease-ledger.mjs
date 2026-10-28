import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fdMountId } from "./linux-epoch-recovery.mjs";
import { acquireLinuxWorkerLease, releaseLinuxWorkerLease, validateOwnedLinuxWorkerLease,
  withAvailableLinuxLease, LINUX_LEASE_SLOT_COUNT } from "./linux-worker-lease.mjs";
import { assertLinuxHistoryContext, linuxControlCapacityReserve, updateState, withStateSnapshot, writeJobFile } from "./state.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const PROTOCOL = "linux-lease-ledger-v1";
const NAMESPACE = "worker-leases-v1";
const LEDGER = "ledger.json";
const PREPARED = "ledger.prepared";
const RECORD_LIMIT = 64 * 1024 * 1024;
const LEASE_KEYS = ["id", "path", "dev", "ino", "stateGeneration", "slot"];
const stamps = new WeakMap();
const at = (fd, name) => `/proc/self/fd/${fd}/${name}`;
const same = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
const ident = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const validId = id => typeof id === "string" && Buffer.byteLength(id) <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
const only = (value, keys) => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)));
const validIdent = value => value && typeof value.dev === "string" && DECIMAL.test(value.dev) && typeof value.ino === "string" && DECIMAL.test(value.ino);
const sameLease = (a, b) => Boolean(a && b && LEASE_KEYS.every(key => a[key] === b[key]));
const slotName = (slot, extension) => `slot-${String(slot).padStart(3, "0")}.${extension}`;
const stamp = stat => ({ ...ident(stat), size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
const sameStamp = (a, b) => same(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function checked(stat, directory) {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o077n) !== 0n || stat.dev <= 0n || stat.ino <= 0n || (!directory && stat.nlink !== 1n)) {
    throw new Error("Linux lease ledger identity or permissions are invalid");
  }
  return ident(stat);
}
function flags(directory = false) {
  const { O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;
  if (process.platform !== "linux" || typeof process.getuid !== "function" || !O_NOFOLLOW || !O_NONBLOCK || !O_DIRECTORY) {
    throw new Error("Linux lease ledger requires no-follow directory opens");
  }
  return O_NOFOLLOW | O_NONBLOCK | (directory ? O_DIRECTORY : 0);
}
function synchronous(value) {
  if (value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function") {
    void Promise.resolve(value).catch(() => {});
    throw new TypeError("Linux lease ledger check must be synchronous");
  }
}
function openDir(parent, name, mount, expected) {
  const target = at(parent, name);
  const before = checked(fs.lstatSync(target, { bigint: true }), true);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | flags(true));
  try {
    if (fdMountId(fd) !== mount || !same(before, checked(fs.fstatSync(fd, { bigint: true }), true))
        || (expected && !same(before, expected))) throw new Error("Linux lease directory identity or mount changed");
    return { fd, target, identity: before };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function withScope(context, run) {
  flags(true);
  if (!context || context.protocol !== "posix-linux-worker-lease-v6" || !UUID.test(context.epoch ?? "")
      || !path.isAbsolute(context.stateDir ?? "") || path.resolve(context.stateDir) !== context.stateDir
      || !Number.isSafeInteger(context.rootFd) || context.rootFd < 0 || typeof context.check !== "function"
      || !validIdent(context.directoryIdentity) || !validIdent(context.expectedDirectoryIdentity)) throw new Error("Linux lease context is invalid");
  const root = checked(fs.fstatSync(context.rootFd, { bigint: true }), true);
  if (!same(root, context.directoryIdentity)) throw new Error("Linux lease root changed");
  const mount = fdMountId(context.rootFd);
  const namespace = openDir(context.rootFd, NAMESPACE, mount);
  try {
    const directory = openDir(namespace.fd, context.epoch, mount, context.expectedDirectoryIdentity);
    try {
      const check = () => {
        synchronous(context.check());
        if (fdMountId(context.rootFd) !== mount || fdMountId(namespace.fd) !== mount || fdMountId(directory.fd) !== mount
            || !same(root, checked(fs.fstatSync(context.rootFd, { bigint: true }), true))
            || !same(root, checked(fs.lstatSync(context.stateDir, { bigint: true }), true))
            || !same(namespace.identity, checked(fs.fstatSync(namespace.fd, { bigint: true }), true))
            || !same(namespace.identity, checked(fs.lstatSync(namespace.target, { bigint: true }), true))
            || !same(directory.identity, checked(fs.fstatSync(directory.fd, { bigint: true }), true))
            || !same(directory.identity, checked(fs.lstatSync(directory.target, { bigint: true }), true))) {
          throw new Error("Linux lease directory changed");
        }
      };
      check();
      const entries = fs.opendirSync(at(directory.fd, "."));
      try {
        let count = 0;
        for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
          if (++count > LINUX_LEASE_SLOT_COUNT * 2 + 2 || !entry.isFile()
              || !/^(?:ledger\.json|ledger\.prepared|slot-(?:0\d\d|1\d\d|2[0-4]\d|25[0-5])\.(?:lease|binding))$/.test(entry.name)) {
            throw new Error("Linux lease namespace contains unknown entries");
          }
        }
      } finally { entries.closeSync(); }
      check();
      return run({ context, root, mount, namespace, directory, check });
    } finally { fs.closeSync(directory.fd); }
  } finally { fs.closeSync(namespace.fd); }
}
function exists(target) {
  try { fs.lstatSync(target); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
function readJson(scope, parent, name, limit = 64 * 1024 * 1024) {
  scope.check();
  const target = at(parent.fd, name);
  const before = checked(fs.lstatSync(target, { bigint: true }), false);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | flags());
  try {
    const initial = fs.fstatSync(fd, { bigint: true });
    if (!same(before, checked(initial, false)) || before.dev !== parent.identity.dev || fdMountId(fd) !== scope.mount || initial.size > BigInt(limit)) throw new Error("Linux lease JSON identity or size is invalid");
    const data = fs.readFileSync(fd);
    if (BigInt(data.length) !== initial.size) throw new Error("Linux lease JSON is incomplete");
    const value = JSON.parse(data.toString("utf8"));
    fs.fsyncSync(fd);
    fs.fsyncSync(parent.fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameStamp(stamp(initial), stamp(after)) || !same(before, checked(fs.lstatSync(target, { bigint: true }), false)) || fdMountId(fd) !== scope.mount) throw new Error("Linux lease JSON changed");
    scope.check();
    return { value, identity: before, stamp: stamp(after) };
  } finally { fs.closeSync(fd); }
}
function writeAll(fd, data) {
  for (let offset = 0; offset < data.length;) {
    const count = fs.writeSync(fd, data, offset, data.length - offset);
    if (count <= 0) throw new Error("Linux lease write failed");
    offset += count;
  }
}
function encode(value, max = 1024 * 1024) {
  const data = Buffer.from(`${JSON.stringify(value)}\n`);
  if (data.length > max) throw new Error("Linux lease JSON exceeds limit");
  return data;
}
function validateLedger(scope, ledger) {
  const { context, directory } = scope;
  if (!only(ledger, ["protocol", "epoch", "cursor", "slots"]) || ledger.protocol !== PROTOCOL || ledger.epoch !== context.epoch
      || !Number.isInteger(ledger.cursor) || ledger.cursor < 0 || ledger.cursor >= LINUX_LEASE_SLOT_COUNT
      || !Array.isArray(ledger.slots) || ledger.slots.length !== LINUX_LEASE_SLOT_COUNT) throw new Error("Linux lease ledger is invalid");
  const jobs = new Set(), claims = new Set(), leases = new Set(), inodes = new Set();
  for (let i = 0; i < ledger.slots.length; i++) {
    const e = ledger.slots[i];
    if (!only(e, ["slot", "state", "jobId", "claimToken", "createdAt", "reservedBytes", "lease", "bindingIno", "reclaimKind"])
        || e.slot !== i || !["free", "reserved", "published", "reclaiming"].includes(e.state)) throw new Error("Linux lease slot is invalid");
    if (e.state === "free") {
      if (Object.keys(e).length !== 2) throw new Error("Linux free lease slot is invalid");
      continue;
    }
    if (!validId(e.jobId) || !UUID.test(e.claimToken ?? "") || typeof e.createdAt !== "string" || !e.createdAt || Buffer.byteLength(e.createdAt) > 64
        || !Number.isSafeInteger(e.reservedBytes) || e.reservedBytes <= 0 || e.reservedBytes > RECORD_LIMIT
        || jobs.has(e.jobId) || claims.has(e.claimToken)) throw new Error("Linux lease owner is invalid or duplicated");
    jobs.add(e.jobId); claims.add(e.claimToken);
    if (e.state === "reclaiming" ? !["empty", "reserved", "terminal", "queued"].includes(e.reclaimKind) : e.reclaimKind !== undefined) throw new Error("Linux lease reclaim state is invalid");
    if (!e.lease && e.bindingIno === undefined && (e.state === "reserved" || (e.state === "reclaiming" && e.reclaimKind === "empty"))) continue;
    if (e.reclaimKind === "empty") throw new Error("Linux empty reclaim contains a lease");
    const lease = e.lease;
    if (!only(lease, LEASE_KEYS) || !UUID.test(lease.id ?? "") || lease.slot !== i || lease.stateGeneration !== context.epoch
        || lease.path !== path.join(context.stateDir, NAMESPACE, context.epoch, slotName(i, "lease"))
        || !validIdent(lease) || lease.dev !== directory.identity.dev || !DECIMAL.test(e.bindingIno ?? "")
        || leases.has(lease.id) || inodes.has(`${lease.dev}:${lease.ino}`)) throw new Error("Linux lease identity is invalid or duplicated");
    leases.add(lease.id); inodes.add(`${lease.dev}:${lease.ino}`);
  }
  return ledger;
}
function readLedger(scope) {
  if (exists(at(scope.directory.fd, PREPARED))) throw new Error("Linux lease ledger has an unconfirmed prepared update");
  const loaded = readJson(scope, scope.directory, LEDGER, 1024 * 1024);
  const ledger = validateLedger(scope, loaded.value);
  stamps.set(ledger, loaded.stamp);
  return ledger;
}
function saveLedger(scope, ledger) {
  validateLedger(scope, ledger);
  scope.check();
  const directory = scope.directory;
  const target = at(directory.fd, LEDGER), prepared = at(directory.fd, PREPARED);
  if (!sameStamp(stamp(fs.lstatSync(target, { bigint: true })), stamps.get(ledger))) throw new Error("Linux lease ledger changed");
  const fd = fs.openSync(prepared, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | flags(), 0o600);
  try {
    if (fdMountId(fd) !== scope.mount) throw new Error("Linux prepared ledger crosses mount");
    checked(fs.fstatSync(fd, { bigint: true }), false);
    writeAll(fd, encode(ledger));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.fsyncSync(directory.fd);
  scope.check();
  if (!sameStamp(stamp(fs.lstatSync(target, { bigint: true })), stamps.get(ledger))) throw new Error("Linux lease ledger changed before publication");
  fs.renameSync(prepared, target);
  fs.fsyncSync(directory.fd);
  scope.check();
  stamps.set(ledger, stamp(fs.lstatSync(target, { bigint: true })));
}

// 初期化は marker 公開前、旧 writer 停止と migration mutex の下で行う。
export function initializeLinuxLeaseLedger({ context }) {
  return withScope(context, scope => {
    const target = at(scope.directory.fd, LEDGER);
    if (exists(target) || exists(at(scope.directory.fd, PREPARED))) throw new Error("Existing Linux lease ledger requires recovery");
    const ledger = { protocol: PROTOCOL, epoch: context.epoch, cursor: 0,
      slots: Array.from({ length: LINUX_LEASE_SLOT_COUNT }, (_, slot) => ({ slot, state: "free" })) };
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | flags(), 0o600);
    try { if (fdMountId(fd) !== scope.mount) throw new Error("Linux lease ledger crosses mount"); writeAll(fd, encode(ledger)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.fsyncSync(scope.directory.fd);
    scope.check();
  });
}
export function getProtectedLinuxJobIds({ context }) {
  return withScope(context, scope => new Set(readLedger(scope).slots.filter(e => e.state !== "free").map(e => e.jobId)));
}
// history 側はこの固定検査を真正 v6 mutex の内側で使う。
// 不完全な slot や free slot の残存名は、非参照の証拠にしない。
function historyData(object, key) {
  if (!object || typeof object !== "object") throw new Error("Linux history candidate is invalid");
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("Linux history candidate contains an accessor or missing value");
  return descriptor.value;
}
export function filterLinuxHistoryUnreferenced(input) {
  const context = historyData(input, "context");
  assertLinuxHistoryContext(context);
  const candidates = historyData(input, "candidates");
  if (!Array.isArray(candidates) || candidates.length > 4096) throw new Error("Linux history candidate count is invalid");
  const normalized = [], seen = new Set();
  for (let i = 0; i < candidates.length; i++) {
    const candidate = historyData(candidates, String(i));
    const jobId = historyData(candidate, "jobId"), claimToken = historyData(candidate, "claimToken");
    const workerStopLeaseId = historyData(candidate, "workerStopLeaseId");
    if (!validId(jobId) || !UUID.test(claimToken ?? "") || !UUID.test(workerStopLeaseId ?? "") || seen.has(jobId)) {
      throw new Error("Linux history candidate identity is invalid or duplicated");
    }
    seen.add(jobId);
    normalized.push({ jobId, claimToken, workerStopLeaseId });
  }
  return withScope(context, scope => {
    const ledger = readLedger(scope);
    const names = () => {
      const found = new Set();
      const handle = fs.opendirSync(at(scope.directory.fd, "."));
      try {
        for (let item = handle.readSync(); item; item = handle.readSync()) {
          if (!item.isFile() || found.has(item.name) || found.size >= LINUX_LEASE_SLOT_COUNT * 2 + 2) {
            throw new Error("Linux history lease namespace is uncertain");
          }
          found.add(item.name);
        }
      } finally { handle.closeSync(); }
      return found;
    };
    const before = names();
    const jobs = new Set(), claims = new Set(), leases = new Set();
    for (const entry of ledger.slots) {
      const leaseName = slotName(entry.slot, "lease"), bindingName = slotName(entry.slot, "binding");
      if (entry.state === "free") {
        if (before.has(leaseName) || before.has(bindingName)) throw new Error("Linux free history slot has unconfirmed files");
        continue;
      }
      if (entry.state === "reclaiming" || !entry.lease || !before.has(leaseName) || !before.has(bindingName)) {
        throw new Error("Linux history lease slot is incomplete");
      }
      binding(scope, entry);
      leaseFile(scope, entry.lease);
      jobs.add(entry.jobId); claims.add(entry.claimToken); leases.add(entry.lease.id);
    }
    fs.fsyncSync(scope.directory.fd);
    scope.check();
    const after = names();
    if (after.size !== before.size || [...before].some(name => !after.has(name))) throw new Error("Linux history lease namespace changed");
    const latest = readLedger(scope);
    if (!sameStamp(stamps.get(ledger), stamps.get(latest))) throw new Error("Linux history lease ledger changed");
    assertLinuxHistoryContext(context);
    return new Set(normalized.filter(candidate => !jobs.has(candidate.jobId) && !claims.has(candidate.claimToken)
      && !leases.has(candidate.workerStopLeaseId)).map(candidate => candidate.jobId));
  });
}
export function assertLinuxHistoryUnreferenced(input) {
  const context = historyData(input, "context");
  assertLinuxHistoryContext(context);
  const candidate = { jobId: historyData(input, "jobId"), claimToken: historyData(input, "claimToken"),
    workerStopLeaseId: historyData(input, "workerStopLeaseId") };
  if (!filterLinuxHistoryUnreferenced({ context, candidates: [candidate] }).has(candidate.jobId)) {
    throw new Error("Linux history candidate is referenced by a lease slot");
  }
  return true;
}
function maximumLease(scope) {
  return { id: "11111111-1111-4111-8111-111111111111",
    path: path.join(scope.context.stateDir, NAMESPACE, scope.context.epoch, slotName(255, "lease")),
    dev: scope.directory.identity.dev, ino: "18446744073709551615", stateGeneration: scope.context.epoch, slot: 255 };
}
function queuedSize(scope, jobId, claimToken, createdAt, queuedRecord) {
  if (!queuedRecord || typeof queuedRecord !== "object" || Array.isArray(queuedRecord) || queuedRecord.id !== jobId
      || queuedRecord.claimToken !== claimToken || queuedRecord.createdAt !== createdAt || queuedRecord.epoch !== scope.context.epoch
      || queuedRecord.status !== "queued" || queuedRecord.phase !== "queued" || queuedRecord.grokPromptState !== "not-sent"
      || queuedRecord.pid != null || queuedRecord.processStartKey != null || queuedRecord.startedAt != null) {
    throw new Error("Linux queued record is invalid");
  }
  const bytes = Buffer.byteLength(`${JSON.stringify({ ...queuedRecord, workerLease: maximumLease(scope) }, null, 2)}\n`, "utf8");
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > RECORD_LIMIT) throw new Error("Linux queued record exceeds the size limit");
  return bytes;
}
function checkReservationCapacity(scope, ledger, reservedBytes, queuedRecord) {
  const root = { fd: scope.context.rootFd, identity: scope.root };
  const rootEntries = fs.opendirSync(at(root.fd, "."));
  try {
    let count = 0;
    for (let item = rootEntries.readSync(); item; item = rootEntries.readSync()) {
      if (++count > 4096) throw new Error("Linux state directory inventory exceeds its limit");
      if (/^state\.json\..+\.tmp$/i.test(item.name)) throw new Error("Linux state directory contains an unconfirmed temporary index");
      if ((count & 63) === 0) scope.check();
    }
    fs.fsyncSync(root.fd);
    scope.check();
  } finally { rootEntries.closeSync(); }
  const state = readJson(scope, root, "state.json").value;
  if (!state || !Array.isArray(state.jobs) || state.jobs.length >= 4096) throw new Error("Linux job history is full; records were preserved");
  const ids = new Map();
  const reserves = new Map();
  for (const record of state.jobs) {
    if (!validId(record?.id) || ids.has(record.id)) throw new Error("Linux job history has invalid or duplicate IDs");
    ids.set(record.id, record);
    reserves.set(record.id, linuxControlCapacityReserve(record));
  }
  const outstanding = ledger.slots.filter(entry => entry.state !== "free");
  const missingRecords = outstanding.filter(entry => !ids.has(entry.jobId)).length;
  if (state.jobs.length + missingRecords + 1 > 4096) throw new Error("Linux job history has no space for outstanding reservations");
  const jobs = openDir(scope.context.rootFd, "jobs", scope.mount);
  let handle;
  try {
    handle = fs.opendirSync(at(jobs.fd, "."));
    let count = 0, detailBytes = 0n;
    const names = new Set();
    for (let item = handle.readSync(); item; item = handle.readSync()) {
      if (!item.isFile() || ++count > 4096) throw new Error("Linux jobs directory is uncertain or full");
      if (/\.tmp$/i.test(item.name)) throw new Error("Linux jobs directory contains an unconfirmed temporary record");
      names.add(item.name);
      if (/\.json$/i.test(item.name)) {
        if (!item.name.endsWith(".json")) throw new Error("Linux jobs directory has an unverified JSON name");
        const target = at(jobs.fd, item.name), named = checked(fs.lstatSync(target, { bigint: true }), false);
        const fd = fs.openSync(target, fs.constants.O_RDONLY | flags());
        try {
          const before = fs.fstatSync(fd, { bigint: true });
          if (named.dev !== jobs.identity.dev || !same(named, checked(before, false)) || fdMountId(fd) !== scope.mount
              || before.size > BigInt(RECORD_LIMIT)) throw new Error("Linux detail inventory is invalid");
          const data = fs.readFileSync(fd);
          if (BigInt(data.length) !== before.size) throw new Error("Linux detail inventory is incomplete");
          const detail = JSON.parse(data.toString("utf8"));
          if (!validId(detail?.id) || item.name !== `${detail.id}.json`) throw new Error("Linux detail inventory has an invalid ID");
          const reserve = linuxControlCapacityReserve(detail), previous = reserves.get(detail.id);
          reserves.set(detail.id, previous === undefined || reserve > previous ? reserve : previous);
          fs.fsyncSync(fd);
          if (!sameStamp(stamp(before), stamp(fs.fstatSync(fd, { bigint: true })))
              || !same(named, checked(fs.lstatSync(target, { bigint: true }), false))) throw new Error("Linux detail inventory changed");
          detailBytes += before.size;
        } finally { fs.closeSync(fd); }
      }
      if ((count & 63) === 0) scope.check();
    }
    // 新規 detail と log に加え、更新が途中で止まった一時ファイルの余裕も残す。
    let pending = 3;
    const jobsPath = path.join(scope.context.stateDir, "jobs");
    for (const entry of outstanding) {
      const record = ids.get(entry.jobId);
      if (!names.has(`${entry.jobId}.json`)) {
        pending++; detailBytes += BigInt(entry.reservedBytes);
        const reserve = linuxControlCapacityReserve(null), previous = reserves.get(entry.jobId);
        if (previous === undefined || reserve > previous) reserves.set(entry.jobId, reserve);
      }
      const log = record?.logFile;
      if (log === path.join(jobsPath, `${entry.jobId}.log`) && names.has(`${entry.jobId}.log`)) continue;
      if (!record || !["completed", "failed", "cancelled"].includes(record.status)) pending++;
    }
    if (count + pending > 4096) throw new Error("Linux jobs directory has no space for outstanding reservations");
    reserves.set(queuedRecord.id, linuxControlCapacityReserve(queuedRecord));
    const controlBytes = [...reserves.values()].reduce((sum, value) => sum + value, 0n);
    if (detailBytes + BigInt(reservedBytes) + controlBytes > BigInt(RECORD_LIMIT)) throw new Error("Linux detail history has no space for the queued record and controls");
    const candidate = { ...queuedRecord, workerLease: maximumLease(scope), updatedAt: "9999-12-31T23:59:59.999Z" };
    const preview = { version: 1, config: { stopReviewGate: false, ...(state.config ?? {}) },
      jobs: [candidate, ...state.jobs], reviewGateSessions: Array.isArray(state.reviewGateSessions) ? state.reviewGateSessions : [] };
    const previewBytes = BigInt(Buffer.byteLength(`${JSON.stringify(preview, null, 2)}\n`, "utf8"));
    // まだ index にない予約は detail の最大長を2倍して追加時の字下げと時刻を含める。
    const pendingIndexBytes = outstanding.filter(entry => !ids.has(entry.jobId))
      .reduce((sum, entry) => sum + 2n * BigInt(entry.reservedBytes) + 128n, 0n);
    if (previewBytes + pendingIndexBytes + controlBytes > BigInt(RECORD_LIMIT)) throw new Error("Linux state index has no space for the queued record and controls");
    fs.fsyncSync(jobs.fd);
    if (fdMountId(jobs.fd) !== scope.mount || !same(jobs.identity, checked(fs.fstatSync(jobs.fd, { bigint: true }), true))
        || !same(jobs.identity, checked(fs.lstatSync(jobs.target, { bigint: true }), true))) throw new Error("Linux jobs directory changed during capacity check");
    scope.check();
  } finally { if (handle) handle.closeSync(); fs.closeSync(jobs.fd); }
}
export function reserveLinuxLeaseSlot({ context, jobId, claimToken = randomUUID(), createdAt = new Date().toISOString(), queuedRecord }) {
  if (!validId(jobId) || !UUID.test(claimToken) || typeof createdAt !== "string" || !createdAt || Buffer.byteLength(createdAt) > 64) throw new Error("Linux lease reservation is invalid");
  return withScope(context, scope => {
    const ledger = readLedger(scope);
    if (ledger.slots.some(e => e.state !== "free" && (e.jobId === jobId || e.claimToken === claimToken))) throw new Error("Linux lease owner already exists");
    const reservedBytes = queuedSize(scope, jobId, claimToken, createdAt, queuedRecord);
    checkReservationCapacity(scope, ledger, reservedBytes, queuedRecord);
    let slot = -1;
    for (let n = 0; n < LINUX_LEASE_SLOT_COUNT; n++) {
      const candidate = (ledger.cursor + n) % LINUX_LEASE_SLOT_COUNT;
      if (ledger.slots[candidate].state === "free" && !exists(at(scope.directory.fd, slotName(candidate, "lease")))
          && !exists(at(scope.directory.fd, slotName(candidate, "binding")))) { slot = candidate; break; }
    }
    if (slot < 0) throw Object.assign(new Error("Linux lease slots are full or uncertain"), { code: "GROK_LINUX_LEASE_CAPACITY" });
    ledger.cursor = (slot + 1) % LINUX_LEASE_SLOT_COUNT;
    ledger.slots[slot] = { slot, state: "reserved", jobId, claimToken, createdAt, reservedBytes };
    saveLedger(scope, ledger);
    let acquired;
    try {
      acquired = acquireLinuxWorkerLease({ context, slot, claimToken });
      const binding = { jobId, claimToken, epoch: context.epoch, slot, lease: acquired.lease };
      const fd = fs.openSync(at(scope.directory.fd, slotName(slot, "binding")), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | flags(), 0o600);
      let bindingIdentity;
      try {
        if (fdMountId(fd) !== scope.mount) throw new Error("Linux lease binding crosses mount");
        writeAll(fd, encode(binding)); bindingIdentity = checked(fs.fstatSync(fd, { bigint: true }), false); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.fsyncSync(scope.directory.fd);
      scope.check();
      validateOwnedLinuxWorkerLease({ owner: acquired.owner, lease: acquired.lease, context, claimToken });
      ledger.slots[slot] = { ...ledger.slots[slot], lease: acquired.lease, bindingIno: bindingIdentity.ino };
      saveLedger(scope, ledger);
      return { lease: acquired.lease, owner: acquired.owner, claimToken, createdAt };
    } catch (error) { if (acquired) releaseLinuxWorkerLease(acquired.owner); throw error; }
  });
}
function records(scope, jobId) {
  if (!validId(jobId)) throw new Error("Linux lease job ID is invalid");
  const root = { fd: scope.context.rootFd, identity: scope.root };
  const state = readJson(scope, root, "state.json").value;
  if (!state || !Array.isArray(state.jobs) || state.jobs.length > 4096) throw new Error("Linux lease state is invalid");
  const ids = new Set();
  for (const job of state.jobs) {
    if (!validId(job?.id) || ids.has(job.id)) throw new Error("Linux lease state has invalid job IDs");
    ids.add(job.id);
  }
  const jobs = openDir(scope.context.rootFd, "jobs", scope.mount);
  try {
    const checkJobs = () => {
      scope.check();
      if (fdMountId(jobs.fd) !== scope.mount || !same(jobs.identity, checked(fs.fstatSync(jobs.fd, { bigint: true }), true))
          || !same(jobs.identity, checked(fs.lstatSync(jobs.target, { bigint: true }), true))) throw new Error("Linux jobs directory changed");
    };
    checkJobs();
    const name = `${jobId}.json`, target = at(jobs.fd, name);
    const stored = exists(target) ? readJson(scope, jobs, name).value : null;
    if (!stored) { fs.fsyncSync(jobs.fd); if (exists(target)) throw new Error("Linux lease detail appeared"); }
    checkJobs();
    return { indexed: state.jobs.find(job => job.id === jobId) ?? null, stored };
  } finally { fs.closeSync(jobs.fd); }
}
function binding(scope, entry) {
  const read = readJson(scope, scope.directory, slotName(entry.slot, "binding"), 1024 * 1024);
  const value = read.value;
  if (!only(value, ["jobId", "claimToken", "epoch", "slot", "lease"]) || read.identity.ino !== entry.bindingIno
      || read.identity.dev !== scope.directory.identity.dev || value.jobId !== entry.jobId || value.claimToken !== entry.claimToken
      || value.epoch !== scope.context.epoch || value.slot !== entry.slot || !sameLease(value.lease, entry.lease)) throw new Error("Linux lease binding differs");
}
function leaseFile(scope, lease) {
  const target = at(scope.directory.fd, slotName(lease.slot, "lease"));
  const named = checked(fs.lstatSync(target, { bigint: true }), false);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | flags());
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!same(named, lease) || !same(named, checked(stat, false)) || fdMountId(fd) !== scope.mount || stat.size !== 36n) throw new Error("Linux lease file differs");
    const bytes = Buffer.alloc(36);
    if (fs.readSync(fd, bytes, 0, 36, 0) !== 36 || bytes.toString("utf8") !== lease.id) throw new Error("Linux lease file contents differ");
    fs.fsyncSync(fd); fs.fsyncSync(scope.directory.fd);
    if (!sameStamp(stamp(stat), stamp(fs.fstatSync(fd, { bigint: true }))) || !same(named, checked(fs.lstatSync(target, { bigint: true }), false))) throw new Error("Linux lease file changed");
    scope.check();
  } finally { fs.closeSync(fd); }
}
function matching(record, entry, epoch) {
  return Boolean(record && record.id === entry.jobId && record.claimToken === entry.claimToken && record.epoch === epoch
    && record.createdAt === entry.createdAt && only(record.workerLease, LEASE_KEYS) && sameLease(record.workerLease, entry.lease));
}
function published(scope, ledger, { lease, jobId, claimToken, state }) {
  if (!lease || !Number.isInteger(lease.slot) || lease.slot < 0 || lease.slot >= LINUX_LEASE_SLOT_COUNT) throw new Error("Linux lease slot is invalid");
  const entry = ledger.slots[lease.slot];
  if (entry.state !== state || entry.jobId !== jobId || entry.claimToken !== claimToken || !sameLease(entry.lease, lease)) throw new Error("Linux lease slot does not match");
  binding(scope, entry);
  leaseFile(scope, lease);
  const current = records(scope, jobId);
  if (!matching(current.indexed, entry, scope.context.epoch) || !matching(current.stored, entry, scope.context.epoch)
      || current.indexed.status !== current.stored.status) throw new Error("Linux lease job records disagree");
  return { entry, ...current };
}
export function publishLinuxLeaseSlot({ context, jobId, claimToken, lease, owner }) {
  return withScope(context, scope => {
    const ledger = readLedger(scope);
    const current = published(scope, ledger, { lease, jobId, claimToken, state: "reserved" });
    if (![current.indexed, current.stored].every(record => record.status === "queued" && record.pid == null
      && record.processStartKey == null && record.startedAt == null && (record.terminationPending == null || record.terminationPending === false)
      && record.grokPromptState === "not-sent")) throw new Error("Linux lease reservation is not an unstarted queued job");
    validateOwnedLinuxWorkerLease({ context, lease, owner, claimToken });
    ledger.slots[lease.slot] = { ...current.entry, state: "published" };
    saveLedger(scope, ledger);
  });
}
export function verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease }) {
  if (!indexed || !stored || indexed.id !== stored.id || indexed.claimToken !== stored.claimToken) throw new Error("Linux lease observer records are invalid");
  return withScope(context, scope => {
    const current = published(scope, readLedger(scope), { lease, jobId: indexed.id, claimToken: indexed.claimToken, state: "published" });
    if (!matching(indexed, current.entry, context.epoch) || !matching(stored, current.entry, context.epoch)
        || indexed.status !== current.indexed.status || stored.status !== current.stored.status) throw new Error("Linux lease observer records changed");
    return true;
  });
}
export function verifyPublishedLinuxLease({ context, indexed, stored, owner, lease, claimToken }) {
  if (!indexed || !stored || indexed.id !== stored.id || indexed.claimToken !== claimToken || stored.claimToken !== claimToken) throw new Error("Linux lease owner records are invalid");
  return withScope(context, scope => {
    const current = published(scope, readLedger(scope), { lease, jobId: indexed.id, claimToken, state: "published" });
    if (!matching(indexed, current.entry, context.epoch) || !matching(stored, current.entry, context.epoch)
        || indexed.status !== current.indexed.status || stored.status !== current.stored.status) throw new Error("Linux lease owner records changed");
    validateOwnedLinuxWorkerLease({ context, lease, owner, claimToken });
    return true;
  });
}

const TERMINAL_FIELDS = ["pid", "processStartKey", "startedAt", "completedAt", "phase", "grokPromptState", "grokSessionId",
  "grokTransport", "grokBrokerGeneration", "workerStopConfirmed", "workerStopProof", "workerStopLeaseId", "workerStopProcessStartKey",
  "grokDirectGeneration", "grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"];
function terminalRecords(pair, entry, epoch, removed = false) {
  const { indexed, stored } = pair;
  if (!indexed || !stored || !["completed", "failed", "cancelled"].includes(indexed.status) || indexed.status !== stored.status
      || indexed.terminationPending !== false || stored.terminationPending !== false
      || !["terminal", "not-sent"].includes(indexed.grokPromptState)
      || !TERMINAL_FIELDS.every(key => (indexed[key] ?? null) === (stored[key] ?? null))) return false;
  const direct = ["grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"];
  if (indexed.grokDirectGeneration == null) {
    if (indexed.grokTransport === "direct" || direct.some(key => indexed[key] != null || stored[key] != null)) return false;
  } else if (typeof indexed.grokDirectGeneration !== "string" || !indexed.grokDirectGeneration
      || indexed.grokDirectStopGeneration !== indexed.grokDirectGeneration
      || !["never-started", "posix-group-empty"].includes(indexed.grokDirectStopKind)
      || typeof indexed.grokDirectStopConfirmedAt !== "string" || !indexed.grokDirectStopConfirmedAt
      || !Number.isInteger(indexed.grokDirectOwnerPid) || indexed.grokDirectOwnerPid <= 0
      || typeof indexed.grokDirectOwnerStartKey !== "string" || !indexed.grokDirectOwnerStartKey
      || indexed.grokDirectOwnerStartKey !== indexed.processStartKey) return false;
  const absentProof = indexed.workerStopConfirmed == null || indexed.workerStopConfirmed === false;
  if (absentProof) {
    if (removed || indexed.workerStopProof != null || indexed.workerStopLeaseId != null || indexed.workerStopProcessStartKey != null) return false;
  } else if (indexed.workerStopConfirmed !== true || indexed.workerStopProof !== "linux-lease-released"
      || indexed.workerStopLeaseId !== entry.lease.id || (indexed.workerStopProcessStartKey ?? null) !== (indexed.processStartKey ?? null)) return false;
  if (removed) return [indexed, stored].every(record => record.id === entry.jobId && record.epoch === epoch
    && record.claimToken === entry.claimToken && record.createdAt === entry.createdAt && record.workerLease == null);
  return matching(indexed, entry, epoch) && matching(stored, entry, epoch);
}
function oldLeaseCertain(scope, lease) {
  const directory = openDir(scope.namespace.fd, lease.stateGeneration, scope.mount);
  try {
    if (directory.identity.dev !== scope.root.dev) return false;
    leaseFile({ ...scope, directory }, lease);
    fs.fsyncSync(directory.fd); fs.fsyncSync(scope.namespace.fd);
    scope.check();
    return fdMountId(directory.fd) === scope.mount
      && same(directory.identity, checked(fs.fstatSync(directory.fd, { bigint: true }), true))
      && same(directory.identity, checked(fs.lstatSync(directory.target, { bigint: true }), true));
  } finally { fs.closeSync(directory.fd); }
}
function reverseReferences(scope, target, allowTarget = false) {
  const root = { fd: scope.context.rootFd, identity: scope.root };
  const state = readJson(scope, root, "state.json").value;
  if (!state || !Array.isArray(state.jobs) || state.jobs.length > 4096) throw new Error("Linux lease reverse-reference state exceeds its limit");
  const indexed = new Map();
  for (const record of state.jobs) {
    if (!validId(record?.id) || indexed.has(record.id)) throw new Error("Linux reverse-reference state is invalid");
    indexed.set(record.id, record);
  }
  const ledger = readLedger(scope);
  const jobs = openDir(scope.context.rootFd, "jobs", scope.mount);
  let handle;
  try {
    handle = fs.opendirSync(at(jobs.fd, "."));
    let count = 0, total = 0n;
    const seen = new Set(), inodes = new Set();
    for (let item = handle.readSync(); item; item = handle.readSync()) {
      scope.check();
      if (++count > 4096 || !item.isFile()) return false;
      if (!/\.json$/i.test(item.name)) continue;
      if (!item.name.endsWith(".json")) return false;
      const stat = fs.lstatSync(at(jobs.fd, item.name), { bigint: true });
      total += stat.size;
      if (total > 64n * 1024n * 1024n) return false;
      const loaded = readJson(scope, jobs, item.name);
      const detail = loaded.value, index = indexed.get(detail?.id);
      const inode = `${loaded.identity.dev}:${loaded.identity.ino}`;
      if (!validId(detail?.id) || item.name !== `${detail.id}.json` || seen.has(detail.id) || inodes.has(inode)
          || !index || !same(loaded.identity, checked(stat, false)) || stat.size !== loaded.stamp.size) return false;
      seen.add(detail.id); inodes.add(inode);
      const a = index.workerLease, b = detail.workerLease;
      if ((a == null) !== (b == null) || (a != null && (!only(a, LEASE_KEYS) || !only(b, LEASE_KEYS) || !sameLease(a, b)))) return false;
      if (a != null) {
        if (!Number.isInteger(a.slot) || a.slot < 0 || a.slot >= LINUX_LEASE_SLOT_COUNT) return false;
        const targetPath = path.join(scope.context.stateDir, NAMESPACE, scope.context.epoch, slotName(target.slot, "lease"));
        if (a.stateGeneration === scope.context.epoch) {
          const owner = ledger.slots[a.slot];
          if (owner.state === "free" || owner.jobId !== detail.id || !matching(index, owner, scope.context.epoch)
              || !matching(detail, owner, scope.context.epoch)) return false;
          if ((!allowTarget || detail.id !== target.jobId) && (a.slot === target.slot || a.path === targetPath
              || (target.lease && (a.id === target.lease.id || (a.dev === target.lease.dev && a.ino === target.lease.ino))))) return false;
        } else {
          if (!only(a, LEASE_KEYS) || !UUID.test(a.stateGeneration ?? "") || !UUID.test(a.id ?? "") || !validIdent(a)
              || index.epoch !== a.stateGeneration || detail.epoch !== a.stateGeneration || !UUID.test(index.claimToken ?? "")
              || index.claimToken !== detail.claimToken || typeof index.createdAt !== "string" || !index.createdAt
              || index.createdAt !== detail.createdAt || a.path !== path.join(scope.context.stateDir, NAMESPACE, a.stateGeneration, slotName(a.slot, "lease"))
              || a.path === targetPath || (target.lease && (a.id === target.lease.id || (a.dev === target.lease.dev && a.ino === target.lease.ino)))
              || !oldLeaseCertain(scope, a)) return false;
        }
      }
    }
    if (seen.size !== indexed.size) return false;
    fs.fsyncSync(jobs.fd);
    if (fdMountId(jobs.fd) !== scope.mount || !same(jobs.identity, checked(fs.fstatSync(jobs.fd, { bigint: true }), true))
        || !same(jobs.identity, checked(fs.lstatSync(jobs.target, { bigint: true }), true))) return false;
    scope.check();
    return true;
  } finally { if (handle) handle.closeSync(); fs.closeSync(jobs.fd); }
}
function safeInspect(scope, inspect) {
  try { return inspect(); } catch { readLedger(scope); return null; }
}
function sameEntry(a, b) {
  return a && b && a.slot === b.slot && a.state === b.state && a.reclaimKind === b.reclaimKind && a.jobId === b.jobId
    && a.claimToken === b.claimToken && a.createdAt === b.createdAt && a.reservedBytes === b.reservedBytes
    && a.bindingIno === b.bindingIno && (a.lease == null && b.lease == null || sameLease(a.lease, b.lease));
}
function finishReclaim(scope, ledger, entry) {
  if (!reverseReferences(scope, entry)) throw new Error("Linux lease reverse references are uncertain");
  const leasePath = at(scope.directory.fd, slotName(entry.slot, "lease"));
  const bindingPath = at(scope.directory.fd, slotName(entry.slot, "binding"));
  if (exists(leasePath)) {
    leaseFile(scope, entry.lease);
    fs.unlinkSync(leasePath);
  }
  fs.fsyncSync(scope.directory.fd);
  scope.check();
  if (exists(leasePath)) throw new Error("Linux lease name remains after unlink");
  if (exists(bindingPath)) { binding(scope, entry); fs.unlinkSync(bindingPath); }
  fs.fsyncSync(scope.directory.fd);
  scope.check();
  if (exists(bindingPath)) throw new Error("Linux binding name remains after unlink");
  ledger.slots[entry.slot] = { slot: entry.slot, state: "free" };
  saveLedger(scope, ledger);
}
const NEVER_STARTED = ["grokSessionId", "grokTransport", "grokBrokerGeneration", "grokDirectGeneration", "grokDirectOwnerPid",
  "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"];
function neverStarted(record) {
  return record && record.pid == null && record.processStartKey == null && record.startedAt == null
    && record.grokPromptState === "not-sent" && NEVER_STARTED.every(key => record[key] == null);
}
function queuedRecords(pair, entry, epoch) {
  return [pair.indexed, pair.stored].every(record => matching(record, entry, epoch) && record.status === "queued"
    && record.phase === "queued" && record.completedAt == null && (record.terminationPending == null || record.terminationPending === false)
    && neverStarted(record) && (record.workerStopConfirmed == null || record.workerStopConfirmed === false)
    && record.workerStopProof == null && record.workerStopLeaseId == null && record.workerStopProcessStartKey == null);
}
function removedRecords(pair, entry, epoch) {
  if (!terminalRecords(pair, entry, epoch, true)) return false;
  if (entry.reclaimKind !== "queued") return true;
  return [pair.indexed, pair.stored].every(record => record.status === "failed" && neverStarted(record)
    && typeof record.completedAt === "string" && Boolean(record.completedAt));
}
function bindingCertain(scope, entry) {
  return safeInspect(scope, () => { binding(scope, entry); return true; }) === true;
}
function sweepOne(context, deadline) {
  return withScope(context, scope => {
    const ledger = readLedger(scope);
    const slot = ledger.cursor, entry = ledger.slots[slot];
    ledger.cursor = (slot + 1) % LINUX_LEASE_SLOT_COUNT;
    saveLedger(scope, ledger);
    const leasePath = at(scope.directory.fd, slotName(slot, "lease"));
    const bindingPath = at(scope.directory.fd, slotName(slot, "binding"));
    if (entry.state === "free") return { reclaimed: false, uncertain: exists(leasePath) || exists(bindingPath) };
    if (!entry.lease) {
      if (entry.state !== "reserved" && !(entry.state === "reclaiming" && entry.reclaimKind === "empty")) return { reclaimed: false, uncertain: true };
      const certain = latest => {
        if (exists(leasePath) || exists(bindingPath)) return false;
        const pair = safeInspect(scope, () => records(scope, latest.jobId));
        if (!pair || pair.indexed || pair.stored || safeInspect(scope, () => reverseReferences(scope, latest)) !== true) return false;
        fs.fsyncSync(scope.directory.fd); scope.check();
        return !exists(leasePath) && !exists(bindingPath);
      };
      if (!certain(entry)) return { reclaimed: false, uncertain: true };
      let current = readLedger(scope), latest = current.slots[slot];
      if (!sameEntry(latest, entry)) throw new Error("Linux empty reservation changed");
      if (latest.state === "reserved") {
        current.slots[slot] = { ...latest, state: "reclaiming", reclaimKind: "empty" };
        saveLedger(scope, current);
        latest = current.slots[slot];
      }
      if (!certain(latest)) return { reclaimed: false, uncertain: true };
      current = readLedger(scope);
      if (!sameEntry(current.slots[slot], latest)) throw new Error("Linux empty reclaim changed");
      current.slots[slot] = { slot, state: "free" };
      saveLedger(scope, current);
      return { reclaimed: true, uncertain: false };
    }
    if (entry.state === "reclaiming" && ["terminal", "queued"].includes(entry.reclaimKind)) {
      const pair = safeInspect(scope, () => records(scope, entry.jobId));
      if (pair && removedRecords(pair, entry, context.epoch)) {
        const resume = () => {
          const current = readLedger(scope), latest = current.slots[slot];
          if (!sameEntry(latest, entry)) throw new Error("Linux lease recovery changed");
          const fresh = safeInspect(scope, () => records(scope, entry.jobId));
          if (!fresh || !removedRecords(fresh, latest, context.epoch)
              || safeInspect(scope, () => reverseReferences(scope, latest)) !== true) return { reclaimed: false, uncertain: true };
          if (exists(bindingPath) ? !bindingCertain(scope, latest) : exists(leasePath)) return { reclaimed: false, uncertain: true };
          finishReclaim(scope, current, latest);
          return { reclaimed: true, uncertain: false };
        };
        if (!exists(leasePath)) {
          fs.fsyncSync(scope.directory.fd); scope.check();
          if (exists(leasePath)) return { reclaimed: false, uncertain: true };
          return resume();
        }
        const locked = withAvailableLinuxLease(entry.lease, { ...context, timeoutMs: Math.max(0, deadline - performance.now()) }, resume);
        return locked.status === "available" ? locked.value : { reclaimed: false, uncertain: true };
      }
    }
    if (entry.state === "published" || (entry.state === "reclaiming" && ["terminal", "queued"].includes(entry.reclaimKind))) {
      return { reclaimed: false, uncertain: false, terminalSlot: slot };
    }
    if (entry.state !== "reserved" && !(entry.state === "reclaiming" && entry.reclaimKind === "reserved")) return { reclaimed: false, uncertain: true };
    const reclaim = () => {
      const current = readLedger(scope), latest = current.slots[slot];
      if (!sameEntry(latest, entry)) throw new Error("Linux reservation changed during reclaim");
      const pair = safeInspect(scope, () => records(scope, entry.jobId));
      if (!pair || pair.indexed || pair.stored || safeInspect(scope, () => reverseReferences(scope, latest)) !== true) return { reclaimed: false, uncertain: true };
      if (exists(bindingPath) ? !bindingCertain(scope, latest) : latest.state !== "reclaiming" || exists(leasePath)) return { reclaimed: false, uncertain: true };
      if (latest.state === "reserved") {
        current.slots[slot] = { ...latest, state: "reclaiming", reclaimKind: "reserved" };
        saveLedger(scope, current);
      }
      finishReclaim(scope, current, current.slots[slot]);
      return { reclaimed: true, uncertain: false };
    };
    if (!exists(leasePath)) {
      if (entry.state !== "reclaiming") return { reclaimed: false, uncertain: true };
      fs.fsyncSync(scope.directory.fd); scope.check();
      if (exists(leasePath)) return { reclaimed: false, uncertain: true };
      return reclaim();
    }
    const locked = withAvailableLinuxLease(entry.lease, { ...context, timeoutMs: Math.max(0, deadline - performance.now()) }, reclaim);
    return locked.status === "available" ? locked.value : { reclaimed: false, uncertain: true };
  });
}
const UNAVAILABLE = Symbol("Linux lease unavailable");
function reclaimTerminal(workspace, slot, timeoutMs, deadline) {
  let outcome = { reclaimed: false, uncertain: true };
  try {
    updateState(workspace, (state, context) => withScope(context, scope => {
      const entry = readLedger(scope).slots[slot];
      const pair = records(scope, entry.jobId);
      const indexed = state.jobs.find(record => record.id === entry.jobId);
      const queued = entry.reclaimKind === "queued";
      if (entry.state !== "reclaiming" || !matching(indexed, entry, context.epoch)
          || !(queued ? queuedRecords(pair, entry, context.epoch) : terminalRecords(pair, entry, context.epoch))) throw new Error("Linux reclaim records changed");
      const proof = { workerStopConfirmed: true, workerStopProof: "linux-lease-released", workerStopLeaseId: entry.lease.id,
        workerStopProcessStartKey: indexed.processStartKey ?? null };
      const result = queued ? { status: "failed", phase: "failed", completedAt: new Date().toISOString(), terminationPending: false } : {};
      writeJobFile(workspace, entry.jobId, { ...pair.stored, ...result, ...proof, workerLease: null });
      Object.assign(indexed, result, proof, { workerLease: null });
    }), { timeoutMs, aroundCommit(_state, context, commit) {
      return withScope(context, scope => {
        const ledger = readLedger(scope), entry = ledger.slots[slot];
        if (!entry.lease || (entry.state !== "published" && !(entry.state === "reclaiming" && ["terminal", "queued"].includes(entry.reclaimKind)))) throw UNAVAILABLE;
        const pair = safeInspect(scope, () => records(scope, entry.jobId));
        if (!pair) throw UNAVAILABLE;
        const queued = (entry.state === "published" || entry.reclaimKind === "queued") && queuedRecords(pair, entry, context.epoch);
        const terminal = (entry.state === "published" || entry.reclaimKind === "terminal") && terminalRecords(pair, entry, context.epoch);
        if (!queued && !terminal) throw UNAVAILABLE;
        const perform = () => {
          const current = readLedger(scope), latest = current.slots[slot];
          if (!sameEntry(latest, entry)) throw new Error("Linux reclaim slot changed");
          const fresh = safeInspect(scope, () => records(scope, entry.jobId));
          if (!fresh || !(queued ? queuedRecords(fresh, latest, context.epoch) : terminalRecords(fresh, latest, context.epoch))
              || safeInspect(scope, () => reverseReferences(scope, latest, true)) !== true || !bindingCertain(scope, latest)) throw UNAVAILABLE;
          if (latest.state === "published") {
            current.slots[slot] = { ...latest, state: "reclaiming", reclaimKind: queued ? "queued" : "terminal" };
            saveLedger(scope, current);
          }
          commit();
          finishReclaim(scope, current, current.slots[slot]);
          outcome = { reclaimed: true, uncertain: false };
        };
        const locked = withAvailableLinuxLease(entry.lease, { ...context, timeoutMs: Math.max(0, deadline - performance.now()) }, perform);
        if (locked.status !== "available") throw UNAVAILABLE;
        return _state;
      });
    } });
  } catch (error) { if (error !== UNAVAILABLE) throw error; }
  return outcome;
}
// 各 slot は独立した state mutex の下で調べ、cursor を先に耐久化する。
export function sweepLinuxWorkerLeases(workspace, { maxEntries = 16, timeoutMs = 5000, stopAfterReclaim = false } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > LINUX_LEASE_SLOT_COUNT
      || !Number.isFinite(timeoutMs) || timeoutMs < 0 || typeof stopAfterReclaim !== "boolean") throw new TypeError("Linux lease sweep bounds are invalid");
  const deadline = performance.now() + timeoutMs;
  const result = { examined: 0, reclaimed: 0, uncertain: 0 };
  for (let i = 0; i < maxEntries; i++) {
    const remaining = Math.max(0, deadline - performance.now());
    if (timeoutMs !== 0 && remaining <= 0) throw new Error("Timed out sweeping Linux worker leases");
    let outcome = withStateSnapshot(workspace, (_state, context) => sweepOne(context, deadline), { timeoutMs: remaining });
    if (outcome.terminalSlot !== undefined) {
      const left = Math.max(0, deadline - performance.now());
      if (timeoutMs !== 0 && left <= 0) throw new Error("Timed out sweeping Linux worker leases");
      outcome = reclaimTerminal(workspace, outcome.terminalSlot, left, deadline);
    }
    result.examined++;
    if (outcome.reclaimed) result.reclaimed++;
    if (outcome.uncertain) result.uncertain++;
    if (stopAfterReclaim && outcome.reclaimed) break;
  }
  return result;
}
