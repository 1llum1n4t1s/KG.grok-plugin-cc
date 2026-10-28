import { assertLinuxHistoryTransactionContext } from "./state.mjs";
import { fdMountId } from "./linux-epoch-recovery.mjs";
import { assertLinuxHistoryUnreferenced, filterLinuxHistoryUnreferenced } from "./linux-lease-ledger.mjs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const INDEX_LIMIT = 64 * 1024 * 1024;
const INVENTORY_LIMIT = 4096;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE = ["id", "status", "phase", "epoch", "claimToken", "createdAt", "startedAt", "completedAt", "pid", "processStartKey",
  "jobClass", "sessionId", "grokSessionId", "taskSessionResumable", "terminationPending", "grokPromptState",
  "grokTransport", "grokBrokerGeneration", "grokDirectGeneration", "grokDirectOwnerPid", "grokDirectOwnerStartKey",
  "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt", "workerStopConfirmed",
  "workerStopProof", "workerStopLeaseId", "workerStopProcessStartKey", "logFile"];
const at = (fd, name) => `/proc/self/fd/${fd}/${name}`;
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const validId = value => typeof value === "string" && Buffer.byteLength(value) <= 200 && ID.test(value);
function fail(message) { throw new Error(`Linux history prune: ${message}`); }
function checked(stat, directory, limit = INDEX_LIMIT) {
  if (typeof process.getuid !== "function" || stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) ||
      stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n || stat.dev <= 0n || stat.ino <= 0n ||
      (!directory && (stat.nlink !== 1n || stat.size > BigInt(limit)))) fail("invalid file identity, mode or size");
  return identity(stat);
}
function sameStamp(a, b) {
  return same(identity(a), identity(b)) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function openDirectory(parentFd, name, mount, expected) {
  const target = at(parentFd, name), before = checked(fs.lstatSync(target, { bigint: true }), true);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!same(before, checked(fs.fstatSync(fd, { bigint: true }), true)) || fdMountId(fd) !== mount ||
        (expected && !same(before, expected))) fail("directory identity or mount changed");
    return { fd, target, identity: before };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function withScope(context, run, timeoutMs = 30000) {
  assertLinuxHistoryTransactionContext(context);
  const deadline = performance.now() + timeoutMs;
  const root = { fd: context.rootFd, identity: checked(fs.fstatSync(context.rootFd, { bigint: true }), true) };
  if (!same(root.identity, context.directoryIdentity) || !context.expectedHistoryJournalIdentity || !UUID.test(context.epoch ?? "")) fail("journal capability is unavailable");
  const mount = fdMountId(root.fd);
  const namespace = openDirectory(root.fd, "history-journal-v1", mount, null);
  try {
    const journal = openDirectory(namespace.fd, context.epoch, mount, context.expectedHistoryJournalIdentity);
    try {
      const jobs = openDirectory(root.fd, "jobs", mount, null);
      try {
        if (namespace.identity.dev !== root.identity.dev || journal.identity.dev !== root.identity.dev || jobs.identity.dev !== root.identity.dev) fail("directory crosses filesystem boundary");
        const checkTime = () => {
          if (performance.now() >= deadline) fail("transaction deadline exceeded");
        };
        const check = () => {
          checkTime();
          assertLinuxHistoryTransactionContext(context);
          for (const dir of [namespace, journal, jobs]) {
            if (fdMountId(dir.fd) !== mount || !same(dir.identity, checked(fs.fstatSync(dir.fd, { bigint: true }), true)) ||
                !same(dir.identity, checked(fs.lstatSync(dir.target, { bigint: true }), true))) fail("directory changed during transaction");
          }
          if (fdMountId(root.fd) !== mount || !same(root.identity, checked(fs.fstatSync(root.fd, { bigint: true }), true))) fail("root changed during transaction");
        };
        check(); const result = run({ context, root, journal, jobs, mount, check, checkTime }); check(); return result;
      } finally { fs.closeSync(jobs.fd); }
    } finally { fs.closeSync(journal.fd); }
  } finally { fs.closeSync(namespace.fd); }
}
function readFile(scope, dir, name, limit = INDEX_LIMIT, includeData = true, syncDirectory = true, fullCheck = true) {
  const check = fullCheck ? scope.check : scope.checkTime;
  check();
  const target = at(dir.fd, name), before = fs.lstatSync(target, { bigint: true });
  const id = checked(before, false, limit);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!same(id, checked(opened, false, limit)) || id.dev !== scope.root.identity.dev || fdMountId(fd) !== scope.mount) fail("file changed during open");
    const chunks = [], digest = createHash("sha256"), chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      scope.checkTime();
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > limit) fail("file exceeds its read budget");
      const part = chunk.subarray(0, count); digest.update(part);
      if (includeData) chunks.push(Buffer.from(part));
    }
    const data = includeData ? Buffer.concat(chunks, total) : null;
    fs.fsyncSync(fd); if (syncDirectory) fs.fsyncSync(dir.fd);
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(target, { bigint: true });
    if (!sameStamp(opened, after) || !sameStamp(opened, named)) fail("file changed during read");
    check(); return { id, digest: digest.digest("hex"), data };
  } finally { fs.closeSync(fd); }
}
function parse(data) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); }
  catch { fail("invalid JSON evidence"); }
}
function validCandidate(indexed, detail, epoch, jobsDir) {
  if (!indexed || !detail || !validId(indexed.id) || indexed.epoch !== epoch || detail.epoch !== epoch ||
      !["completed", "failed", "cancelled"].includes(indexed.status) || indexed.terminationPending !== false ||
      typeof indexed.createdAt !== "string" || !indexed.createdAt || typeof indexed.updatedAt !== "string" || !indexed.updatedAt ||
      typeof indexed.completedAt !== "string" || !indexed.completedAt ||
      detail.terminationPending !== false || indexed.workerLease != null || detail.workerLease != null || indexed.pid != null ||
      detail.pid != null || !["terminal", "not-sent"].includes(indexed.grokPromptState) ||
      !UUID.test(indexed.claimToken ?? "") || !UUID.test(indexed.workerStopLeaseId ?? "") ||
      indexed.workerStopConfirmed !== true || indexed.workerStopProof !== "linux-lease-released" ||
      (indexed.workerStopProcessStartKey ?? null) !== (indexed.processStartKey ?? null) ||
      !EVIDENCE.every(key => (indexed[key] ?? null) === (detail[key] ?? null)) ||
      (indexed.logFile != null && indexed.logFile !== path.join(jobsDir, `${indexed.id}.log`))) return false;
  const direct = ["grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt"];
  if (indexed.grokDirectGeneration == null) return indexed.grokTransport !== "direct" && direct.every(key => indexed[key] == null);
  return typeof indexed.grokDirectGeneration === "string" && indexed.grokDirectGeneration.length > 0 &&
    indexed.grokDirectStopGeneration === indexed.grokDirectGeneration &&
    ["never-started", "posix-group-empty"].includes(indexed.grokDirectStopKind) &&
    typeof indexed.grokDirectStopConfirmedAt === "string" && indexed.grokDirectStopConfirmedAt.length > 0 &&
    Number.isInteger(indexed.grokDirectOwnerPid) && indexed.grokDirectOwnerPid > 0 &&
    typeof indexed.grokDirectOwnerStartKey === "string" && indexed.grokDirectOwnerStartKey.length > 0 &&
    indexed.grokDirectOwnerStartKey === indexed.processStartKey;
}
function inventory(scope, state, restored = null, deadline = Infinity) {
  if (!state || !Array.isArray(state.jobs) || state.jobs.length > INVENTORY_LIMIT) fail("index exceeds inventory limit");
  const indexed = new Map(), names = new Set(), details = new Map();
  for (const job of state.jobs) {
    scope.checkTime();
    if (!validId(job?.id) || indexed.has(job.id.toLowerCase())) fail("index contains an invalid or ambiguous job");
    indexed.set(job.id.toLowerCase(), job);
  }
  const entries = fs.opendirSync(at(scope.jobs.fd, "."));
  let examined = 0;
  try {
    for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
      if (++examined % 32 === 0) scope.check(); else scope.checkTime();
      if (performance.now() >= deadline) fail("inventory deadline exceeded");
      const folded = entry.name.toLowerCase();
      if (names.has(folded) || names.size >= INVENTORY_LIMIT || !entry.isFile()) fail("ambiguous or excessive job artifacts");
      names.add(folded);
      const match = /^(.*)\.(json|log)$/.exec(entry.name);
      if (!match || indexed.get(match[1].toLowerCase())?.id !== match[1]) fail("unrecognized job artifact");
    }
  } finally { entries.closeSync(); }
  let total = 0;
  examined = 0;
  for (const job of state.jobs) {
    if (++examined % 32 === 0) scope.check(); else scope.checkTime();
    if (performance.now() >= deadline) fail("inventory deadline exceeded");
    const expectedName = `${job.id}.json`, present = names.has(expectedName.toLowerCase());
    let file;
    if (!present && restored?.id === job.id) file = restored.file;
    else {
      if (!present) fail("indexed detail is missing");
      file = readFile(scope, scope.jobs, expectedName, INDEX_LIMIT, true, false, false);
    }
    total += file.data.length;
    if (total > INDEX_LIMIT) fail("detail inventory exceeds byte budget");
    const detail = parse(file.data);
    if (!detail || detail.id !== job.id) fail("detail job identity differs");
    details.set(job.id, { detail, file });
  }
  const jobsDir = path.join(scope.context.stateDir, "jobs");
  for (const job of state.jobs) {
    scope.checkTime();
    for (const record of [job, details.get(job.id).detail]) {
      const reference = record.logFile;
      if (reference == null) continue;
      if (typeof reference !== "string" || !path.isAbsolute(reference) || path.resolve(reference) !== reference ||
          path.dirname(reference) !== jobsDir) fail("unverified log reference");
      const name = path.basename(reference), match = /^(.*)\.log$/.exec(name);
      if (!match || indexed.get(match[1].toLowerCase())?.id !== match[1]) fail("log reference has an unknown owner");
    }
  }
  fs.fsyncSync(scope.jobs.fd); scope.check();
  return { names, details };
}
function resumeProtected(scope, state, records, epoch) {
  const sorted = [...state.jobs].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  const protectedIds = new Set(), sessions = new Set();
  for (const job of sorted) {
    scope.checkTime();
    const detail = records.details.get(job.id)?.detail;
    if ((job.jobClass === "task" || detail?.jobClass === "task") &&
        ["epoch", "jobClass", "sessionId", "grokSessionId", "taskSessionResumable", "terminationPending", "status"]
          .some(key => (job[key] ?? null) !== (detail?.[key] ?? null))) fail("resume candidate records disagree");
    if (job.epoch !== epoch || detail?.epoch !== epoch || job.jobClass !== "task" || !job.grokSessionId ||
        job.taskSessionResumable === false || job.terminationPending === true || !["completed", "failed", "cancelled"].includes(job.status)) continue;
    if (job.sessionId != null && typeof job.sessionId !== "string") fail("resume session is invalid");
    if (!protectedIds.size) protectedIds.add(job.id);
    if (job.sessionId && !sessions.has(job.sessionId)) { sessions.add(job.sessionId); protectedIds.add(job.id); }
  }
  return protectedIds;
}
function sharedLog(scope, state, records, target) {
  if (target.logFile == null) return false;
  return state.jobs.some(job => {
    scope.checkTime();
    return job.id !== target.id && (job.logFile === target.logFile || records.details.get(job.id)?.detail?.logFile === target.logFile);
  });
}
function sharedOwnerEvidence(scope, state, records, target) {
  return state.jobs.some(job => {
    scope.checkTime();
    if (job.id === target.id) return false;
    const detail = records.details.get(job.id)?.detail;
    return [job, detail].some(record => record && (record.claimToken === target.claimToken ||
      record.workerStopLeaseId === target.workerStopLeaseId || record.workerLease?.id === target.workerStopLeaseId));
  });
}
function reverseReferences(scope, state, records, candidates) {
  const aliases = new Map(), referenced = new Set(), jobsDir = path.join(scope.context.stateDir, "jobs");
  for (const job of candidates) {
    for (const value of [job.id, job.claimToken, job.workerStopLeaseId, path.join(jobsDir, `${job.id}.json`),
      path.join(jobsDir, `${job.id}.log`)]) {
      const owners = aliases.get(value) ?? new Set(); owners.add(job.id); aliases.set(value, owners);
    }
  }
  let visited = 0;
  const scan = (value, owner) => {
    const stack = [value];
    while (stack.length) {
      if (++visited > 500000) fail("reverse-reference inventory exceeds its node budget");
      if (visited % 64 === 0) scope.checkTime();
      const current = stack.pop();
      if (typeof current === "string") {
        for (const target of aliases.get(current) ?? []) if (target !== owner) referenced.add(target);
      } else if (current && typeof current === "object") {
        if (Array.isArray(current)) {
          if (current.length > 500000 - visited - stack.length) fail("reverse-reference inventory exceeds its node budget");
          for (const child of current) stack.push(child);
        } else {
          const entries = Object.entries(current);
          if (entries.length * 2 > 500000 - visited - stack.length) fail("reverse-reference inventory exceeds its node budget");
          for (const [key, child] of entries) { stack.push(key); stack.push(child); }
        }
      }
    }
  };
  for (const job of state.jobs) {
    scan(job, job.id);
    scan(records.details.get(job.id)?.detail, job.id);
  }
  for (const [key, value] of Object.entries(state)) if (key !== "jobs") { scan(key, null); scan(value, null); }
  scope.check();
  return referenced;
}
function chooseCandidates(scope, state, records) {
  const protectedIds = resumeProtected(scope, state, records, scope.context.epoch), eligible = [];
  const jobsDir = path.join(scope.context.stateDir, "jobs");
  for (const job of state.jobs) {
    scope.checkTime();
    const pair = records.details.get(job.id);
    if (!pair || !bytes(pair.detail).equals(pair.file.data) || !validCandidate(job, pair.detail, scope.context.epoch, jobsDir)) continue;
    eligible.push(job);
  }
  const allowed = filterLinuxHistoryUnreferenced({ context: scope.context, candidates: eligible.map(job => ({
    jobId: job.id, claimToken: job.claimToken, workerStopLeaseId: job.workerStopLeaseId })) });
  const verified = eligible.filter(job => allowed.has(job.id));
  verified.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  if (verified.length <= 50) return [];
  const referenced = reverseReferences(scope, state, records, verified.slice(50));
  // 最新 50 件を保持し、それより古い保全不要な候補だけを選ぶ。
  return verified.slice(50).reverse().filter(job => !protectedIds.has(job.id) && !referenced.has(job.id) &&
    !sharedLog(scope, state, records, job) && !sharedOwnerEvidence(scope, state, records, job));
}
const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const validIdentity = value => Boolean(value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === "dev,ino" && typeof value.dev === "string" && typeof value.ino === "string" &&
  /^[1-9][0-9]*$/.test(value.dev) && /^[1-9][0-9]*$/.test(value.ino));
