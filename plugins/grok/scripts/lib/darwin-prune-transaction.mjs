import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getProtectedDarwinJobIds, verifyPublishedDarwinLeaseRecords, verifyDarwinStopCertificate, verifyDarwinStopCertificateSnapshot } from "./darwin-lease-sweep.mjs";
import * as stateApi from "./state.mjs";

// この module は v4 state mutex の有効な context 内だけで呼ぶ。
// 固定名の不完全な記録は保全し、自動的に推測・削除しない。
const MARKER = "darwin-prune-v1.json";
const PHASE = "darwin-prune-proof-removing-v1.json";
const PREPARED = "darwin-prune-index.prepared";
const LIMIT = 8 * 1024 * 1024;
const DETAIL_LIMIT = 1024 * 1024;
const LOG_LIMIT = 64 * 1024 * 1024;
const MARKER_LIMIT = 2 * 1024 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE = ["id", "status", "epoch", "claimToken", "createdAt", "startedAt", "completedAt", "pid", "processStartKey",
  "terminationPending", "grokPromptState", "grokSessionId", "grokTransport", "grokBrokerGeneration", "grokDirectGeneration",
  "grokDirectOwnerPid", "grokDirectOwnerStartKey", "grokDirectStopGeneration", "grokDirectStopKind", "grokDirectStopConfirmedAt",
  "workerStopConfirmed", "workerStopProof", "workerStopLeaseId", "workerStopProcessStartKey"];

function fail(message) { throw new Error(`Darwin prune: ${message}`); }
// v4 の旧 writer 排除・WAL 統合と独立審査が完了するまでは、
// 正規の mutex capability を持つ呼出しも transaction に入れない。
function rejectUnintegratedTransaction() { fail("transaction is disabled pending integration"); }
function same(a, b) { return a?.dev === b?.dev && a?.ino === b?.ino; }
function checked(stat, directory = false) {
  if (!(directory ? stat.isDirectory() : stat.isFile()) || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o077n) !== 0n || stat.dev <= 0n || stat.ino <= 0n || (!directory && stat.nlink !== 1n)) fail("invalid file identity or permissions");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function digest(data) { return createHash("sha256").update(data).digest("hex"); }
