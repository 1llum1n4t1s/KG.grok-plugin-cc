import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { TextDecoder, isDeepStrictEqual, types } from "node:util";
import { fdMountId } from "./linux-epoch-recovery.mjs";

// 形式検証だけを行う。戻り値は mutex・FD・停止証拠の capability ではない。
// v7 recovery や通常の state 操作には接続しない。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_U64 = 18446744073709551615n;
const MAX_IMAGE_BYTES = 64n * 1024n * 1024n;
const MAX_JOURNAL_BYTES = 64 * 1024;
const PHASES = new Set(["prepared", "detail", "records", "unlink-ready", "lease-unlinked", "binding-unlinked", "free"]);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset").get;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength").get;

// 入力は正規 JSON の object を想定する。accessor を評価せず拒否する。
function fields(value, keys) {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) throw new Error("Linux reclaim journal object is invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Linux reclaim journal object prototype is invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(name => typeof name !== "string" || !keys.includes(name))) {
    throw new Error("Linux reclaim journal fields are invalid");
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("Linux reclaim journal field is not data");
    result[key] = descriptor.value;
  }
  return result;
}

function positiveDecimal(value, limit = MAX_U64) {
  return typeof value === "string" && value.length <= 20 && DECIMAL.test(value) && BigInt(value) <= limit;
}

function inode(value, dev, identities) {
  const record = fields(value, ["dev", "ino"]);
  if (record.dev !== dev || !positiveDecimal(record.ino)) throw new Error("Linux reclaim journal identity is invalid");
  const identity = `${record.dev}:${record.ino}`;
  if (identities.has(identity)) throw new Error("Linux reclaim journal inode is duplicated");
  identities.add(identity);
  return Object.freeze({ dev: record.dev, ino: record.ino });
}

function image(value, name, dev, identities, kind) {
  const field = kind === "pre" ? "source" : "target";
  const record = fields(value, ["name", "dev", "ino", "size", "sha256", field]);
  if (record.name !== name || record.dev !== dev || !positiveDecimal(record.ino) ||
      !positiveDecimal(record.size, MAX_IMAGE_BYTES) || typeof record.sha256 !== "string" || !HASH.test(record.sha256)) {
    throw new Error("Linux reclaim journal image is invalid");
  }
  const identity = `${record.dev}:${record.ino}`;
  if (identities.has(identity)) throw new Error("Linux reclaim journal inode is duplicated");
  identities.add(identity);
  let endpoint;
  if (kind === "pre") endpoint = inode(record.source, dev, identities);
  else {
    const target = fields(record.target, ["dev", "ino"]);
    if (target.dev !== record.dev || target.ino !== record.ino) throw new Error("Linux reclaim journal target differs from staging");
    endpoint = Object.freeze({ dev: target.dev, ino: target.ino });
  }
  return Object.freeze({ name: record.name, dev: record.dev, ino: record.ino, size: record.size, sha256: record.sha256, [field]: endpoint });
}

function ledgerImage(value, dev, identities) {
  const record = fields(value, ["dev", "ino", "size", "sha256"]);
  if (record.dev !== dev || !positiveDecimal(record.ino) || !positiveDecimal(record.size, 1024n * 1024n) ||
      typeof record.sha256 !== "string" || !HASH.test(record.sha256)) throw new Error("Linux nested ledger image is invalid");
  const identity = `${record.dev}:${record.ino}`;
  if (identities.has(identity)) throw new Error("Linux reclaim journal inode is duplicated");
  identities.add(identity);
  return Object.freeze({ dev: record.dev, ino: record.ino, size: record.size, sha256: record.sha256 });
}

/**
 * 構造だけを検査し、独立した deep-frozen copy を返す。実体の inode/hash や権限は検査しない。
 * raw JSON の重複 key や読取り上限は呼出し前の別 gate が検査する。
 * @param {unknown} value
 * @returns {Readonly<Record<string, any>>}
 */
