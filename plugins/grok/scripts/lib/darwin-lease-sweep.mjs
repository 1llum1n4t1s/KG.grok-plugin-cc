import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireDarwinWorkerLease, DARWIN_LEASE_SLOT_COUNT, validateOwnedDarwinWorkerLease, withAvailableDarwinLease } from "./darwin-worker-lease.mjs";
import { assertDarwinPruneContext, updateState, withStateSnapshot, writeJobFile } from "./state.mjs";

const LEDGER = "darwin-lease-ledger.json";
const PREPARED = "darwin-lease-ledger.prepared";
const DIRECTORY = "worker-leases";
const PROTOCOL = "darwin-lease-ledger-v1";
const CERTIFICATE_PROTOCOL = "darwin-worker-stop-certificate-v1";
const CERTIFICATE_MAX_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE = /^[1-9][0-9]*$/;
const LEASE_FIELDS = ["id", "path", "dev", "ino", "stateGeneration", "slot", "directoryDev", "directoryIno"];
const LEDGER_IDENTITIES = new WeakMap();
class SlotUncertain extends Error {}

function sameIdentity(a, b) { return a?.dev === b?.dev && a?.ino === b?.ino; }
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function stamp(stat) { return { ...identity(stat), size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }; }
function sameStamp(a, b) { return sameIdentity(a, b) && a?.size === b?.size && a?.mtimeNs === b?.mtimeNs && a?.ctimeNs === b?.ctimeNs; }
function flags() {
  if (process.platform !== "darwin" || typeof process.getuid !== "function" || !fs.constants.O_NOFOLLOW || !fs.constants.O_NONBLOCK) {
    throw new Error("Darwin lease ledger requires no-follow and nonblocking opens");
  }
  return fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
}
function checked(stat, directory) {
  if (!(directory ? stat.isDirectory() : stat.isFile()) || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o077n) !== 0n || stat.dev <= 0n || stat.ino <= 0n || (!directory && stat.nlink !== 1n)) {
    throw new Error("Darwin lease ledger path identity or permissions are invalid");
  }
  return identity(stat);
}
function dirIdentity(directory) { return checked(fs.lstatSync(directory, { bigint: true }), true); }
function syncDirectory(directory, expected) {
  const before = dirIdentity(directory);
  if (expected && !sameIdentity(before, expected)) throw new Error("Darwin lease directory changed");
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | flags());
  try {
    if (!sameIdentity(checked(fs.fstatSync(fd, { bigint: true }), true), before)) throw new Error("Darwin lease directory FD changed");
    fs.fsyncSync(fd);
    if (!sameIdentity(dirIdentity(directory), before)) throw new Error("Darwin lease directory changed during sync");
  } finally { fs.closeSync(fd); }
}
function exists(name) {
  try { fs.lstatSync(name); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
function validJobId(id) {
  return typeof id === "string" && Buffer.byteLength(id, "utf8") <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
}
function onlyKeys(value, allowed) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)); }
function slotName(slot, extension) { return `slot-${String(slot).padStart(3, "0")}.${extension}`; }
function expectedPaths(context, slot) {
  const directory = path.join(context.stateDir, DIRECTORY);
  return { directory, lease: path.join(directory, slotName(slot, "lease")), binding: path.join(directory, slotName(slot, "binding")) };
}
function checkContext(context) {
  flags();
  if (!context || typeof context.stateDir !== "string" || !path.isAbsolute(context.stateDir)
      || typeof context.epoch !== "string" || !UUID.test(context.epoch) || typeof context.check !== "function"
      || !sameIdentity(dirIdentity(context.stateDir), context.directoryIdentity)) throw new Error("Darwin lease state context is invalid");
  context.check();
}
function namespace(context) {
  checkContext(context);
  const directory = path.join(context.stateDir, DIRECTORY);
  const directoryIdentity = dirIdentity(directory);
  if (directoryIdentity.dev !== context.directoryIdentity.dev) throw new Error("Darwin lease namespace is on another device");
  // 無制限のディレクトリ走査を避け、正規名以外や超過は拒否する。
  const entries = fs.opendirSync(directory);
  let count = 0;
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      count += 1;
      if (count > DARWIN_LEASE_SLOT_COUNT * 2 || !/^slot-(?:0\d\d|1\d\d|2[0-4]\d|25[0-5])\.(?:lease|binding)$/.test(entry.name)) {
        throw new Error("Darwin lease namespace contains an unrecognised entry");
      }
    }
  } finally { entries.closeSync(); }
  if (!sameIdentity(dirIdentity(directory), directoryIdentity)) throw new Error("Darwin lease namespace changed");
  context.check();
  return { directory, directoryIdentity };
}
function readDurableJson(file, parent, parentIdentity, maxBytes = 64 * 1024 * 1024) {
  const before = checked(fs.lstatSync(file, { bigint: true }), false);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | flags());
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(before, checked(stat, false)) || stat.size > BigInt(maxBytes)) throw new Error("Darwin lease JSON identity or size is invalid");
    const data = fs.readFileSync(fd);
    const afterRead = fs.fstatSync(fd, { bigint: true });
    if (BigInt(data.length) !== stat.size || afterRead.size !== stat.size || afterRead.mtimeNs !== stat.mtimeNs || afterRead.ctimeNs !== stat.ctimeNs
        || !sameIdentity(checked(afterRead, false), before)) throw new Error("Darwin lease JSON changed during read");
    const value = JSON.parse(data.toString("utf8"));
    fs.fsyncSync(fd);
    const afterSync = fs.fstatSync(fd, { bigint: true });
    if (afterSync.size !== stat.size || afterSync.mtimeNs !== stat.mtimeNs || afterSync.ctimeNs !== stat.ctimeNs
        || !sameIdentity(checked(afterSync, false), before)) throw new Error("Darwin lease JSON changed during sync");
    if (!sameIdentity(checked(fs.lstatSync(file, { bigint: true }), false), before)) throw new Error("Darwin lease JSON name changed");
    syncDirectory(parent, parentIdentity);
    const afterDirectorySync = fs.fstatSync(fd, { bigint: true });
    if (!sameIdentity(checked(afterDirectorySync, false), before) || afterDirectorySync.size !== stat.size
        || afterDirectorySync.mtimeNs !== stat.mtimeNs || afterDirectorySync.ctimeNs !== stat.ctimeNs
        || !sameIdentity(checked(fs.lstatSync(file, { bigint: true }), false), before)) throw new Error("Darwin lease JSON changed after sync");
    return { value, identity: before, stamp: stamp(afterDirectorySync), bytes: data };
  } finally { fs.closeSync(fd); }
}
function sameLease(a, b) { return Boolean(a && b && LEASE_FIELDS.every(key => a[key] === b[key])); }
function validateLedger(context, ledger, directoryIdentity) {
  if (!onlyKeys(ledger, ["protocol", "epoch", "cursor", "slots"]) || ledger.protocol !== PROTOCOL || ledger.epoch !== context.epoch
      || !Number.isInteger(ledger.cursor) || ledger.cursor < 0 || ledger.cursor >= DARWIN_LEASE_SLOT_COUNT
      || !Array.isArray(ledger.slots) || ledger.slots.length !== DARWIN_LEASE_SLOT_COUNT) throw new Error("Darwin lease ledger is invalid");
  const jobs = new Set(), tokens = new Set(), paths = new Set();
  for (let i = 0; i < ledger.slots.length; i += 1) {
    const entry = ledger.slots[i];
    if (!onlyKeys(entry, ["slot", "state", "jobId", "claimToken", "createdAt", "lease", "bindingIno", "reclaimKind"])
        || entry.slot !== i || !["free", "reserved", "published", "reclaiming"].includes(entry.state)) throw new Error("Darwin lease slot is invalid");
    if (entry.state === "free") {
      if (Object.keys(entry).some(key => !["slot", "state"].includes(key))) throw new Error("Darwin free slot contains ownership data");
      continue;
    }
    if (!validJobId(entry.jobId) || typeof entry.claimToken !== "string" || !UUID.test(entry.claimToken)
        || typeof entry.createdAt !== "string" || !entry.createdAt || Buffer.byteLength(entry.createdAt, "utf8") > 64
        || jobs.has(entry.jobId) || tokens.has(entry.claimToken)) throw new Error("Darwin lease slot owner is invalid or duplicated");
    jobs.add(entry.jobId); tokens.add(entry.claimToken);
    if (entry.state === "reclaiming" ? !["reserved", "terminal", "queued"].includes(entry.reclaimKind) : entry.reclaimKind !== undefined) throw new Error("Darwin reclaim kind is invalid");
    if (!entry.lease && entry.state === "reserved" && entry.bindingIno === undefined) continue;
    const lease = entry.lease;
    const expected = expectedPaths(context, i);
    if (!onlyKeys(lease, LEASE_FIELDS) || lease.slot !== i || typeof lease.id !== "string" || !UUID.test(lease.id) || lease.path !== expected.lease || lease.stateGeneration !== context.epoch
        || typeof lease.dev !== "string" || typeof lease.ino !== "string" || !POSITIVE.test(lease.dev) || !POSITIVE.test(lease.ino) || lease.dev !== directoryIdentity.dev
        || lease.directoryDev !== directoryIdentity.dev || lease.directoryIno !== directoryIdentity.ino
        || typeof entry.bindingIno !== "string" || !POSITIVE.test(entry.bindingIno) || paths.has(lease.path)) throw new Error("Darwin lease slot identity is invalid or duplicated");
    paths.add(lease.path);
  }
  return ledger;
}
function readLedger(context) {
  const ns = namespace(context);
  if (exists(path.join(context.stateDir, PREPARED))) throw new Error("Darwin lease ledger has an unconfirmed prepared update");
  const { value, stamp: ledgerStamp } = readDurableJson(path.join(context.stateDir, LEDGER), context.stateDir, context.directoryIdentity, 1024 * 1024);
  context.check();
  const ledger = validateLedger(context, value, ns.directoryIdentity);
  LEDGER_IDENTITIES.set(ledger, ledgerStamp);
  return { ledger, ...ns };
}
function encode(content, maxBytes) {
  const data = Buffer.from(`${JSON.stringify(content)}\n`);
  if (data.length > maxBytes) throw new Error("Darwin lease JSON exceeds its size limit");
  return data;
}
function writeAll(fd, data) {
  let offset = 0;
  while (offset < data.length) {
    const count = fs.writeSync(fd, data, offset, data.length - offset);
    if (count <= 0) throw new Error("Darwin lease write did not progress");
    offset += count;
  }
}
function saveLedger(context, ledger, directoryIdentity) {
  validateLedger(context, ledger, directoryIdentity);
  const content = encode(ledger, 1024 * 1024);
  checkContext(context);
  const ledgerPath = path.join(context.stateDir, LEDGER);
  const previousStat = fs.lstatSync(ledgerPath, { bigint: true });
  checked(previousStat, false);
  const previous = stamp(previousStat);
  if (!sameStamp(previous, LEDGER_IDENTITIES.get(ledger))) throw new Error("Darwin lease ledger changed after validation");
  const prepared = path.join(context.stateDir, PREPARED);
  const fd = fs.openSync(prepared, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | flags(), 0o600);
  try { writeAll(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  context.check();
  const beforeCommit = fs.lstatSync(ledgerPath, { bigint: true });
  checked(beforeCommit, false);
  if (!sameStamp(stamp(beforeCommit), previous)) throw new Error("Darwin lease ledger changed before commit");
  fs.renameSync(prepared, ledgerPath);
  syncDirectory(context.stateDir, context.directoryIdentity);
  context.check();
  const saved = fs.lstatSync(ledgerPath, { bigint: true });
  checked(saved, false);
  LEDGER_IDENTITIES.set(ledger, stamp(saved));
}

// 呼出側は明示移行時の mutex と、旧 writer 停止の確認を所有する。
export function initializeDarwinLeaseLedger({ stateDir, epoch, directoryIdentity }) {
  const context = { stateDir, epoch, directoryIdentity, check() {} };
  checkContext(context);
  const directory = path.join(stateDir, DIRECTORY);
  if (exists(directory) || exists(path.join(stateDir, LEDGER)) || exists(path.join(stateDir, PREPARED))) throw new Error("Existing Darwin lease data requires explicit recovery");
  fs.mkdirSync(directory, { mode: 0o700 });
  const nsIdentity = dirIdentity(directory);
  syncDirectory(stateDir, directoryIdentity);
  const ledger = { protocol: PROTOCOL, epoch, cursor: 0, slots: Array.from({ length: DARWIN_LEASE_SLOT_COUNT }, (_, slot) => ({ slot, state: "free" })) };
  const content = encode(ledger, 1024 * 1024);
  const fd = fs.openSync(path.join(stateDir, LEDGER), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | flags(), 0o600);
  try { writeAll(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(stateDir, directoryIdentity);
  if (!sameIdentity(dirIdentity(directory), nsIdentity)) throw new Error("Darwin lease namespace changed during initialization");
}

export function getProtectedDarwinJobIds({ stateDir, epoch }) {
  const context = { stateDir, epoch, directoryIdentity: dirIdentity(stateDir), check() {} };
  const { ledger } = readLedger(context);
  return new Set(ledger.slots.filter(entry => entry.state !== "free").map(entry => entry.jobId));
}

export function reserveDarwinLeaseSlot({ context, jobId, claimToken, createdAt }) {
  if (!validJobId(jobId) || typeof claimToken !== "string" || !UUID.test(claimToken) || typeof createdAt !== "string" || !createdAt
      || Buffer.byteLength(createdAt, "utf8") > 64) throw new Error("Darwin lease reservation owner is invalid");
  const { ledger, directory, directoryIdentity } = readLedger(context);
  if (ledger.slots.some(entry => entry.state !== "free" && (entry.jobId === jobId || entry.claimToken === claimToken))) throw new Error("Darwin lease reservation owner already exists");
  let selected = null;
  for (let count = 0; count < DARWIN_LEASE_SLOT_COUNT; count += 1) {
    const slot = (ledger.cursor + count) % DARWIN_LEASE_SLOT_COUNT;
    const paths = expectedPaths(context, slot);
    if (ledger.slots[slot].state === "free" && !exists(paths.lease) && !exists(paths.binding)) { selected = slot; break; }
  }
  if (selected === null) {
    const unknown = ledger.slots.filter(entry => entry.state === "reserved" && !entry.lease).length;
    throw Object.assign(new Error(`Darwin lease slots are full or uncertain (${unknown} incomplete reservations)`), { code: "GROK_DARWIN_LEASE_CAPACITY" });
  }
  ledger.cursor = (selected + 1) % DARWIN_LEASE_SLOT_COUNT;
  ledger.slots[selected] = { slot: selected, state: "reserved", jobId, claimToken, createdAt };
  saveLedger(context, ledger, directoryIdentity);
  let acquired;
  try {
    acquired = acquireDarwinWorkerLease({ directory, stateGeneration: context.epoch, slot: selected, expectedDirectoryIdentity: directoryIdentity });
    const lease = { ...acquired.lease, directoryDev: directoryIdentity.dev, directoryIno: directoryIdentity.ino };
    const binding = { jobId, claimToken, epoch: context.epoch, slot: selected, lease };
    const content = encode(binding, 1024 * 1024);
    const bindingPath = expectedPaths(context, selected).binding;
    const fd = fs.openSync(bindingPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | flags(), 0o600);
    let bindingIdentity;
    try { writeAll(fd, content); bindingIdentity = checked(fs.fstatSync(fd, { bigint: true }), false); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    syncDirectory(directory, directoryIdentity);
    validateOwnedDarwinWorkerLease({ fd: acquired.fd, lease, expectedDirectory: directory, expectedDirectoryIdentity: directoryIdentity, stateGeneration: context.epoch });
    ledger.slots[selected] = { ...ledger.slots[selected], lease, bindingIno: bindingIdentity.ino };
    saveLedger(context, ledger, directoryIdentity);
    return { slot: selected, lease, fd: acquired.fd };
  } catch (error) {
    if (acquired) fs.closeSync(acquired.fd);
    throw error;
  }
}

function readRecords(context, jobId) {
  if (!validJobId(jobId)) throw new Error("Darwin lease job ID is invalid");
  const state = readDurableJson(path.join(context.stateDir, "state.json"), context.stateDir, context.directoryIdentity).value;
  if (!state || !Array.isArray(state.jobs)) throw new Error("Darwin lease state is invalid");
  const ids = new Set();
  for (const record of state.jobs) {
    if (!record || !validJobId(record.id) || ids.has(record.id)) throw new Error("Darwin lease state has malformed or duplicate job IDs");
    ids.add(record.id);
  }
  const matches = state.jobs.filter(record => record?.id === jobId);
  if (matches.length > 1) throw new Error("Darwin lease state contains duplicate job IDs");
  const jobs = path.join(context.stateDir, "jobs");
  const jobsIdentity = dirIdentity(jobs);
  if (jobsIdentity.dev !== context.directoryIdentity.dev) throw new Error("Darwin jobs directory is on another device");
  const detailPath = path.join(jobs, `${jobId}.json`);
  let detail = null;
  try {
    if (exists(detailPath)) detail = readDurableJson(detailPath, jobs, jobsIdentity).value;
    else {
      syncDirectory(jobs, jobsIdentity);
      if (exists(detailPath)) throw new Error("Darwin lease detail appeared while checking absence");
    }
  } catch (error) {
    context.check();
    if (!sameIdentity(dirIdentity(jobs), jobsIdentity)) throw error;
    throw new SlotUncertain("Darwin lease detail is uncertain", { cause: error });
  }
  context.check();
  return { indexed: matches[0] ?? null, stored: detail };
}

// 逆参照の証明は全 detail を上限付きで列挙する。上限超過や片側・
// 異常なファイルは、対象 lease を参照していない証拠として使わない。
function noOtherReferences(context, target, allowTarget = false) {
  const state = readDurableJson(path.join(context.stateDir, "state.json"), context.stateDir, context.directoryIdentity).value;
  if (!state || !Array.isArray(state.jobs) || state.jobs.length > 4096) throw new Error("Darwin lease reverse-reference state is invalid or exceeds its limit");
  const indexed = new Map();
  for (const record of state.jobs) {
    if (!record || !validJobId(record.id) || indexed.has(record.id)) throw new Error("Darwin lease reverse-reference state has invalid job IDs");
    indexed.set(record.id, record);
  }
  const { ledger } = readLedger(context);
  const jobs = path.join(context.stateDir, "jobs");
  const jobsIdentity = dirIdentity(jobs);
  if (jobsIdentity.dev !== context.directoryIdentity.dev) throw new Error("Darwin jobs directory is on another device");
  const seenIds = new Set(), seenInodes = new Set();
  let handle;
  try {
    handle = fs.opendirSync(jobs);
    let count = 0;
    let totalBytes = 0n;
    while (true) {
      context.check();
      const item = handle.readSync();
      context.check();
      if (!item) break;
      if (++count > 4096 || !item.isFile()) return false;
      if (!/\.json$/i.test(item.name)) continue;
      if (!item.name.endsWith(".json")) return false;
      const detailPath = path.join(jobs, item.name);
      const before = fs.lstatSync(detailPath, { bigint: true });
      const expectedIdentity = checked(before, false);
      totalBytes += before.size;
      if (totalBytes > 64n * 1024n * 1024n) return false;
      const { value: detail, identity: fileIdentity, stamp: detailStamp } = readDurableJson(detailPath, jobs, jobsIdentity);
      context.check();
      if (!sameIdentity(fileIdentity, expectedIdentity) || detailStamp.size !== before.size) return false;
      const inodeKey = `${fileIdentity.dev}:${fileIdentity.ino}`;
      if (!detail || !validJobId(detail.id) || item.name !== `${detail.id}.json` || seenIds.has(detail.id) || seenInodes.has(inodeKey)) return false;
      const index = indexed.get(detail.id);
      if (!index) return false;
      seenIds.add(detail.id); seenInodes.add(inodeKey);
      const a = index.workerLease, b = detail.workerLease;
      if ((a == null) !== (b == null) || (a != null && !sameLease(a, b))) return false;
      if (a != null) {
        if (!Number.isInteger(a.slot) || a.slot < 0 || a.slot >= DARWIN_LEASE_SLOT_COUNT) return false;
        const owner = ledger.slots[a.slot];
        if (owner.state === "free" || owner.jobId !== detail.id || !sameLease(owner.lease, a)
            || owner.claimToken !== index.claimToken || owner.claimToken !== detail.claimToken) return false;
      }
      if ((!allowTarget || detail.id !== target.jobId) && a != null
          && (a.slot === target.lease.slot || a.path === target.lease.path || a.id === target.lease.id
            || (a.dev === target.lease.dev && a.ino === target.lease.ino))) return false;
    }
    if (seenIds.size !== indexed.size) return false;
    syncDirectory(jobs, jobsIdentity);
    context.check();
    return true;
  } catch {
    // jobs の個別不明は回収を止める。state/ledger/marker が不明なら全体を止める。
    readLedger(context);
    return false;
  } finally { if (handle) handle.closeSync(); }
}
function readBinding(context, slot, directoryIdentity) {
  const pathInfo = expectedPaths(context, slot.slot);
  const { value, identity: found } = readDurableJson(pathInfo.binding, pathInfo.directory, directoryIdentity, 1024 * 1024);
  if (!onlyKeys(value, ["jobId", "claimToken", "epoch", "slot", "lease"])
      || found.ino !== slot.bindingIno || found.dev !== directoryIdentity.dev || value?.jobId !== slot.jobId
      || value.claimToken !== slot.claimToken || value.epoch !== context.epoch || value.slot !== slot.slot
      || !sameLease(value.lease, slot.lease)) throw new Error("Darwin lease binding does not match the ledger");
  context.check();
}
function bindingIsCertain(context, slot, directoryIdentity) {
  try { readBinding(context, slot, directoryIdentity); return true; }
  catch {
    // slot 固有の不正は保留するが、marker・ledger・namespace 全体が
    // 不明なら例外を伝え、別 slot の回収も行わない。
    const scope = readLedger(context);
    if (!sameIdentity(scope.directoryIdentity, directoryIdentity)) throw new Error("Darwin lease namespace changed while inspecting a binding");
    return false;
  }
}
function matchingRecord(record, slot, epoch) {
  return Boolean(record && record.id === slot.jobId && record.epoch === epoch && record.claimToken === slot.claimToken
    && record.createdAt === slot.createdAt && sameLease(record.workerLease, slot.lease));
}
function checkedPublished({ context, ledger, directory, directoryIdentity, slot, jobId, claimToken, lease, fd, expectedState, requireFd = true }) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= DARWIN_LEASE_SLOT_COUNT) throw new Error("Darwin lease slot number is invalid");
  const entry = ledger.slots[slot];
  if (entry.state !== expectedState || entry.jobId !== jobId || entry.claimToken !== claimToken || !sameLease(entry.lease, lease)) throw new Error("Darwin lease slot ownership changed");
  readBinding(context, entry, directoryIdentity);
  const records = readRecords(context, jobId);
  if (!matchingRecord(records.indexed, entry, context.epoch) || !matchingRecord(records.stored, entry, context.epoch)
      || records.indexed.status !== records.stored.status) throw new Error("Darwin lease job records disagree");
  if (requireFd) validateOwnedDarwinWorkerLease({ fd, lease, expectedDirectory: directory, expectedDirectoryIdentity: directoryIdentity, stateGeneration: context.epoch });
  context.check();
  return { entry, ...records };
}

// observer は state mutex を保持する。終了証拠には別途 observer lock が必要。
export function verifyPublishedDarwinLeaseRecords({ context, indexed, stored, lease }) {
  if (!lease || !indexed || !stored || indexed.id !== stored.id || indexed.claimToken !== stored.claimToken) throw new Error("Darwin lease observer records are invalid");
  const scope = readLedger(context);
  const checked = checkedPublished({ context, ...scope, slot: lease.slot, jobId: indexed.id, claimToken: indexed.claimToken,
    lease, fd: undefined, expectedState: "published", requireFd: false });
  if (!matchingRecord(indexed, checked.entry, context.epoch) || !matchingRecord(stored, checked.entry, context.epoch)
      || indexed.status !== checked.indexed.status || stored.status !== checked.stored.status) throw new Error("Darwin lease observer records changed");
  const fd = fs.openSync(lease.path, fs.constants.O_RDONLY | flags());
  try {
    validateOwnedDarwinWorkerLease({ fd, lease, expectedDirectory: scope.directory,
      expectedDirectoryIdentity: scope.directoryIdentity, stateGeneration: context.epoch });
    context.check();
  } finally { fs.closeSync(fd); }
  return true;
}

export function publishDarwinLeaseSlot({ context, slot, claimToken, lease, fd, jobId }) {
  const scope = readLedger(context);
  const current = checkedPublished({ context, ...scope, slot, jobId, claimToken, lease, fd, expectedState: "reserved" });
  if (![current.indexed, current.stored].every(record => record.status === "queued" && record.pid == null && record.processStartKey == null
      && record.startedAt == null && (record.terminationPending == null || record.terminationPending === false)
      && record.grokPromptState === "not-sent")) throw new Error("Darwin lease reservation is not an unstarted queued job");
  scope.ledger.slots[slot] = { ...current.entry, state: "published" };
  saveLedger(context, scope.ledger, scope.directoryIdentity);
}

export function verifyPublishedDarwinLease({ context, indexed, stored, owner, fd = owner?.leaseFd }) {
  const lease = owner?.workerLease;
  if (!lease || owner.epoch !== context.epoch || !owner.claimToken || !indexed || !stored || indexed.id !== stored.id) throw new Error("Darwin lease owner is invalid");
  const scope = readLedger(context);
  const checked = checkedPublished({ context, ...scope, slot: lease.slot, jobId: indexed.id, claimToken: owner.claimToken, lease, fd, expectedState: "published" });
  if (!matchingRecord(indexed, checked.entry, context.epoch) || !matchingRecord(stored, checked.entry, context.epoch)
      || indexed.status !== checked.indexed.status || stored.status !== checked.stored.status) throw new Error("Darwin lease owner records changed");
  return true;
}

function removeReclaimingSlot(context, ledger, entry, directoryIdentity) {
  const paths = expectedPaths(context, entry.slot);
  context.check();
  if (["terminal", "queued"].includes(entry.reclaimKind)) {
    const records = readRecords(context, entry.jobId);
    if (!removedReclaimRecords(records, entry, context.epoch)) throw new Error("Darwin certificate records are not ready for reclaim");
    verifyReclaimCertificate(context, entry, records);
  }
  if (!noOtherReferences(context, entry)) throw new Error("Darwin lease reverse references are uncertain");
  if (exists(paths.lease)) {
    const leaseIdentity = checked(fs.lstatSync(paths.lease, { bigint: true }), false);
    if (!sameIdentity(leaseIdentity, entry.lease)) throw new Error("Darwin reclaim lease identity changed");
    fs.unlinkSync(paths.lease);
  }
  syncDirectory(paths.directory, directoryIdentity);
  if (exists(paths.lease)) throw new Error("Darwin reclaim lease name still exists");
  context.check();
  if (exists(paths.binding)) {
    readBinding(context, entry, directoryIdentity);
    fs.unlinkSync(paths.binding);
  }
  syncDirectory(paths.directory, directoryIdentity);
  if (exists(paths.binding)) throw new Error("Darwin reclaim binding name still exists");
  context.check();
  ledger.slots[entry.slot] = { slot: entry.slot, state: "free" };
  saveLedger(context, ledger, directoryIdentity);
}

function sweepOne(context, deadline) {
  const scope = readLedger(context);
  const slotNumber = scope.ledger.cursor;
  const entry = scope.ledger.slots[slotNumber];
  scope.ledger.cursor = (slotNumber + 1) % DARWIN_LEASE_SLOT_COUNT;
  saveLedger(context, scope.ledger, scope.directoryIdentity);
  if (entry.state === "free") {
    const paths = expectedPaths(context, slotNumber);
    return { reclaimed: false, uncertain: exists(paths.lease) || exists(paths.binding) };
  }
  if (entry.lease && entry.state === "reclaiming" && ["terminal", "queued"].includes(entry.reclaimKind)) {
    const records = readRecords(context, entry.jobId);
    if (removedReclaimRecords(records, entry, context.epoch)) {
      const paths = expectedPaths(context, slotNumber);
      const resume = allowCreate => {
        const current = readLedger(context);
        const latest = current.ledger.slots[slotNumber];
        if (latest.state !== "reclaiming" || latest.reclaimKind !== entry.reclaimKind || latest.claimToken !== entry.claimToken
            || latest.bindingIno !== entry.bindingIno || !sameLease(latest.lease, entry.lease)
            || !removedReclaimRecords(readRecords(context, entry.jobId), latest, context.epoch)) throw new Error("Darwin terminal recovery changed");
        if (!noOtherReferences(context, latest)) return { reclaimed: false, uncertain: true };
        if (exists(paths.binding)) {
          if (!bindingIsCertain(context, latest, current.directoryIdentity)) return { reclaimed: false, uncertain: true };
        } else if (exists(paths.lease)) return { reclaimed: false, uncertain: true };
        ensureDarwinStopCertificate(context, latest, { allowCreate });
        removeReclaimingSlot(context, current.ledger, latest, current.directoryIdentity);
        return { reclaimed: true, uncertain: false };
      };
      if (!exists(paths.lease)) {
        syncDirectory(paths.directory, scope.directoryIdentity);
        if (exists(paths.lease)) return { reclaimed: false, uncertain: true };
        return resume(false);
      }
      const locked = withAvailableDarwinLease(entry.lease, {
        expectedDirectory: scope.directory, expectedDirectoryIdentity: scope.directoryIdentity, stateGeneration: context.epoch,
        timeoutMs: Math.max(0, deadline - performance.now())
      }, () => resume(true));
      return locked.status === "available" ? locked.value : { reclaimed: false, uncertain: true };
    }
  }
  if (entry.lease && (entry.state === "published" || (entry.state === "reclaiming" && ["terminal", "queued"].includes(entry.reclaimKind)))) {
    return { reclaimed: false, uncertain: false, terminalSlot: slotNumber };
  }
  if (!entry.lease || (entry.state !== "reserved" && !(entry.state === "reclaiming" && entry.reclaimKind === "reserved"))) {
    return { reclaimed: false, uncertain: true };
  }
  const paths = expectedPaths(context, slotNumber);
  const reclaim = () => {
    const current = readLedger(context);
    const latest = current.ledger.slots[slotNumber];
    if (latest.state !== entry.state || latest.claimToken !== entry.claimToken || !sameLease(latest.lease, entry.lease)
        || latest.bindingIno !== entry.bindingIno) throw new Error("Darwin reclaim reservation changed");
    const records = readRecords(context, entry.jobId);
    if (records.indexed || records.stored) return { reclaimed: false, uncertain: true };
    if (!noOtherReferences(context, latest)) return { reclaimed: false, uncertain: true };
    if (exists(paths.binding)) {
      if (!bindingIsCertain(context, latest, current.directoryIdentity)) return { reclaimed: false, uncertain: true };
    } else if (latest.state !== "reclaiming" || exists(paths.lease)) return { reclaimed: false, uncertain: true };
    if (latest.state === "reserved") {
      current.ledger.slots[slotNumber] = { ...latest, state: "reclaiming", reclaimKind: "reserved" };
      saveLedger(context, current.ledger, current.directoryIdentity);
    }
    removeReclaimingSlot(context, current.ledger, current.ledger.slots[slotNumber], current.directoryIdentity);
    return { reclaimed: true, uncertain: false };
  };
  if (!exists(paths.lease)) {
    if (entry.state !== "reclaiming") return { reclaimed: false, uncertain: true };
    // reclaiming は observer lock 下で耐久化済み。欠落名を再同期し、
    // 同一 mutex 内の ledger/両 record を再検証してから再開する。
    syncDirectory(paths.directory, scope.directoryIdentity);
    if (exists(paths.lease)) return { reclaimed: false, uncertain: true };
    return reclaim();
  }
  const result = withAvailableDarwinLease(entry.lease, {
    expectedDirectory: scope.directory, expectedDirectoryIdentity: scope.directoryIdentity, stateGeneration: context.epoch,
    timeoutMs: Math.max(0, deadline - performance.now())
  }, reclaim);
  return result.status === "available" ? result.value : { reclaimed: false, uncertain: true };
}

const TERMINAL_EVIDENCE = ["pid", "processStartKey", "startedAt", "completedAt", "phase", "grokPromptState", "grokSessionId", "grokTransport", "grokBrokerGeneration",
  "workerStopConfirmed", "workerStopProof", "workerStopLeaseId", "workerStopProcessStartKey",
  "grokDirectGeneration", "grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"];
function terminalRecords(records, entry, epoch, referencesRemoved = false) {
  const { indexed, stored } = records;
  if (!indexed || !stored || !["completed", "failed", "cancelled"].includes(indexed.status) || indexed.status !== stored.status
      || indexed.terminationPending !== false || stored.terminationPending !== false
      || !["terminal", "not-sent"].includes(indexed.grokPromptState)
      || !TERMINAL_EVIDENCE.every(key => (indexed[key] ?? null) === (stored[key] ?? null))) return false;
  if (indexed.grokPromptState === "not-sent"
      && NEVER_STARTED_FIELDS.some(key => indexed[key] != null || stored[key] != null)) return false;
  if (indexed.workerStopConfirmed == null || indexed.workerStopConfirmed === false) {
    if (["workerStopProof", "workerStopLeaseId", "workerStopProcessStartKey"].some(key => indexed[key] != null || stored[key] != null)) return false;
  } else if (indexed.workerStopConfirmed !== true || indexed.workerStopProof !== "darwin-lease-released"
      || indexed.workerStopLeaseId !== entry.lease.id
      || (indexed.workerStopProcessStartKey ?? null) !== (indexed.processStartKey ?? null)) return false;
  const directFields = ["grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"];
  if (indexed.grokDirectGeneration == null) {
    if (indexed.grokTransport === "direct") return false;
    if (directFields.some(key => indexed[key] != null || stored[key] != null)) return false;
  } else if (typeof indexed.grokDirectGeneration !== "string" || !indexed.grokDirectGeneration
      || indexed.grokDirectStopGeneration !== indexed.grokDirectGeneration
      || !["never-started", "posix-group-empty"].includes(indexed.grokDirectStopKind)
      || typeof indexed.grokDirectStopConfirmedAt !== "string" || !indexed.grokDirectStopConfirmedAt
      || !Number.isInteger(indexed.grokDirectOwnerPid) || indexed.grokDirectOwnerPid <= 0
      || typeof indexed.grokDirectOwnerStartKey !== "string" || !indexed.grokDirectOwnerStartKey
      || indexed.grokDirectOwnerStartKey !== indexed.processStartKey) return false;
  if (referencesRemoved) {
    return [indexed, stored].every(record => record.id === entry.jobId && record.epoch === epoch
      && record.claimToken === entry.claimToken && record.createdAt === entry.createdAt && record.workerLease == null);
  }
  return matchingRecord(indexed, entry, epoch) && matchingRecord(stored, entry, epoch);
}

const NEVER_STARTED_FIELDS = ["grokSessionId", "grokTransport", "grokBrokerGeneration", "grokDirectGeneration",
  "grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"];
function neverStarted(record) {
  return Boolean(record && record.pid == null && record.processStartKey == null && record.startedAt == null
    && record.grokPromptState === "not-sent" && NEVER_STARTED_FIELDS.every(key => record[key] == null));
}
function queuedRecords(records, entry, epoch) {
  return [records.indexed, records.stored].every(record => matchingRecord(record, entry, epoch) && record.status === "queued" && record.phase === "queued"
    && (record.terminationPending == null || record.terminationPending === false) && record.completedAt == null && neverStarted(record)
    && (record.workerStopConfirmed == null || record.workerStopConfirmed === false) && record.workerStopProof == null
    && record.workerStopLeaseId == null && record.workerStopProcessStartKey == null);
}
function removedReclaimRecords(records, entry, epoch) {
  if (!terminalRecords(records, entry, epoch, true)) return false;
  if (![records.indexed, records.stored].every(record => record.workerStopConfirmed === true
      && record.workerStopProof === "darwin-lease-released" && record.workerStopLeaseId === entry.lease.id
      && (record.workerStopProcessStartKey ?? null) === (record.processStartKey ?? null))) return false;
  if (entry.reclaimKind !== "queued") return true;
  return [records.indexed, records.stored].every(record => record.status === "failed" && neverStarted(record)
    && record.workerStopConfirmed === true && record.workerStopProof === "darwin-lease-released"
    && record.workerStopLeaseId === entry.lease.id && record.workerStopProcessStartKey == null
    && typeof record.completedAt === "string" && Boolean(record.completedAt))
    && records.indexed.completedAt === records.stored.completedAt;
}

const CERTIFICATE_TURN_FIELDS = ["grokPromptState", "grokSessionId", "grokTransport", "grokBrokerGeneration",
  "grokDirectGeneration", "grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"];
const SHA256 = /^[0-9a-f]{64}$/;
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Darwin certificate contains a non-JSON value");
  return result;
}
function hashBytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function hashRecord(record) { return hashBytes(canonicalJson(record)); }
function certificatePath(context, jobId) {
  if (!validJobId(jobId)) throw new Error("Darwin certificate job ID is invalid");
  return path.join(context.stateDir, "jobs", `${jobId}.worker-stop-proof`);
}
function certificateWorker(indexed) {
  return { confirmed: indexed.workerStopConfirmed, proof: indexed.workerStopProof, leaseId: indexed.workerStopLeaseId,
    processStartKey: indexed.workerStopProcessStartKey ?? null };
}
function certificateTurn(indexed) {
  return Object.fromEntries(CERTIFICATE_TURN_FIELDS.map(key => [key, indexed[key] ?? null]));
}
// 証明は有効な v4 mutex callback 内だけで作成・検証する。
function requireCertificateBarrier(context) {
  assertDarwinPruneContext(context);
}

function validateCertificatePayload(context, indexed, stored, bytes, expectedCertificate) {
  requireCertificateBarrier(context);
  checkContext(context);
  if (!Buffer.isBuffer(bytes) || bytes.length > CERTIFICATE_MAX_BYTES || !indexed || !stored || !validJobId(indexed.id)
      || !onlyKeys(expectedCertificate, ["path", "dev", "ino", "sha256"])) throw new Error("Darwin certificate snapshot is invalid");
  const target = certificatePath(context, indexed.id);
  const digest = hashBytes(bytes);
  if (expectedCertificate.path !== target || typeof expectedCertificate.dev !== "string" || !POSITIVE.test(expectedCertificate.dev)
      || typeof expectedCertificate.ino !== "string" || !POSITIVE.test(expectedCertificate.ino)
      || typeof expectedCertificate.sha256 !== "string" || !SHA256.test(expectedCertificate.sha256)
      || digest !== expectedCertificate.sha256) throw new Error("Darwin certificate snapshot identity changed");
  const certificate = JSON.parse(bytes.toString("utf8"));
  if (!onlyKeys(certificate, ["protocol", "epoch", "jobId", "claimToken", "createdAt", "slot", "lease", "bindingIno", "file", "indexedSha256", "storedSha256", "worker", "turn"])
      || certificate.protocol !== CERTIFICATE_PROTOCOL || certificate.epoch !== context.epoch || certificate.jobId !== indexed.id
      || certificate.claimToken !== indexed.claimToken || typeof certificate.claimToken !== "string" || !UUID.test(certificate.claimToken)
      || certificate.createdAt !== indexed.createdAt || typeof certificate.createdAt !== "string" || !certificate.createdAt
      || Buffer.byteLength(certificate.createdAt, "utf8") > 64
      || !Number.isInteger(certificate.slot) || certificate.slot < 0 || certificate.slot >= DARWIN_LEASE_SLOT_COUNT
      || typeof certificate.bindingIno !== "string" || !POSITIVE.test(certificate.bindingIno)
      || !onlyKeys(certificate.file, ["dev", "ino"]) || certificate.file.dev !== expectedCertificate.dev || certificate.file.ino !== expectedCertificate.ino
      || typeof certificate.indexedSha256 !== "string" || !SHA256.test(certificate.indexedSha256)
      || typeof certificate.storedSha256 !== "string" || !SHA256.test(certificate.storedSha256)) throw new Error("Darwin certificate contents are invalid");
  const lease = certificate.lease;
  const expectedLease = expectedPaths(context, certificate.slot).lease;
  const namespaceIdentity = dirIdentity(path.dirname(expectedLease));
  if (!onlyKeys(lease, LEASE_FIELDS) || lease.slot !== certificate.slot || typeof lease.id !== "string" || !UUID.test(lease.id)
      || lease.path !== expectedLease || lease.stateGeneration !== context.epoch || typeof lease.dev !== "string" || !POSITIVE.test(lease.dev)
      || typeof lease.ino !== "string" || !POSITIVE.test(lease.ino) || typeof lease.directoryDev !== "string" || !POSITIVE.test(lease.directoryDev)
      || typeof lease.directoryIno !== "string" || !POSITIVE.test(lease.directoryIno) || lease.dev !== lease.directoryDev
      || lease.directoryDev !== context.directoryIdentity.dev || expectedCertificate.dev !== context.directoryIdentity.dev
      || lease.directoryDev !== namespaceIdentity.dev || lease.directoryIno !== namespaceIdentity.ino) throw new Error("Darwin certificate lease identity is invalid");
  const entry = { jobId: certificate.jobId, claimToken: certificate.claimToken, createdAt: certificate.createdAt, lease };
  if (!terminalRecords({ indexed, stored }, entry, context.epoch, true)
      || indexed.workerStopConfirmed !== true || indexed.workerStopProof !== "darwin-lease-released"
      || indexed.workerStopLeaseId !== lease.id || (indexed.workerStopProcessStartKey ?? null) !== (indexed.processStartKey ?? null)
      || certificate.indexedSha256 !== hashRecord(indexed) || certificate.storedSha256 !== hashRecord(stored)
      || !onlyKeys(certificate.worker, ["confirmed", "proof", "leaseId", "processStartKey"])
      || canonicalJson(certificate.worker) !== canonicalJson(certificateWorker(indexed))
      || !onlyKeys(certificate.turn, CERTIFICATE_TURN_FIELDS)
      || canonicalJson(certificate.turn) !== canonicalJson(certificateTurn(indexed))) throw new Error("Darwin certificate does not match both records and stop evidence");
  context.check();
  return { path: target, dev: expectedCertificate.dev, ino: expectedCertificate.ino, sha256: digest };
}

// WAL recovery で使う snapshot 検証。prune の権限は呼出側の durable WAL が検証する。
export function verifyDarwinStopCertificateSnapshot({ context, indexed, stored, certificateBytes, expectedCertificate }) {
  return validateCertificatePayload(context, indexed, stored, certificateBytes, expectedCertificate);
}

export function verifyDarwinStopCertificate({ context, indexed, stored, expectedCertificate = undefined }) {
  requireCertificateBarrier(context);
  checkContext(context);
  const target = certificatePath(context, indexed?.id);
  const jobs = path.dirname(target);
  const jobsIdentity = dirIdentity(jobs);
  if (jobsIdentity.dev !== context.directoryIdentity.dev) throw new Error("Darwin certificate directory is on another device");
  const { bytes, identity: fileIdentity } = readDurableJson(target, jobs, jobsIdentity, CERTIFICATE_MAX_BYTES);
  const actual = { path: target, ...fileIdentity, sha256: hashBytes(bytes) };
  if (expectedCertificate && (!onlyKeys(expectedCertificate, ["path", "dev", "ino", "sha256"])
      || !["path", "dev", "ino", "sha256"].every(key => expectedCertificate[key] === actual[key]))) throw new Error("Darwin certificate identity changed");
  return validateCertificatePayload(context, indexed, stored, bytes, actual);
}

function ensureDarwinStopCertificate(context, entry, { allowCreate }) {
  requireCertificateBarrier(context);
  const records = readRecords(context, entry.jobId);
  if (!removedReclaimRecords(records, entry, context.epoch)) throw new Error("Darwin certificate records are incomplete");
  const target = certificatePath(context, entry.jobId);
  const jobs = path.dirname(target);
  const jobsIdentity = dirIdentity(jobs);
  if (jobsIdentity.dev !== context.directoryIdentity.dev) throw new Error("Darwin certificate directory is on another device");
  if (!exists(target)) {
    if (!allowCreate) throw new Error("Darwin certificate is missing after the worker lease disappeared");
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | flags(), 0o600);
    try {
      const fileIdentity = checked(fs.fstatSync(fd, { bigint: true }), false);
      const certificate = { protocol: CERTIFICATE_PROTOCOL, epoch: context.epoch, jobId: entry.jobId, claimToken: entry.claimToken,
        createdAt: entry.createdAt, slot: entry.slot, lease: entry.lease, bindingIno: entry.bindingIno, file: fileIdentity,
        indexedSha256: hashRecord(records.indexed), storedSha256: hashRecord(records.stored),
        worker: certificateWorker(records.indexed), turn: certificateTurn(records.indexed) };
      writeAll(fd, encode(certificate, CERTIFICATE_MAX_BYTES));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncDirectory(jobs, jobsIdentity);
    context.check();
  }
  return verifyReclaimCertificate(context, entry, records);
}

function verifyReclaimCertificate(context, entry, records) {
  const verified = verifyDarwinStopCertificate({ context, ...records });
  const jobs = path.dirname(verified.path);
  const result = readDurableJson(verified.path, jobs, dirIdentity(jobs), CERTIFICATE_MAX_BYTES);
  if (result.identity.dev !== verified.dev || result.identity.ino !== verified.ino || hashBytes(result.bytes) !== verified.sha256
      || result.value.epoch !== context.epoch || result.value.jobId !== entry.jobId
      || result.value.claimToken !== entry.claimToken || result.value.createdAt !== entry.createdAt
      || result.value.slot !== entry.slot || result.value.bindingIno !== entry.bindingIno
      || !sameLease(result.value.lease, entry.lease)) throw new Error("Darwin certificate does not match reclaiming ledger");
  context.check();
  return verified;
}

const UNAVAILABLE = Symbol("Darwin lease unavailable");
function reclaimTerminal(workspace, slotNumber, timeoutMs, deadline) {
  let result = { reclaimed: false, uncertain: true };
  try {
    updateState(workspace, (state, context) => {
      const scope = readLedger(context);
      const entry = scope.ledger.slots[slotNumber];
      const records = readRecords(context, entry.jobId);
      const indexed = state.jobs.find(record => record.id === entry.jobId);
      const queued = entry.reclaimKind === "queued";
      if (entry.state !== "reclaiming" || (!queued && entry.reclaimKind !== "terminal")
          || !(queued ? queuedRecords(records, entry, context.epoch) : terminalRecords(records, entry, context.epoch))
          || !(queued ? queuedRecords({ indexed, stored: records.stored }, entry, context.epoch)
            : terminalRecords({ indexed, stored: records.stored }, entry, context.epoch))) throw new Error("Darwin reclaim records changed before reference removal");
      const patch = queued ? {
        status: "failed", phase: "failed", terminationPending: false, pid: null, workerLease: null,
        workerStopConfirmed: true, workerStopProof: "darwin-lease-released", workerStopLeaseId: entry.lease.id,
        workerStopProcessStartKey: null, completedAt: new Date().toISOString(),
        errorMessage: "Job process exited without recording a final result."
      } : {
        workerLease: null, workerStopConfirmed: true, workerStopProof: "darwin-lease-released",
        workerStopLeaseId: entry.lease.id, workerStopProcessStartKey: indexed.processStartKey ?? null
      };
      writeJobFile(workspace, entry.jobId, { ...records.stored, ...patch });
      Object.assign(indexed, patch);
    }, { timeoutMs, aroundCommit(state, context, commit) {
      requireCertificateBarrier(context);
      const scope = readLedger(context);
      const entry = scope.ledger.slots[slotNumber];
      const paths = expectedPaths(context, slotNumber);
      if (!entry.lease || (entry.state !== "published" && !(entry.state === "reclaiming" && ["terminal", "queued"].includes(entry.reclaimKind)))) throw UNAVAILABLE;
      const records = readRecords(context, entry.jobId);
      const removed = entry.state === "reclaiming" && removedReclaimRecords(records, entry, context.epoch);
      const queued = (entry.state === "published" || entry.reclaimKind === "queued") && queuedRecords(records, entry, context.epoch);
      const terminal = (entry.state === "published" || entry.reclaimKind === "terminal") && terminalRecords(records, entry, context.epoch);
      if (!removed && !queued && !terminal) throw UNAVAILABLE;
      const perform = () => {
        const current = readLedger(context);
        const latest = current.ledger.slots[slotNumber];
        if (latest.state !== entry.state || latest.claimToken !== entry.claimToken || !sameLease(latest.lease, entry.lease)
            || latest.bindingIno !== entry.bindingIno) throw new Error("Darwin terminal reclaim changed");
        const fresh = readRecords(context, entry.jobId);
        if (!(removed ? removedReclaimRecords(fresh, entry, context.epoch)
          : queued ? queuedRecords(fresh, entry, context.epoch) : terminalRecords(fresh, entry, context.epoch))) throw new Error("Darwin reclaim evidence changed");
        if (!noOtherReferences(context, latest, !removed)) throw UNAVAILABLE;
        if (exists(paths.binding)) {
          if (!bindingIsCertain(context, entry, current.directoryIdentity)) throw UNAVAILABLE;
        } else if (!removed || exists(paths.lease)) throw UNAVAILABLE;
        if (entry.state === "published") {
          current.ledger.slots[slotNumber] = { ...entry, state: "reclaiming", reclaimKind: queued ? "queued" : "terminal" };
          saveLedger(context, current.ledger, current.directoryIdentity);
        }
        if (!removed) commit();
        else {
          // 再開時には両 record の参照除去が既に耐久化されている。
          // commit の mutator は不要な再変更を避けるため例外で実行を止めない。
          throw UNAVAILABLE;
        }
        ensureDarwinStopCertificate(context, current.ledger.slots[slotNumber], { allowCreate: true });
        removeReclaimingSlot(context, current.ledger, current.ledger.slots[slotNumber], current.directoryIdentity);
        result = { reclaimed: true, uncertain: false };
      };
      if (!exists(paths.lease)) {
        // 参照が両側で除去済みでも、現時点では state API の commit 契約上
        // 再開を確定できないため slot を保全する。
        throw UNAVAILABLE;
      }
      const locked = withAvailableDarwinLease(entry.lease, {
        expectedDirectory: scope.directory, expectedDirectoryIdentity: scope.directoryIdentity, stateGeneration: context.epoch,
        timeoutMs: Math.max(0, deadline - performance.now())
      }, perform);
      if (locked.status !== "available") throw UNAVAILABLE;
      return state;
    } });
  } catch (error) {
    if (error !== UNAVAILABLE && !(error instanceof SlotUncertain)) throw error;
  }
  return result;
}

// 1 slot ごとに同一 state mutex を取得し、検査数と取得時間を制限する。
export function sweepDarwinWorkerLeases(workspace, { maxEntries = 16, timeoutMs = 5000, stopAfterReclaim = false } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > DARWIN_LEASE_SLOT_COUNT
      || !Number.isFinite(timeoutMs) || timeoutMs < 0 || typeof stopAfterReclaim !== "boolean") throw new TypeError("Darwin lease sweep bounds are invalid");
  const deadline = performance.now() + timeoutMs;
  const result = { examined: 0, reclaimed: 0, uncertain: 0 };
  for (let i = 0; i < maxEntries; i += 1) {
    const remaining = Math.max(0, deadline - performance.now());
    if (timeoutMs !== 0 && remaining <= 0) throw new Error("Timed out sweeping Darwin worker leases");
    let outcome;
    try { outcome = withStateSnapshot(workspace, (_state, context) => sweepOne(context, deadline), { timeoutMs: remaining }); }
    catch (error) {
      if (!(error instanceof SlotUncertain)) throw error;
      outcome = { reclaimed: false, uncertain: true };
    }
    if ("terminalSlot" in outcome && outcome.terminalSlot !== undefined) {
      const terminalRemaining = Math.max(0, deadline - performance.now());
      if (timeoutMs !== 0 && terminalRemaining <= 0) throw new Error("Timed out sweeping Darwin worker leases");
      outcome = reclaimTerminal(workspace, outcome.terminalSlot, terminalRemaining, deadline);
    }
    result.examined += 1;
    if (outcome.reclaimed) result.reclaimed += 1;
    if (outcome.uncertain) result.uncertain += 1;
    if (stopAfterReclaim && outcome.reclaimed) break;
  }
  return result;
}