function exists(name) {
  try { fs.lstatSync(name); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
function directory(name, expected) {
  const result = checked(fs.lstatSync(name, { bigint: true }), true);
  if (expected && !same(result, expected)) fail("directory identity changed");
  return result;
}
function syncDirectory(name, expected) {
  const before = directory(name, expected);
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!same(checked(fs.fstatSync(fd, { bigint: true }), true), before)) fail("directory descriptor changed");
    fs.fsyncSync(fd);
    directory(name, before);
  } finally { fs.closeSync(fd); }
}
function checkContext(context) {
  if (process.platform !== "darwin" || typeof process.getuid !== "function" || !fs.constants.O_NOFOLLOW || !fs.constants.O_NONBLOCK
      || !context || context.protocol !== "posix-local-v4" || typeof context.check !== "function"
      || typeof context.stateDir !== "string" || !path.isAbsolute(context.stateDir) || !UUID.test(context.epoch)) fail("invalid v4 state context");
  const assertMutex = /** @type {any} */ (stateApi).assertDarwinPruneContext;
  if (typeof assertMutex !== "function") fail("state mutex capability verifier is unavailable");
  assertMutex(context);
  context.check();
  directory(context.stateDir, context.directoryIdentity);
}
function readFile(name, parent, parentId, limit = LIMIT, includeData = true, deadline = Infinity, check = undefined) {
  if (check) check();
  if (performance.now() >= deadline) fail("prune selection deadline exceeded");
  directory(parent, parentId);
  const before = fs.lstatSync(name, { bigint: true });
  const id = checked(before);
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!same(id, checked(opened)) || opened.size > BigInt(limit)) fail("file identity or size changed");
    let data, hash;
    if (includeData) data = fs.readFileSync(fd);
    else {
      const hasher = createHash("sha256"), block = Buffer.allocUnsafe(64 * 1024);
      let length = 0, count;
      while ((count = fs.readSync(fd, block, 0, block.length, null)) > 0) {
        if (check) check();
        if (performance.now() >= deadline) fail("prune selection deadline exceeded");
        hasher.update(block.subarray(0, count)); length += count;
      }
      if (BigInt(length) !== opened.size) fail("file size changed while hashing");
      hash = hasher.digest("hex");
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (!same(id, checked(after)) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
        || (includeData && BigInt(data.length) !== opened.size)) fail("file changed while reading");
    fs.fsyncSync(fd);
    const synced = fs.fstatSync(fd, { bigint: true });
    if (!same(id, checked(synced)) || synced.size !== opened.size || synced.mtimeNs !== opened.mtimeNs || synced.ctimeNs !== opened.ctimeNs
        || !same(id, checked(fs.lstatSync(name, { bigint: true })))) fail("file changed while syncing");
    syncDirectory(parent, parentId);
    return { id, digest: includeData ? digest(data) : hash, data };
  } finally { fs.closeSync(fd); }
}
function writeExclusive(name, data) {
  const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, data);
    const id = checked(fs.fstatSync(fd, { bigint: true }));
    fs.fsyncSync(fd);
    return id;
  } finally { fs.closeSync(fd); }
}
function parse(data) {
  try { return JSON.parse(data.toString("utf8")); } catch { fail("invalid JSON evidence"); }
}
function bytes(text) {
  if (typeof text !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) fail("invalid encoded evidence");
  const result = Buffer.from(text, "base64");
  if (result.length > DETAIL_LIMIT || result.toString("base64") !== text) fail("encoded evidence is too large or noncanonical");
  return result;
}
function validIdentity(id) { return id && Object.keys(id).length === 2 && /^[1-9][0-9]*$/.test(id.dev) && /^[1-9][0-9]*$/.test(id.ino); }
function validDigest(value) { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function validRecord(record, detail, jobs, epoch, jobsDir) {
  if (!record || !detail || typeof record.id !== "string" || Buffer.byteLength(record.id) > 200 || !ID.test(record.id)
      || !["completed", "failed", "cancelled"].includes(record.status) || typeof record.createdAt !== "string" || !record.createdAt.trim()
      || record.epoch !== epoch || detail.epoch !== epoch || record.terminationPending !== false || detail.terminationPending !== false
      || record.workerLease != null || detail.workerLease != null || record.pid != null || detail.pid != null
      || !["terminal", "not-sent"].includes(record.grokPromptState) || !EVIDENCE.every(key => (record[key] ?? null) === (detail[key] ?? null))
      || record.workerStopConfirmed !== true || detail.workerStopConfirmed !== true
      || (record.logFile ?? null) !== (detail.logFile ?? null)
      || (record.logFile != null && (typeof record.logFile !== "string" || !path.isAbsolute(record.logFile)
        || path.resolve(record.logFile) !== path.join(jobsDir, `${record.id}.log`)))
      || jobs.filter(job => typeof job?.id === "string" && job.id.toLowerCase() === record.id.toLowerCase()).length !== 1) return false;
  // worker と turn の停止は別途、固定 certificate 検証器で確認する。
  return true;
}
function recordFile(file) { return { id: file.id, digest: file.digest, data: file.data.toString("base64") }; }
function rawFile(file) { return { id: file.id, digest: file.digest }; }
function assertFile(current, expected) {
  if (!validIdentity(expected?.id) || !validDigest(expected?.digest) || !same(current.id, expected.id) || current.digest !== expected.digest) fail("file evidence changed");
}
function ensureNames(jobsDir, id) {
  const names = fs.readdirSync(jobsDir);
  if (names.length > 4096) fail("jobs directory exceeds its limit");
  for (const name of [`${id}.json`, `${id}.log`]) {
    const aliases = names.filter(item => item.toLowerCase() === name.toLowerCase());
    if (aliases.length > 1 || (aliases.length === 1 && aliases[0] !== name)) fail("job artifact name is ambiguous");
  }
}
function verifyInventory(context, state, jobsDir, jobsId, targetId, targetDetail, targetLease, allowRemovedTarget, deadline = Infinity) {
  if (!Array.isArray(state.jobs) || state.jobs.length > 4096) fail("index exceeds reverse-reference limit");
  const records = new Map(), names = new Map(), inodes = new Set();
  for (const job of state.jobs) {
    if (!job || typeof job.id !== "string" || !ID.test(job.id) || Buffer.byteLength(job.id) > 200 || records.has(job.id.toLowerCase())) {
      fail("invalid or ambiguous indexed job");
    }
    records.set(job.id.toLowerCase(), job);
  }
  const protectedJobs = getProtectedDarwinJobIds({ stateDir: context.stateDir, epoch: context.epoch });
  for (const id of protectedJobs) if (records.get(id.toLowerCase())?.id !== id) fail("ledger job has no matching index");
  for (const name of fs.readdirSync(jobsDir)) {
    context.check();
    if (performance.now() >= deadline) fail("prune selection deadline exceeded");
    const folded = name.toLowerCase();
    if (names.has(folded) || names.size >= 4096) fail("ambiguous or excessive job artifacts");
    names.set(folded, name);
    const match = /^(.*)\.(json|log|worker-stop-proof)$/.exec(name);
    if (!match || !records.has(match[1].toLowerCase()) || records.get(match[1].toLowerCase()).id !== match[1]) fail("unknown job artifact");
    checked(fs.lstatSync(path.join(jobsDir, name), { bigint: true }));
  }
  let total = 0;
  for (const job of records.values()) {
    context.check();
    if (performance.now() >= deadline) fail("prune selection deadline exceeded");
    const detailName = `${job.id}.json`, logName = `${job.id}.log`;
    const present = names.get(detailName.toLowerCase()) === detailName;
    if (!present && !(allowRemovedTarget && job.id === targetId)) fail("indexed job detail is absent");
    const file = present ? readFile(path.join(jobsDir, detailName), jobsDir, jobsId, LIMIT, true, deadline, context.check) : targetDetail;
    total += file.data.length;
    if (total > LIMIT) fail("job detail inventory exceeds its byte limit");
    if (present) {
      const key = `${file.id.dev}:${file.id.ino}`;
      if (inodes.has(key)) fail("duplicate job detail identity");
      inodes.add(key);
    }
    const detail = parse(file.data);
    if (!detail || detail.id !== job.id || (job.logFile ?? null) !== (detail.logFile ?? null)) fail("job detail or log reference disagrees");
    if ((job.workerLease == null) !== (detail.workerLease == null)) fail("job lease references disagree");
    if (protectedJobs.has(job.id) !== (job.workerLease != null)) fail("ledger and job lease references disagree");
    if (job.workerLease != null) {
      const lease = job.workerLease;
      if (lease.id === targetLease.id || lease.path === targetLease.path
          || (lease.dev === targetLease.dev && lease.ino === targetLease.ino)) fail("another job references the target lease");
      verifyPublishedDarwinLeaseRecords({ context, indexed: job, stored: detail, lease });
    }
    if (job.logFile != null && (typeof job.logFile !== "string" || !path.isAbsolute(job.logFile)
      || path.resolve(job.logFile) !== path.join(jobsDir, logName))) fail("job log reference is not canonical");
    if (job.logFile == null && names.has(logName.toLowerCase())) fail("unreferenced log must be preserved");
  }
  directory(jobsDir, jobsId);
}
function indexAfter(state, id) {
  return Buffer.from(`${JSON.stringify({ ...state, jobs: state.jobs.filter(job => job.id !== id) }, null, 2)}\n`);
}
function markerEvidence(marker, context, jobsDir, jobsId, current) {
  if (!marker || marker.version !== 1 || marker.epoch !== context.epoch || !same(marker.root, context.directoryIdentity)
      || !same(marker.jobs, jobsId) || !validIdentity(marker.root) || !validIdentity(marker.jobs)
      || typeof marker.jobId !== "string" || !ID.test(marker.jobId) || Buffer.byteLength(marker.jobId) > 200
      || !validIdentity(marker.pre?.id) || !validDigest(marker.pre?.digest) || !validIdentity(marker.post?.id)
      || !validDigest(marker.post?.digest) || !validIdentity(marker.detail?.id) || !validDigest(marker.detail?.digest)
      || !Number.isInteger(marker.position) || marker.position < 0 || marker.position > 4096 || marker.indexed?.id !== marker.jobId
      || !validIdentity(marker.certificate?.id) || !validDigest(marker.certificate?.digest)
      || (marker.log !== null && (!validIdentity(marker.log?.id) || !validDigest(marker.log?.digest)))) fail("invalid marker evidence");
  const detail = bytes(marker.detail.data);
  if (digest(detail) !== marker.detail.digest) fail("marker evidence digest mismatch");
  const currentState = parse(current.data), stored = parse(detail);
  if (!currentState || !Array.isArray(currentState.jobs)) fail("invalid current index");
  let state;
  if (current.digest === marker.pre.digest && same(current.id, marker.pre.id)) {
    state = currentState;
    if (JSON.stringify(state.jobs[marker.position]) !== JSON.stringify(marker.indexed)) fail("marker index record changed");
  } else if (current.digest === marker.post.digest && same(current.id, marker.post.id)) {
    if (marker.position > currentState.jobs.length || currentState.jobs.some(job => job?.id === marker.jobId)) fail("invalid post index");
    const jobs = [...currentState.jobs];
    jobs.splice(marker.position, 0, marker.indexed);
    state = { ...currentState, jobs };
  } else fail("index is neither the recorded pre-state nor post-state");
  const pre = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  if (pre.length > LIMIT || digest(pre) !== marker.pre.digest) fail("pre-index reconstruction differs");
  if (!state || !Array.isArray(state.jobs) || state.jobs.length > 4096) fail("invalid marker index");
  const selected = state.jobs.filter(job => job?.id === marker.jobId);
  if (selected.length !== 1 || !validRecord(selected[0], stored, state.jobs, context.epoch, jobsDir)
      || digest(indexAfter(state, marker.jobId)) !== marker.post.digest) fail("marker does not prove a valid index removal");
  if (selected[0].logFile == null && marker.log !== null) fail("marker contains an unreferenced log");
  const certificateBytes = bytes(marker.certificate.data);
  const expectedCertificate = { path: path.join(jobsDir, `${marker.jobId}.worker-stop-proof`),
    dev: marker.certificate.id.dev, ino: marker.certificate.id.ino, sha256: marker.certificate.digest };
  verifyDarwinStopCertificateSnapshot({ context, indexed: selected[0], stored, certificateBytes, expectedCertificate });
  if (getProtectedDarwinJobIds({ stateDir: context.stateDir, epoch: context.epoch }).has(marker.jobId)) fail("job remains protected by a lease");
  return { state, detail, stored, indexed: selected[0], expectedCertificate, targetLease: parse(certificateBytes).lease };
}
function removeArtifact(context, name, parent, parentId, expected) {
  if (!exists(name)) return;
  if (!expected) fail("unexpected artifact appeared");
  assertFile(readFile(name, parent, parentId, LOG_LIMIT, false, Infinity, context.check), expected);
  context.check();
  fs.unlinkSync(name);
}

// marker が存在すれば pre/post と成果物の証拠をすべて照合してから続行する。
// marker 不在の prepared は発行前に中断した証拠であり、保全して拒否する。
export function recoverDarwinPrune(context) {
  rejectUnintegratedTransaction();
  checkContext(context);
  const root = context.stateDir, jobsDir = path.join(root, "jobs"), markerPath = path.join(root, MARKER),
    phasePath = path.join(root, PHASE), preparedPath = path.join(root, PREPARED);
  const hasMarker = exists(markerPath), hasPhase = exists(phasePath);
  if (!hasMarker && !hasPhase) {
    if (exists(preparedPath)) fail("unconfirmed prepared index requires offline investigation");
    return false;
  }
  const jobsId = directory(jobsDir);
  if (jobsId.dev !== context.directoryIdentity.dev) fail("jobs directory is on another device");
  const phaseFile = hasPhase ? readFile(phasePath, root, context.directoryIdentity, MARKER_LIMIT + 4096) : null;
  const phase = phaseFile ? parse(phaseFile.data) : null;
  if (hasPhase && (!phase || phase.version !== 1 || !validIdentity(phase.markerId) || !validDigest(phase.markerDigest) || !phase.marker)) fail("invalid proof-removing phase");
  const phaseMarkerBytes = phase ? Buffer.from(`${JSON.stringify(phase.marker)}\n`) : null;
  if (phase && (phaseMarkerBytes.length > MARKER_LIMIT || digest(phaseMarkerBytes) !== phase.markerDigest)) fail("phase marker evidence changed");
  const markerFile = hasMarker ? readFile(markerPath, root, context.directoryIdentity, MARKER_LIMIT)
    : { id: phase.markerId, digest: phase.markerDigest, data: phaseMarkerBytes };
  if (phase && (!same(markerFile.id, phase.markerId) || markerFile.digest !== phase.markerDigest)) fail("phase and transaction markers disagree");
  const marker = parse(markerFile.data);
  const statePath = path.join(root, "state.json");
  const current = readFile(statePath, root, context.directoryIdentity);
  const evidence = markerEvidence(marker, context, jobsDir, jobsId, current);
  ensureNames(jobsDir, marker.jobId);
  const detailPath = path.join(jobsDir, `${marker.jobId}.json`), logPath = path.join(jobsDir, `${marker.jobId}.log`),
    proofPath = path.join(jobsDir, `${marker.jobId}.worker-stop-proof`);
  if (current.digest === marker.pre.digest && same(current.id, marker.pre.id)) {
    if (hasPhase || !hasMarker) fail("proof-removing phase cannot precede index commit");
    // 未 commit なら成果物を触らず、証明済みの prepared と marker のみ回収する。
    // prepared unlink 後の再中断でも marker を使ってこの中止を再開できる。
    context.check();
    if (exists(preparedPath)) {
      assertFile(readFile(preparedPath, root, context.directoryIdentity), marker.post);
      fs.unlinkSync(preparedPath);
    }
    syncDirectory(root, context.directoryIdentity);
    context.check();
    assertFile(readFile(markerPath, root, context.directoryIdentity, MARKER_LIMIT), markerFile);
    fs.unlinkSync(markerPath);
    syncDirectory(root, context.directoryIdentity);
    return true;
  } else if (current.digest !== marker.post.digest || !same(current.id, marker.post.id) || exists(preparedPath)) {
    fail("index is neither the recorded pre-state nor post-state");
  }
  context.check();
  assertFile(readFile(statePath, root, context.directoryIdentity), marker.post);
  verifyInventory(context, evidence.state, jobsDir, jobsId, marker.jobId, { data: evidence.detail }, evidence.targetLease, true);
  if (hasPhase) {
    if (exists(detailPath) || exists(logPath)) fail("proof-removing phase has remaining artifacts");
    if (exists(proofPath)) {
      verifyDarwinStopCertificate({ context, indexed: evidence.indexed, stored: evidence.stored, expectedCertificate: evidence.expectedCertificate });
      removeArtifact(context, proofPath, jobsDir, jobsId, marker.certificate);
    }
    syncDirectory(jobsDir, jobsId);
    context.check();
    if (hasMarker) {
      assertFile(readFile(markerPath, root, context.directoryIdentity, MARKER_LIMIT), markerFile);
      fs.unlinkSync(markerPath);
      syncDirectory(root, context.directoryIdentity);
    } else syncDirectory(root, context.directoryIdentity);
    assertFile(readFile(phasePath, root, context.directoryIdentity, MARKER_LIMIT + 4096), phaseFile);
    fs.unlinkSync(phasePath);
    syncDirectory(root, context.directoryIdentity);
    return true;
  }
  // proof 自体は最後まで残し、先行 crash と証明欠落を区別する。
  verifyDarwinStopCertificate({ context, indexed: evidence.indexed, stored: evidence.stored, expectedCertificate: evidence.expectedCertificate });
  // 両方を先に確認し、変更された片方を発見した後に他方を削除しない。
  if (exists(detailPath)) assertFile(readFile(detailPath, jobsDir, jobsId), marker.detail);
  if (exists(logPath)) {
    if (marker.log === null) fail("unexpected log appeared");
    assertFile(readFile(logPath, jobsDir, jobsId, LOG_LIMIT, false, Infinity, context.check), marker.log);
  }
  removeArtifact(context, detailPath, jobsDir, jobsId, marker.detail);
  removeArtifact(context, logPath, jobsDir, jobsId, marker.log);
  syncDirectory(jobsDir, jobsId);
  context.check();
  assertFile(readFile(markerPath, root, context.directoryIdentity, MARKER_LIMIT), markerFile);
  verifyDarwinStopCertificate({ context, indexed: evidence.indexed, stored: evidence.stored, expectedCertificate: evidence.expectedCertificate });
  const phaseData = Buffer.from(`${JSON.stringify({ version: 1, markerId: markerFile.id, markerDigest: markerFile.digest, marker })}\n`);
  if (phaseData.length > MARKER_LIMIT + 4096) fail("proof-removing phase exceeds its limit");
  writeExclusive(phasePath, phaseData);
  syncDirectory(root, context.directoryIdentity);
  return recoverDarwinPrune(context);
}

// 通常 commit / afterSave / aroundCommit の成功後、同一 mutex 内で独立実行する。
export function pruneDarwinHistory(context) {
  rejectUnintegratedTransaction();
  checkContext(context);
  recoverDarwinPrune(context);
  const deadline = performance.now() + 5000;
  let warned = false;
  function warn() {
    if (warned) return;
    warned = true;
    try { process.stderr.write("Grok history prune was deferred because evidence or the selection budget was unavailable.\n"); }
    catch { /* 診断失敗でも未確認の履歴は保全する。 */ }
  }
  const root = context.stateDir, jobsDir = path.join(root, "jobs"), jobsId = directory(jobsDir);
  if (jobsId.dev !== context.directoryIdentity.dev) fail("jobs directory is on another device");
  const statePath = path.join(root, "state.json"), markerPath = path.join(root, MARKER), preparedPath = path.join(root, PREPARED);
  let removed = 0;
  for (;;) {
    context.check();
    const pre = readFile(statePath, root, context.directoryIdentity, LIMIT, true, deadline), state = parse(pre.data);
    if (!state || !Array.isArray(state.jobs) || state.jobs.length > 4096) fail("invalid state index");
    const protectedJobs = getProtectedDarwinJobIds({ stateDir: root, epoch: context.epoch });
    let retainedTerminal = 0, candidate;
    for (const job of [...state.jobs].sort((a, b) => String(b?.updatedAt ?? "").localeCompare(String(a?.updatedAt ?? "")))) {
      context.check();
      if (performance.now() >= deadline) { warn(); return removed; }
      if (!job || !["completed", "failed", "cancelled"].includes(job.status) || job.terminationPending === true) continue;
      // 新しい50件は証拠の有無にかかわらず保持し、以降だけ詳細を検査する。
      if (++retainedTerminal <= 50) continue;
      if (typeof job.id !== "string" || !ID.test(job.id) || Buffer.byteLength(job.id) > 200 || protectedJobs.has(job.id)) continue;
      try {
        ensureNames(jobsDir, job.id);
        const detailPath = path.join(jobsDir, `${job.id}.json`), logPath = path.join(jobsDir, `${job.id}.log`);
        const detail = readFile(detailPath, jobsDir, jobsId, DETAIL_LIMIT, true, deadline), stored = parse(detail.data);
        if (!validRecord(job, stored, state.jobs, context.epoch, jobsDir)) continue;
        const certificateInfo = verifyDarwinStopCertificate({ context, indexed: job, stored });
        const certificate = readFile(path.join(jobsDir, `${job.id}.worker-stop-proof`), jobsDir, jobsId, 64 * 1024, true, deadline);
        if (certificateInfo.dev !== certificate.id.dev || certificateInfo.ino !== certificate.id.ino || certificateInfo.sha256 !== certificate.digest) continue;
        const log = exists(logPath) ? readFile(logPath, jobsDir, jobsId, LOG_LIMIT, false, deadline, context.check) : null;
        if (job.logFile == null && log) continue;
        candidate = { job, detail, log, certificate };
        break;
      } catch { warn(); /* 不明な履歴は対象外として保全する。 */ }
    }
    if (!candidate) return removed;
    // 他 job の detail / log 参照も含めて全体が一意に対応しない限り、削除しない。
    try { verifyInventory(context, state, jobsDir, jobsId, candidate.job.id, candidate.detail, parse(candidate.certificate.data).lease, false, deadline); }
    catch { warn(); return removed; }
    if (performance.now() >= deadline) { warn(); return removed; }
    if (digest(Buffer.from(`${JSON.stringify(state, null, 2)}\n`)) !== pre.digest) fail("index is not canonical");
    const post = indexAfter(state, candidate.job.id);
    if (post.length > LIMIT) fail("post index exceeds its limit");
    if (Buffer.byteLength(JSON.stringify(candidate.job)) > DETAIL_LIMIT
        || Buffer.byteLength(JSON.stringify(candidate.job)) + Math.ceil(candidate.detail.data.length / 3) * 4
          + Math.ceil(candidate.certificate.data.length / 3) * 4 > MARKER_LIMIT - 4096) return removed;
    const postId = writeExclusive(preparedPath, post);
    syncDirectory(root, context.directoryIdentity);
    const marker = { version: 1, epoch: context.epoch, root: context.directoryIdentity, jobs: jobsId, jobId: candidate.job.id,
      pre: rawFile(pre), position: state.jobs.indexOf(candidate.job), indexed: candidate.job,
      post: { id: postId, digest: digest(post) }, detail: recordFile(candidate.detail),
      certificate: recordFile(candidate.certificate), log: candidate.log ? rawFile(candidate.log) : null };
    const encoded = Buffer.from(`${JSON.stringify(marker)}\n`);
    if (encoded.length > MARKER_LIMIT) fail("marker exceeds its limit");
    writeExclusive(markerPath, encoded);
    syncDirectory(root, context.directoryIdentity);
    context.check();
    assertFile(readFile(statePath, root, context.directoryIdentity), marker.pre);
    assertFile(readFile(preparedPath, root, context.directoryIdentity), marker.post);
    assertFile(readFile(path.join(jobsDir, `${candidate.job.id}.json`), jobsDir, jobsId, DETAIL_LIMIT), marker.detail);
    verifyDarwinStopCertificate({ context, indexed: candidate.job, stored: parse(candidate.detail.data),
      expectedCertificate: { path: path.join(jobsDir, `${candidate.job.id}.worker-stop-proof`),
        dev: candidate.certificate.id.dev, ino: candidate.certificate.id.ino, sha256: candidate.certificate.digest } });
    if (candidate.log) assertFile(readFile(path.join(jobsDir, `${candidate.job.id}.log`), jobsDir, jobsId, LOG_LIMIT, false, Infinity, context.check), marker.log);
    else if (exists(path.join(jobsDir, `${candidate.job.id}.log`))) fail("unexpected log appeared before index commit");
    fs.renameSync(preparedPath, statePath);
    syncDirectory(root, context.directoryIdentity);
    recoverDarwinPrune(context);
    return removed + 1;
  }
}