export function validateLinuxReclaimJournal(value) {
  const record = fields(value, ["protocol", "epoch", "txid", "phase", "slot", "jobId", "claimToken", "createdAt",
    "reclaimKind", "lease", "binding", "oldIndex", "postIndex", "oldDetail", "postDetail", "ledgerTx"]);
  if (record.protocol !== "linux-reclaim-journal-v1" || typeof record.epoch !== "string" || !UUID.test(record.epoch) ||
      typeof record.txid !== "string" || !UUID.test(record.txid) || typeof record.claimToken !== "string" || !UUID.test(record.claimToken) ||
      typeof record.phase !== "string" || !PHASES.has(record.phase) || !Number.isInteger(record.slot) || record.slot < 0 || record.slot >= 256 ||
      typeof record.jobId !== "string" || Buffer.byteLength(record.jobId) > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(record.jobId) ||
      typeof record.createdAt !== "string" || !record.createdAt || Buffer.byteLength(record.createdAt) > 64 ||
      !["terminal", "queued"].includes(record.reclaimKind)) throw new Error("Linux reclaim journal header is invalid");
  const lease = fields(record.lease, ["id", "path", "dev", "ino", "stateGeneration", "slot"]);
  const suffix = `/worker-leases-v1/${record.epoch}/slot-${String(record.slot).padStart(3, "0")}.lease`;
  if (typeof lease.id !== "string" || !UUID.test(lease.id) || lease.stateGeneration !== record.epoch || lease.slot !== record.slot ||
      typeof lease.path !== "string" || !path.posix.isAbsolute(lease.path) || path.posix.normalize(lease.path) !== lease.path ||
      lease.path.includes("\0") || !lease.path.endsWith(suffix) || !positiveDecimal(lease.dev) || !positiveDecimal(lease.ino)) {
    throw new Error("Linux reclaim journal lease is invalid");
  }
  const binding = fields(record.binding, ["dev", "ino"]);
  if (binding.dev !== lease.dev || !positiveDecimal(binding.ino) || binding.ino === lease.ino) {
    throw new Error("Linux reclaim journal binding is invalid");
  }
  const identities = new Set([`${lease.dev}:${lease.ino}`, `${binding.dev}:${binding.ino}`]);
  const oldIndex = image(record.oldIndex, "index.pre", lease.dev, identities, "pre");
  const postIndex = image(record.postIndex, "index.post", lease.dev, identities, "post");
  const oldDetail = image(record.oldDetail, "detail.pre", lease.dev, identities, "pre");
  const postDetail = image(record.postDetail, "detail.post", lease.dev, identities, "post");
  let ledgerTx = null;
  if (record.ledgerTx !== null) {
    const ledger = fields(record.ledgerTx, ["id", "outerTxid", "operation", "state", "oldLedger", "newLedger"]);
    if (typeof ledger.id !== "string" || !UUID.test(ledger.id) || ledger.id === record.txid || ledger.outerTxid !== record.txid ||
        !["reclaiming", "free"].includes(ledger.operation) || !["prepared", "published", "complete"].includes(ledger.state)) {
      throw new Error("Linux reclaim journal nested ledger transaction is invalid");
    }
    if ((record.phase === "prepared" && ledger.operation !== "reclaiming") ||
        (["detail", "records", "unlink-ready", "lease-unlinked"].includes(record.phase) &&
          (ledger.operation !== "reclaiming" || ledger.state !== "complete")) ||
        (record.phase === "binding-unlinked" && ledger.operation === "reclaiming" && ledger.state !== "complete") ||
        (record.phase === "free" && (ledger.operation !== "free" || ledger.state !== "complete"))) {
      throw new Error("Linux reclaim journal nested phase is invalid");
    }
    ledgerTx = Object.freeze({ id: ledger.id, outerTxid: ledger.outerTxid, operation: ledger.operation, state: ledger.state,
      oldLedger: ledgerImage(ledger.oldLedger, lease.dev, identities), newLedger: ledgerImage(ledger.newLedger, lease.dev, identities) });
  } else if (record.phase !== "prepared") throw new Error("Linux reclaim journal nested transaction is missing");
  return Object.freeze({ protocol: record.protocol, epoch: record.epoch, txid: record.txid, phase: record.phase, slot: record.slot,
    jobId: record.jobId, claimToken: record.claimToken, createdAt: record.createdAt, reclaimKind: record.reclaimKind,
    lease: Object.freeze({ id: lease.id, path: lease.path, dev: lease.dev, ino: lease.ino, stateGeneration: lease.stateGeneration, slot: lease.slot }),
    binding: Object.freeze({ dev: binding.dev, ino: binding.ino }), oldIndex, postIndex, oldDetail, postDetail, ledgerTx });
}