const validDigest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function exists(dir, name) {
  try { fs.lstatSync(at(dir.fd, name)); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
function writeExclusive(scope, dir, name, data, limit = INDEX_LIMIT) {
  if (data.length > limit) fail("journal file exceeds its size limit");
  scope.check();
  const fd = fs.openSync(at(dir.fd, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const id = checked(fs.fstatSync(fd, { bigint: true }), false, limit);
    if (id.dev !== scope.root.identity.dev || fdMountId(fd) !== scope.mount) fail("journal file crosses mount");
    for (let offset = 0; offset < data.length;) {
      const count = fs.writeSync(fd, data, offset, data.length - offset);
      if (count <= 0) fail("journal write made no progress");
      offset += count;
    }
    fs.fsyncSync(fd);
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(at(dir.fd, name), { bigint: true });
    if (!same(id, checked(after, false, limit)) || !same(id, checked(named, false, limit)) ||
        !sameStamp(after, named) || after.size !== BigInt(data.length)) fail("journal file changed during write");
    scope.check(); return { id, digest: hash(data) };
  } finally { fs.closeSync(fd); }
}
function expectFile(file, expected) {
  if (!validIdentity(expected?.id) || !validDigest(expected?.digest) || !same(file.id, expected.id) || file.digest !== expected.digest) {
    fail("file evidence changed");
  }
}
function listJournal(scope) {
  const names = new Set(), dir = fs.opendirSync(at(scope.journal.fd, "."));
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (names.has(entry.name) || !["bootstrap", "index.prepared", "intent.tmp", "intent.json"].includes(entry.name) || !entry.isFile()) {
        fail("journal contains an unknown entry");
      }
      checked(fs.lstatSync(at(scope.journal.fd, entry.name), { bigint: true }), false);
      names.add(entry.name);
    }
  } finally { dir.closeSync(); }
  scope.check(); return names;
}
function removeOwned(scope, dir, name, expected = null) {
  if (!exists(dir, name)) return;
  const file = readFile(scope, dir, name, INDEX_LIMIT, false);
  if (expected) expectFile(file, expected);
  scope.check(); fs.unlinkSync(at(dir.fd, name)); fs.fsyncSync(dir.fd); scope.check();
}
function assertUnreferenced(scope, indexed) {
  assertLinuxHistoryUnreferenced({ context: scope.context, jobId: indexed.id, claimToken: indexed.claimToken,
    workerStopLeaseId: indexed.workerStopLeaseId });
}
function recover(scope) {
  const names = listJournal(scope);
  if (!names.size) return false;
  if (!names.has("bootstrap")) fail("journal bootstrap is missing");
  const bootFile = readFile(scope, scope.journal, "bootstrap", 4096);
  let boot;
  try { boot = parse(bootFile.data); }
  catch (error) {
    if (names.size !== 1) throw error;
    removeOwned(scope, scope.journal, "bootstrap", bootFile);
    return true;
  }
  if (!boot || boot.version !== 1 || boot.epoch !== scope.context.epoch || !UUID.test(boot.nonce ?? "") ||
      Object.keys(boot).sort().join(",") !== "epoch,nonce,version") fail("bootstrap evidence is invalid");
  if (!names.has("intent.json")) {
    for (const name of ["intent.tmp", "index.prepared"]) if (names.has(name)) removeOwned(scope, scope.journal, name);
    removeOwned(scope, scope.journal, "bootstrap", bootFile);
    return true;
  }
  if (names.has("intent.tmp")) fail("active intent and partial intent coexist");
  const intentFile = readFile(scope, scope.journal, "intent.json", 2 * 1024 * 1024);
  const intent = parse(intentFile.data);
  if (!intent || intent.version !== 1 || intent.epoch !== scope.context.epoch || intent.nonce !== boot.nonce ||
      Object.keys(intent).sort().join(",") !== "detail,epoch,indexed,jobId,jobs,journal,log,nonce,position,post,pre,root,version" ||
      !same(intent.root, scope.root.identity) || !same(intent.jobs, scope.jobs.identity) || !same(intent.journal, scope.journal.identity) ||
      !validIdentity(intent.root) || !validIdentity(intent.jobs) || !validIdentity(intent.journal) ||
      !validId(intent.jobId) || !validIdentity(intent.pre?.id) || !validDigest(intent.pre?.digest) ||
      !validIdentity(intent.post?.id) || !validDigest(intent.post?.digest) || !validIdentity(intent.detail?.id) ||
      !validDigest(intent.detail?.digest) || !Number.isInteger(intent.position) || intent.position < 0 || intent.position > INVENTORY_LIMIT ||
      intent.indexed?.id !== intent.jobId || (intent.log !== null && (!validIdentity(intent.log?.id) || !validDigest(intent.log?.digest))) ||
      Object.keys(intent.pre ?? {}).sort().join(",") !== "digest,id" || Object.keys(intent.post ?? {}).sort().join(",") !== "digest,id" ||
      Object.keys(intent.detail ?? {}).sort().join(",") !== "digest,evidence,id" ||
      (intent.log !== null && Object.keys(intent.log ?? {}).sort().join(",") !== "digest,id") ||
      !intent.detail.evidence || typeof intent.detail.evidence !== "object" || Array.isArray(intent.detail.evidence) ||
      Object.keys(intent.detail.evidence).sort().join(",") !== [...EVIDENCE, "workerLease"].sort().join(",")) fail("active intent evidence is invalid");
  const detail = intent.detail.evidence, current = readFile(scope, scope.root, "state.json"), state = parse(current.data);
  if (!state || !Array.isArray(state.jobs)) fail("current index is invalid");
  const pre = same(current.id, intent.pre.id) && current.digest === intent.pre.digest;
  const post = same(current.id, intent.post.id) && current.digest === intent.post.digest;
  if (!pre && !post) fail("index is neither the recorded pre-state nor post-state");
  let oldState;
  if (pre) {
    if (JSON.stringify(state.jobs[intent.position]) !== JSON.stringify(intent.indexed)) fail("pre-index job changed");
    oldState = state;
  } else {
    if (state.jobs.some(job => job?.id === intent.jobId) || intent.position > state.jobs.length) fail("post-index job is ambiguous");
    const jobs = [...state.jobs]; jobs.splice(intent.position, 0, intent.indexed); oldState = { ...state, jobs };
  }
  if (hash(bytes(oldState)) !== intent.pre.digest || hash(bytes({ ...oldState, jobs: oldState.jobs.filter(job => job.id !== intent.jobId) })) !== intent.post.digest ||
      oldState.jobs.filter(job => job?.id === intent.jobId).length !== 1 ||
      !validCandidate(intent.indexed, detail, scope.context.epoch, path.join(scope.context.stateDir, "jobs"))) fail("intent does not prove a safe deletion");
  const restored = { id: intent.jobId, file: { id: intent.detail.id, digest: intent.detail.digest, data: bytes(detail) } };
  const records = inventory(scope, oldState, post ? restored : null);
  if (sharedLog(scope, oldState, records, intent.indexed) || sharedOwnerEvidence(scope, oldState, records, intent.indexed) ||
      resumeProtected(scope, oldState, records, scope.context.epoch).has(intent.jobId)) fail("job has protected references");
  assertUnreferenced(scope, intent.indexed);
  if (!chooseCandidates(scope, oldState, records).some(job => job.id === intent.jobId)) fail("intent target is no longer an eligible candidate");
  if ((intent.indexed.logFile == null) !== (intent.log === null)) fail("log evidence and reference disagree");
  fs.fsyncSync(scope.jobs.fd);
  if (exists(scope.jobs, `${intent.jobId}.json`)) expectFile(readFile(scope, scope.jobs, `${intent.jobId}.json`), intent.detail);
  else if (pre) fail("pre-index detail is missing");
  if (exists(scope.jobs, `${intent.jobId}.log`)) {
    if (!intent.log) fail("unreferenced log appeared");
    expectFile(readFile(scope, scope.jobs, `${intent.jobId}.log`, INDEX_LIMIT, false), intent.log);
  } else if (pre && intent.log) fail("pre-index log is missing");
  if (pre) {
    expectFile(records.details.get(intent.jobId).file, intent.detail);
    if (!names.has("index.prepared")) {
      // rename の片側だけが耐久化された場合、旧 inode と新 inode を同一視せず中止する。
      removeOwned(scope, scope.journal, "intent.json", intentFile);
      removeOwned(scope, scope.journal, "bootstrap", bootFile);
      return true;
    }
    expectFile(readFile(scope, scope.journal, "index.prepared"), intent.post);
    scope.check(); fs.renameSync(at(scope.journal.fd, "index.prepared"), at(scope.root.fd, "state.json"));
    fs.fsyncSync(scope.journal.fd); fs.fsyncSync(scope.root.fd); scope.check();
  } else if (names.has("index.prepared")) fail("post-index retains a prepared index");
  // post の観測だけでは rename の両親 directory の耐久化を推測しない。
  fs.fsyncSync(scope.journal.fd); fs.fsyncSync(scope.root.fd); scope.check();
  if (exists(scope.jobs, `${intent.jobId}.json`)) removeOwned(scope, scope.jobs, `${intent.jobId}.json`, intent.detail);
  if (intent.log && exists(scope.jobs, `${intent.jobId}.log`)) removeOwned(scope, scope.jobs, `${intent.jobId}.log`, intent.log);
  fs.fsyncSync(scope.jobs.fd); fs.fsyncSync(scope.root.fd); fs.fsyncSync(scope.journal.fd);
  removeOwned(scope, scope.journal, "intent.json", intentFile);
  removeOwned(scope, scope.journal, "bootstrap", bootFile);
  return true;
}
function begin(scope) {
  recover(scope);
  const current = readFile(scope, scope.root, "state.json"), state = parse(current.data);
  if (!state || !Array.isArray(state.jobs) || !bytes(state).equals(current.data)) fail("index is not canonical");
  const records = inventory(scope, state, null, performance.now() + 20000);
  const candidates = chooseCandidates(scope, state, records);
  const boot = { version: 1, epoch: scope.context.epoch, nonce: randomUUID() };
  const makeIntent = (candidate, candidateLog, post) => {
    const pair = records.details.get(candidate.id), detail = pair.file;
    return { version: 1, epoch: scope.context.epoch, nonce: boot.nonce, root: scope.root.identity,
      jobs: scope.jobs.identity, journal: scope.journal.identity, jobId: candidate.id,
      position: state.jobs.findIndex(job => job.id === candidate.id), indexed: candidate,
      pre: { id: current.id, digest: current.digest }, post,
      detail: { id: detail.id, digest: detail.digest,
        evidence: Object.fromEntries([...EVIDENCE, "workerLease"].map(key => [key, pair.detail[key] ?? null])) },
      log: candidateLog && { id: candidateLog.id, digest: candidateLog.digest } };
  };
  let selected = null, log = null;
  for (const candidate of candidates) {
    scope.checkTime();
    try {
      if (candidate.logFile == null && exists(scope.jobs, `${candidate.id}.log`)) continue;
      log = candidate.logFile == null ? null : readFile(scope, scope.jobs, `${candidate.id}.log`, INDEX_LIMIT, false);
      // inode は unsigned 64-bit の最大桁数で見積もり、実際の intent 全体を直列化する。
      const maximumPost = { id: { dev: "9".repeat(20), ino: "9".repeat(20) }, digest: "0".repeat(64) };
      if (bytes(makeIntent(candidate, log, maximumPost)).length > 2 * 1024 * 1024) continue;
      selected = candidate; break;
    } catch { /* 証明できないログは保持し、次候補を調べる。 */ }
  }
  if (!selected) return false;
  const postBytes = bytes({ ...state, jobs: state.jobs.filter(job => job.id !== selected.id) });
  if (postBytes.length > INDEX_LIMIT) fail("prepared index exceeds its limit");
  // publication に必要な index と証拠の余裕を、書込みの前に確保する。
  const available = fs.statfsSync(scope.context.stateDir, { bigint: true });
  scope.check();
  const reserve = BigInt(postBytes.length + 3 * 2 * 1024 * 1024 + 64 * 1024 * 1024);
  if (available.bavail * available.bsize < reserve) fail("insufficient filesystem headroom");
  writeExclusive(scope, scope.journal, "bootstrap", bytes(boot), 4096);
  fs.fsyncSync(scope.journal.fd); scope.check();
  const post = writeExclusive(scope, scope.journal, "index.prepared", postBytes);
  fs.fsyncSync(scope.journal.fd); scope.check();
  const intent = makeIntent(selected, log, post);
  const preparedIntent = writeExclusive(scope, scope.journal, "intent.tmp", bytes(intent), 2 * 1024 * 1024);
  expectFile(readFile(scope, scope.journal, "intent.tmp", 2 * 1024 * 1024), preparedIntent);
  scope.check(); fs.renameSync(at(scope.journal.fd, "intent.tmp"), at(scope.journal.fd, "intent.json"));
  fs.fsyncSync(scope.journal.fd); scope.check();
  return recover(scope);
}

// Linux の履歴削除は durable journal とその回復が統合されるまで有効にしない。
// 途中記録を旧 v4 writer に渡してはならない。
function rejectUnintegratedTransaction() {
  throw new Error("Linux history prune is disabled pending state capability and protocol integration");
}

// mutex と root FD を確立した後、通常 inventory より前に呼び出す予定。
export function recoverLinuxHistory(context) {
  assertLinuxHistoryTransactionContext(context);
  rejectUnintegratedTransaction();
  return withScope(context, recover);
}

// 通常 commit の成功後、同じ mutex 内で呼び出す予定。
export function pruneLinuxHistory(context) {
  assertLinuxHistoryTransactionContext(context);
  rejectUnintegratedTransaction();
  return withScope(context, begin);
}