// JSON.stringify の object に対する toJSON lookup を使わず、検証済み値だけを直列化する。
function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  return `{${Object.keys(value).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

/**
 * 限定サイズの正規 UTF-8 JSON だけを受け取り、重複 key を含む非正規表現を拒否する。
 * 返す値は形式検証済みの不変 copy であり、filesystem・mutex の capability ではない。
 * @param {unknown} input
 * @returns {Readonly<Record<string, any>>}
 */
export function parseLinuxReclaimJournalJson(input) {
  if (!input || types.isProxy(input) || !Buffer.isBuffer(input)) throw new Error("Linux reclaim journal bytes are invalid");
  const buffer = typedArrayBuffer.call(input);
  const offset = typedArrayOffset.call(input), length = typedArrayLength.call(input);
  if (types.isSharedArrayBuffer(buffer) || length === 0 || length > MAX_JOURNAL_BYTES) {
    throw new Error("Linux reclaim journal bytes exceed their bound or are shared");
  }
  const snapshot = Buffer.from(Buffer.from(buffer, offset, length));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
  const parsed = JSON.parse(text);
  const validated = validateLinuxReclaimJournal(parsed);
  const canonical = Buffer.from(`${canonicalJson(validated)}\n`, "utf8");
  if (!snapshot.equals(canonical)) throw new Error("Linux reclaim journal JSON is not canonical");
  return validated;
}

const DIR_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const FILE_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const at = (fd, name) => `/proc/self/fd/${fd}/${name}`;
function checkedStat(stat, directory) {
  if (typeof process.getuid !== "function" || stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) ||
      stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n || stat.dev <= 0n || stat.ino <= 0n ||
      (!directory && (stat.nlink !== 1n || stat.size > MAX_IMAGE_BYTES))) throw new Error("Linux reclaim file identity or permissions are invalid");
  return stat;
}
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sameStamp(a, b) {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs &&
    a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink;
}
function matchesIdentity(stat, expected) { return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino; }

/**
 * 読取り専用の snapshot 形状確認。返値は認可、mutex、flock、durability の証拠ではない。
 * 呼出し元は別の真正 v7 phase で root/journal の marker と FD の寿命を検証する。
 * cleanup による image 不在は扱わず、この関数はすべての preimage が存在する段階だけに使う。
 * @param {unknown} input
 */
export function inspectLinuxReclaimSnapshotFiles(input) {
  if (!input || typeof input !== "object" || types.isProxy(input)) throw new Error("Linux reclaim inspection input is invalid");
  const args = fields(input, ["rootFd", "jobsFd", "journalFd", "journal",
    ...(Object.hasOwn(input, "maxBytes") ? ["maxBytes"] : []), ...(Object.hasOwn(input, "timeoutMs") ? ["timeoutMs"] : [])]);
  const maxBytes = args.maxBytes ?? 256 * 1024 * 1024, timeoutMs = args.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024 ||
      typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
    throw new Error("Linux reclaim inspection budget is invalid");
  }
  const deadline = performance.now() + timeoutMs;
  const checkDeadline = () => { if (performance.now() >= deadline) throw new Error("Linux reclaim inspection deadline exceeded"); };
  let readBytes = 0;
  for (const fd of [args.rootFd, args.jobsFd, args.journalFd]) {
    if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("Linux reclaim directory FD is invalid");
  }
  const journal = validateLinuxReclaimJournal(args.journal);
  const root = checkedStat(fs.fstatSync(args.rootFd, { bigint: true }), true);
  const jobs = checkedStat(fs.fstatSync(args.jobsFd, { bigint: true }), true);
  const journalDir = checkedStat(fs.fstatSync(args.journalFd, { bigint: true }), true);
  const mount = fdMountId(args.rootFd);
  if (fdMountId(args.jobsFd) !== mount || fdMountId(args.journalFd) !== mount || jobs.dev !== root.dev || journalDir.dev !== root.dev ||
      !sameIdentity(jobs, checkedStat(fs.lstatSync(at(args.rootFd, "jobs"), { bigint: true }), true))) {
    throw new Error("Linux reclaim directories differ or cross a mount boundary");
  }
  const namespacePath = at(args.rootFd, "reclaim-journal-v1");
  const namespaceBefore = checkedStat(fs.lstatSync(namespacePath, { bigint: true }), true);
  const namespaceFd = fs.openSync(namespacePath, DIR_FLAGS);
  const opened = [];
  const namedDirectories = [];
  try {
    const namespace = checkedStat(fs.fstatSync(namespaceFd, { bigint: true }), true);
    if (!sameIdentity(namespaceBefore, namespace) || namespace.dev !== root.dev || fdMountId(namespaceFd) !== mount ||
        !sameIdentity(journalDir, checkedStat(fs.lstatSync(at(namespaceFd, journal.epoch), { bigint: true }), true))) {
      throw new Error("Linux reclaim journal namespace differs");
    }
    const namedJobsFd = fs.openSync(at(args.rootFd, "jobs"), DIR_FLAGS);
    namedDirectories.push(namedJobsFd);
    const namedJournalFd = fs.openSync(at(namespaceFd, journal.epoch), DIR_FLAGS);
    namedDirectories.push(namedJournalFd);
    if (!sameIdentity(jobs, checkedStat(fs.fstatSync(namedJobsFd, { bigint: true }), true)) || fdMountId(namedJobsFd) !== mount ||
        !sameIdentity(journalDir, checkedStat(fs.fstatSync(namedJournalFd, { bigint: true }), true)) || fdMountId(namedJournalFd) !== mount) {
      throw new Error("Linux reclaim named directories differ or cross a mount boundary");
    }
    const checkFile = (directoryFd, name, expected, expectedIdentity) => {
      checkDeadline();
      const target = at(directoryFd, name), before = checkedStat(fs.lstatSync(target, { bigint: true }), false);
      const fd = fs.openSync(target, FILE_FLAGS);
      opened.push({ fd, target, stat: before });
      const initial = checkedStat(fs.fstatSync(fd, { bigint: true }), false);
      if (!sameStamp(before, initial) || initial.dev !== root.dev || fdMountId(fd) !== mount || !matchesIdentity(initial, expectedIdentity) ||
          String(initial.size) !== expected.size) throw new Error("Linux reclaim file identity or size differs");
      if (initial.size > BigInt(maxBytes - readBytes)) throw new Error("Linux reclaim inspection byte budget exceeded");
      const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      for (;;) {
        checkDeadline();
        const count = fs.readSync(fd, buffer, 0, buffer.length, null);
        checkDeadline();
        if (count === 0) break;
        total += count;
        readBytes += count;
        if (total > Number(MAX_IMAGE_BYTES) || readBytes > maxBytes) throw new Error("Linux reclaim inspection byte budget exceeded");
        hash.update(buffer.subarray(0, count));
      }
      if (BigInt(total) !== initial.size || hash.digest("hex") !== expected.sha256 ||
          !sameStamp(initial, checkedStat(fs.fstatSync(fd, { bigint: true }), false)) ||
          !sameStamp(initial, checkedStat(fs.lstatSync(target, { bigint: true }), false))) {
        throw new Error("Linux reclaim file contents or identity differ");
      }
    };
    const inspectTarget = (directoryFd, name, pre, post) => {
      const actual = checkedStat(fs.lstatSync(at(directoryFd, name), { bigint: true }), false);
      const state = matchesIdentity(actual, pre.source) ? "old" : matchesIdentity(actual, post.target) ? "post" : null;
      if (!state) throw new Error("Linux reclaim target identity is unknown");
      checkFile(directoryFd, name, state === "old" ? pre : post, state === "old" ? pre.source : post.target);
      checkFile(args.journalFd, pre.name, pre, pre);
      if (state === "old") checkFile(args.journalFd, post.name, post, post);
      else {
        try { fs.lstatSync(at(args.journalFd, post.name)); }
        catch (error) { if (error?.code === "ENOENT") return state; throw error; }
        throw new Error("Linux reclaim installed image also has a staging name");
      }
      return state;
    };
    const index = inspectTarget(args.rootFd, "state.json", journal.oldIndex, journal.postIndex);
    const detail = inspectTarget(args.jobsFd, `${journal.jobId}.json`, journal.oldDetail, journal.postDetail);
    if ((journal.phase === "prepared" && (index !== "old" || !["old", "post"].includes(detail))) ||
        (journal.phase === "detail" && (detail !== "post" || !["old", "post"].includes(index))) ||
        (!["prepared", "detail"].includes(journal.phase) && (index !== "post" || detail !== "post"))) {
      throw new Error("Linux reclaim record state is not reachable from its phase");
    }
    for (const item of opened) {
      checkDeadline();
      if (fdMountId(item.fd) !== mount || !sameStamp(item.stat, checkedStat(fs.fstatSync(item.fd, { bigint: true }), false)) ||
          !sameStamp(item.stat, checkedStat(fs.lstatSync(item.target, { bigint: true }), false))) throw new Error("Linux reclaim evidence changed");
    }
    if (fdMountId(args.rootFd) !== mount || fdMountId(args.jobsFd) !== mount || fdMountId(args.journalFd) !== mount || fdMountId(namespaceFd) !== mount ||
        !sameIdentity(root, checkedStat(fs.fstatSync(args.rootFd, { bigint: true }), true)) ||
        !sameIdentity(jobs, checkedStat(fs.fstatSync(args.jobsFd, { bigint: true }), true)) ||
        !sameIdentity(jobs, checkedStat(fs.lstatSync(at(args.rootFd, "jobs"), { bigint: true }), true)) ||
        !sameIdentity(namespace, checkedStat(fs.fstatSync(namespaceFd, { bigint: true }), true)) ||
        !sameIdentity(namespace, checkedStat(fs.lstatSync(namespacePath, { bigint: true }), true)) ||
        !sameIdentity(journalDir, checkedStat(fs.fstatSync(args.journalFd, { bigint: true }), true)) ||
        !sameIdentity(journalDir, checkedStat(fs.lstatSync(at(namespaceFd, journal.epoch), { bigint: true }), true)) ||
        fdMountId(namedJobsFd) !== mount || !sameIdentity(jobs, checkedStat(fs.fstatSync(namedJobsFd, { bigint: true }), true)) ||
        fdMountId(namedJournalFd) !== mount || !sameIdentity(journalDir, checkedStat(fs.fstatSync(namedJournalFd, { bigint: true }), true))) {
      throw new Error("Linux reclaim directories changed");
    }
    // 同 inode の bind mount 差替えは lstat と先に開いた FD の再検査だけでは検出できない。
    // 最後に named path から別 FD を開き、現在の mount と identity を照合する。
    const finalJobsFd = fs.openSync(at(args.rootFd, "jobs"), DIR_FLAGS);
    namedDirectories.push(finalJobsFd);
    const finalNamespaceFd = fs.openSync(namespacePath, DIR_FLAGS);
    namedDirectories.push(finalNamespaceFd);
    const finalJournalFd = fs.openSync(at(finalNamespaceFd, journal.epoch), DIR_FLAGS);
    namedDirectories.push(finalJournalFd);
    if (fdMountId(finalJobsFd) !== mount || fdMountId(finalNamespaceFd) !== mount || fdMountId(finalJournalFd) !== mount ||
        !sameIdentity(jobs, checkedStat(fs.fstatSync(finalJobsFd, { bigint: true }), true)) ||
        !sameIdentity(namespace, checkedStat(fs.fstatSync(finalNamespaceFd, { bigint: true }), true)) ||
        !sameIdentity(journalDir, checkedStat(fs.fstatSync(finalJournalFd, { bigint: true }), true)) ||
        !sameIdentity(jobs, checkedStat(fs.lstatSync(at(args.rootFd, "jobs"), { bigint: true }), true)) ||
        !sameIdentity(namespace, checkedStat(fs.lstatSync(namespacePath, { bigint: true }), true)) ||
        !sameIdentity(journalDir, checkedStat(fs.lstatSync(at(finalNamespaceFd, journal.epoch), { bigint: true }), true))) {
      throw new Error("Linux reclaim named directories changed");
    }
    checkDeadline();
    return Object.freeze({ index, detail });
  } finally {
    for (const item of opened) fs.closeSync(item.fd);
    for (const fd of namedDirectories) fs.closeSync(fd);
    fs.closeSync(namespaceFd);
  }
}

// callback/accessor/Proxy を評価せず JSON 値だけを有限量 copy する。
function copyJson(value, budget, depth = 0) {
  if (++budget.nodes > 1000000 || depth > 64) throw new Error("Linux reclaim record exceeds its structural bound");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Linux reclaim record number is invalid");
    return value;
  }
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > 256 * 1024 * 1024) throw new Error("Linux reclaim record exceeds its size bound");
    return value;
  }
  if (!value || typeof value !== "object" || types.isProxy(value)) throw new Error("Linux reclaim record is not JSON data");
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error("Linux reclaim record prototype is invalid");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string")) throw new Error("Linux reclaim record has symbol keys");
  if (array) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 65536 || keys.length !== length + 1) throw new Error("Linux reclaim record array is invalid");
    const result = [];
    for (let i = 0; i < length; i++) {
      const descriptor = descriptors[String(i)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("Linux reclaim record array has an accessor or gap");
      result.push(copyJson(descriptor.value, budget, depth + 1));
    }
    return result;
  }
  const result = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string") throw new Error("Linux reclaim record has symbol keys");
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("Linux reclaim record has an accessor");
    budget.bytes += Buffer.byteLength(key);
    if (budget.bytes > 256 * 1024 * 1024) throw new Error("Linux reclaim record exceeds its size bound");
    result[key] = copyJson(descriptor.value, budget, depth + 1);
  }
  return result;
}

const LEASE_KEYS = ["id", "path", "dev", "ino", "stateGeneration", "slot"];
const TERMINAL_FIELDS = ["pid", "processStartKey", "startedAt", "completedAt", "phase", "grokPromptState", "grokSessionId",
  "grokTransport", "grokBrokerGeneration", "workerStopConfirmed", "workerStopProof", "workerStopLeaseId", "workerStopProcessStartKey",
  "grokDirectGeneration", "grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"];
const validJobId = value => typeof value === "string" && Buffer.byteLength(value) <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)));
}

/**
 * 完了 record の固定 patch を読取り専用で照合する。真正 phase や停止の認可は与えない。
 * queued の回収・正規 serializer・filesystem/hash・WAL は別 gate である。
 * @param {unknown} input
 * @returns {true}
 */
export function inspectLinuxReclaimFixedTransition(input) {
  const args = fields(input, ["oldState", "oldDetail", "newState", "newDetail", "ledger", "epoch", "slot"]);
  const budget = { nodes: 0, bytes: 0 };
  const oldState = copyJson(args.oldState, budget), oldDetail = copyJson(args.oldDetail, budget);
  const newState = copyJson(args.newState, budget), newDetail = copyJson(args.newDetail, budget);
  const ledger = copyJson(args.ledger, budget), epoch = args.epoch, slot = args.slot;
  if (typeof epoch !== "string" || !UUID.test(epoch) || !Number.isInteger(slot) || slot < 0 || slot >= 256 ||
      !exactKeys(ledger, ["protocol", "epoch", "cursor", "slots"]) || ledger.protocol !== "linux-lease-ledger-v1" ||
      ledger.epoch !== epoch || !Number.isInteger(ledger.cursor) || ledger.cursor < 0 || ledger.cursor >= 256 ||
      !Array.isArray(ledger.slots) || ledger.slots.length !== 256 || !Array.isArray(oldState?.jobs) || oldState.jobs.length > 4096 ||
      !Array.isArray(newState?.jobs) || !oldDetail || typeof oldDetail !== "object") throw new Error("Linux reclaim transition input is invalid");
  const ids = new Set();
  for (const job of oldState.jobs) {
    if (!validJobId(job?.id) || ids.has(job.id)) throw new Error("Linux reclaim index has duplicate or invalid jobs");
    ids.add(job.id);
  }
  const entry = ledger.slots[slot], indexed = oldState.jobs.find(job => job.id === oldDetail.id);
  if (!entry || !indexed || !validJobId(oldDetail.id) || !["published", "reclaiming"].includes(entry.state) ||
      (entry.state === "reclaiming" && entry.reclaimKind !== "terminal") || entry.slot !== slot || entry.jobId !== oldDetail.id ||
      typeof entry.claimToken !== "string" || !UUID.test(entry.claimToken) || !entry.lease ||
      !exactKeys(entry.lease, LEASE_KEYS) || entry.lease.slot !== slot || entry.lease.stateGeneration !== epoch ||
      typeof entry.lease.id !== "string" || !UUID.test(entry.lease.id) || !positiveDecimal(entry.lease.dev) || !positiveDecimal(entry.lease.ino) ||
      !positiveDecimal(entry.bindingIno) || typeof entry.createdAt !== "string" || !entry.createdAt ||
      !Number.isSafeInteger(entry.reservedBytes) || entry.reservedBytes <= 0 || entry.reservedBytes > Number(MAX_IMAGE_BYTES)) {
    throw new Error("Linux reclaim transition lease entry is invalid");
  }
  const suffix = `/worker-leases-v1/${epoch}/slot-${String(slot).padStart(3, "0")}.lease`;
  if (typeof entry.lease.path !== "string" || !path.posix.isAbsolute(entry.lease.path) ||
      path.posix.normalize(entry.lease.path) !== entry.lease.path || !entry.lease.path.endsWith(suffix)) throw new Error("Linux reclaim lease path is invalid");
  const stateRoot = entry.lease.path.slice(0, -suffix.length);
  const ledgerJobs = new Set(), claims = new Set(), leaseIds = new Set(), leaseInodes = new Set();
  for (let i = 0; i < ledger.slots.length; i++) {
    const item = ledger.slots[i];
    if (!exactKeys(item, ["slot", "state", "jobId", "claimToken", "createdAt", "reservedBytes", "lease", "bindingIno", "reclaimKind"]) ||
        item.slot !== i || !["free", "reserved", "published", "reclaiming"].includes(item.state) ||
        (item.state === "free" && Object.keys(item).length !== 2)) throw new Error("Linux reclaim ledger contains an invalid slot");
    if (item.state === "free") continue;
    if (!validJobId(item.jobId) || typeof item.claimToken !== "string" || !UUID.test(item.claimToken) ||
        typeof item.createdAt !== "string" || !item.createdAt || Buffer.byteLength(item.createdAt) > 64 ||
        !Number.isSafeInteger(item.reservedBytes) || item.reservedBytes <= 0 || item.reservedBytes > Number(MAX_IMAGE_BYTES) ||
        ledgerJobs.has(item.jobId) || claims.has(item.claimToken) ||
        (item.state === "reclaiming" ? !["empty", "reserved", "queued", "terminal"].includes(item.reclaimKind) : item.reclaimKind !== undefined)) {
      throw new Error("Linux reclaim ledger owner or state is invalid");
    }
    ledgerJobs.add(item.jobId); claims.add(item.claimToken);
    if (!item.lease && item.bindingIno === undefined && (item.state === "reserved" || (item.state === "reclaiming" && item.reclaimKind === "empty"))) continue;
    const currentLease = item.lease;
    if (item.reclaimKind === "empty" || !exactKeys(currentLease, LEASE_KEYS) || typeof currentLease.id !== "string" || !UUID.test(currentLease.id) ||
        currentLease.slot !== i || currentLease.stateGeneration !== epoch ||
        currentLease.path !== `${stateRoot}/worker-leases-v1/${epoch}/slot-${String(i).padStart(3, "0")}.lease` ||
        currentLease.dev !== entry.lease.dev || !positiveDecimal(currentLease.ino) || !positiveDecimal(item.bindingIno) ||
        leaseIds.has(currentLease.id) || leaseInodes.has(`${currentLease.dev}:${currentLease.ino}`)) {
      throw new Error("Linux reclaim ledger lease is invalid or duplicated");
    }
    leaseIds.add(currentLease.id); leaseInodes.add(`${currentLease.dev}:${currentLease.ino}`);
  }
  for (const record of [indexed, oldDetail]) {
    if (record.id !== entry.jobId || record.claimToken !== entry.claimToken || record.epoch !== epoch || record.createdAt !== entry.createdAt ||
        !isDeepStrictEqual(record.workerLease, entry.lease) || !["completed", "failed", "cancelled"].includes(record.status) ||
        record.terminationPending !== false || !["terminal", "not-sent"].includes(record.grokPromptState)) {
      throw new Error("Linux reclaim terminal records differ");
    }
  }
  if (indexed.status !== oldDetail.status || !TERMINAL_FIELDS.every(key => (indexed[key] ?? null) === (oldDetail[key] ?? null))) {
    throw new Error("Linux reclaim terminal evidence differs");
  }
  const direct = ["grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"];
  if (indexed.grokDirectGeneration == null) {
    if (indexed.grokTransport === "direct" || direct.some(key => indexed[key] != null || oldDetail[key] != null)) throw new Error("Linux reclaim direct evidence is incomplete");
  } else if (typeof indexed.grokDirectGeneration !== "string" || !indexed.grokDirectGeneration ||
      indexed.grokDirectStopGeneration !== indexed.grokDirectGeneration || !["never-started", "posix-group-empty"].includes(indexed.grokDirectStopKind) ||
      typeof indexed.grokDirectStopConfirmedAt !== "string" || !indexed.grokDirectStopConfirmedAt ||
      !Number.isInteger(indexed.grokDirectOwnerPid) || indexed.grokDirectOwnerPid <= 0 ||
      typeof indexed.grokDirectOwnerStartKey !== "string" || !indexed.grokDirectOwnerStartKey || indexed.grokDirectOwnerStartKey !== indexed.processStartKey) {
    throw new Error("Linux reclaim direct stop evidence is invalid");
  }
  if ((indexed.workerStopConfirmed != null && indexed.workerStopConfirmed !== false) || indexed.workerStopProof != null ||
      indexed.workerStopLeaseId != null || indexed.workerStopProcessStartKey != null) throw new Error("Linux reclaim preexisting worker stop evidence is invalid");
  const proof = { workerStopConfirmed: true, workerStopProof: "linux-lease-released", workerStopLeaseId: entry.lease.id,
    workerStopProcessStartKey: indexed.processStartKey ?? null, workerLease: null };
  Object.assign(indexed, proof);
  Object.assign(oldDetail, proof);
  if (!isDeepStrictEqual(oldState, newState) || !isDeepStrictEqual(oldDetail, newDetail)) {
    throw new Error("Linux reclaim transition is not the fixed terminal patch");
  }
  return true;
}
