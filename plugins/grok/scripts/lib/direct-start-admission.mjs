import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withStateSnapshot } from "./state.mjs";
import { requireLinuxEpochRecovery } from "./linux-epoch-recovery.mjs";

const DIRECTORY = "direct-start-v1";
const LINUX_DIRECTORY = "direct-start-v2";
const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MARKERS = 256;
const MAX_RECORD = 8192;
const MAX_FILE = MAX_RECORD * 3;
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const NONBLOCK = process.platform === "win32" ? 0 : (fs.constants.O_NONBLOCK ?? 0);
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function fail(detail) { throw new Error(`Direct startup admission ${detail}`); }
function boundedNames(dir, limit, context) {
  context.check();
  const handle = fs.opendirSync(dir), names = [];
  try {
    for (;;) {
      context.check();
      const entry = handle.readSync();
      if (!entry) break;
      names.push(entry.name);
      if (names.length > limit) fail("has too many directory entries");
    }
  } finally { handle.closeSync(); }
  context.check();
  return names;
}
function sameIdentity(a, b) {
  return a?.hostId === b?.hostId && a?.volumeGuid === b?.volumeGuid &&
    (process.platform !== "linux" || a?.epoch === b?.epoch) &&
    a?.directoryIdentity?.dev === b?.directoryIdentity?.dev && a?.directoryIdentity?.ino === b?.directoryIdentity?.ino;
}
function identity(context) {
  context.check();
  if (!context.hostId || !context.directoryIdentity?.dev || !context.directoryIdentity?.ino) fail("identity is unavailable");
  if (process.platform === "linux" && !EPOCH.test(context.epoch ?? "")) fail("epoch is unavailable");
  return { stateDir: context.stateDir, directoryIdentity: { ...context.directoryIdentity }, hostId: context.hostId, volumeGuid: context.volumeGuid,
    ...(process.platform === "linux" ? { epoch: context.epoch } : {}) };
}

/** 旧記録の照合と、現 epoch の broker entry の検証を同じ mutex 内で行う。 */
export function requireNoLegacyAdmission(context) {
  if (process.platform !== "linux") return;
  context.check();
  if (!EPOCH.test(context.epoch ?? "")) fail("epoch is unavailable");
  requireLinuxEpochRecovery(context);
  for (const name of ["broker-v3", LINUX_DIRECTORY]) {
    context.check();
    const root = path.join(context.stateDir, name);
    let stat;
    try { stat = fs.lstatSync(root); } catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${name} directory is invalid`);
    const entries = boundedNames(root, 65, context);
    for (const entry of entries) {
      context.check();
      if (!EPOCH.test(entry)) fail(`${name} has an unknown epoch requiring explicit offline recovery`);
      if (entry !== context.epoch) continue; // 旧 epoch は上の recovery 照合で検証済み。
      const child = fs.lstatSync(path.join(root, entry));
      if (!child.isDirectory() || child.isSymbolicLink()) fail(`${name} epoch directory is invalid`);
      if (name === "broker-v3") {
        const dir = path.join(root, entry), contents = boundedNames(dir, 3, context);
        for (const item of contents) {
          context.check();
          if (!["broker.json", "broker.lock", "broker-admission.jsonl"].includes(item)) fail("broker epoch contains an unknown entry");
          const stat = fs.lstatSync(path.join(dir, item));
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("broker epoch contains an invalid entry");
        }
      }
    }
  }
  context.check();
}
function syncDirectory(dir, context) {
  if (process.platform === "win32") return;
  context.check();
  const before = fs.lstatSync(dir, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) fail("directory is invalid");
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | NOFOLLOW | NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) fail("directory identity changed");
    context.check(); fs.fsyncSync(fd);
    const after = fs.lstatSync(dir, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) fail("directory identity changed");
  } finally { fs.closeSync(fd); }
  context.check();
}
function directory(context, create = false) {
  context.check();
  const root = process.platform === "linux" ? path.join(context.stateDir, LINUX_DIRECTORY) : context.stateDir;
  const dir = process.platform === "linux" ? path.join(root, context.epoch) : path.join(root, DIRECTORY);
  if (process.platform === "linux") {
    try {
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("directory is invalid");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!create) return null;
      context.check();
      try { fs.mkdirSync(root, { mode: 0o700 }); } catch (mkdirError) { if (mkdirError?.code !== "EEXIST") throw mkdirError; }
      const stat = fs.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("directory is invalid");
      syncDirectory(context.stateDir, context);
    }
  }
  let stat;
  try { stat = fs.lstatSync(dir); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!create) return null;
    context.check();
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (mkdirError) { if (mkdirError?.code !== "EEXIST") throw mkdirError; }
    syncDirectory(root, context);
    stat = fs.lstatSync(dir);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("directory is invalid");
  if (create) syncDirectory(root, context);
  return dir;
}
export function parseDirectStartAdmission(bytes, name) {
  if (bytes.length > MAX_FILE) fail("record exceeds its size limit");
  const value = bytes.toString("utf8");
  if (!Buffer.from(value).equals(bytes) || !value.endsWith("\n")) fail("record is incomplete or corrupt");
  const lines = value.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.length > 3 || lines.some(line => !line || Buffer.byteLength(line) > MAX_RECORD)) fail("record is invalid");
  let records;
  try { records = lines.map(line => JSON.parse(line)); } catch { fail("record is corrupt"); }
  const [pending, released, confirmed] = records;
  const generation = name.slice(0, -6);
  const owner = pending?.ownerIdentity;
  if (pending?.version !== 1 || pending.event !== "pending" || pending.generation !== generation ||
      !Number.isInteger(pending.ownerPid) || pending.ownerPid <= 0 || typeof owner?.stateDir !== "string" || !owner.stateDir ||
      typeof owner.hostId !== "string" || !owner.hostId || !(owner.volumeGuid === null || typeof owner.volumeGuid === "string") ||
      !/^[1-9][0-9]*$/.test(owner.directoryIdentity?.dev ?? "") || !/^[1-9][0-9]*$/.test(owner.directoryIdentity?.ino ?? "")) fail("owner record is invalid");
  if (released && (released.version !== 1 || released.event !== "released" || released.generation !== generation ||
      !["ready", "never-started", "posix-group-empty", "job-empty"].includes(released.proof))) fail("release record is invalid");
  if (confirmed && (confirmed.version !== 1 || confirmed.event !== "confirmed" || confirmed.generation !== generation ||
      confirmed.proof !== released?.proof)) fail("confirmation record is invalid");
  return { pending, released, confirmed };
}
function fileIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode), uid: String(stat.uid), gid: String(stat.gid) };
}
function sameFileIdentity(stat, expected) {
  const actual = fileIdentity(stat);
  return actual.dev === expected?.dev && actual.ino === expected?.ino && actual.mode === expected?.mode &&
    actual.uid === expected?.uid && actual.gid === expected?.gid;
}
function checkedMarker(stat, expected, size = undefined) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(MAX_FILE) ||
      (expected && !sameFileIdentity(stat, expected)) || (size !== undefined && stat.size !== size)) fail("marker file identity changed");
}
function checkOpenedMarker(fd, file, expected, size) {
  const opened = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
  checkedMarker(opened, expected, size);
  checkedMarker(current, expected, size);
}
function read(file, name, context) {
  context.check();
  const before = fs.lstatSync(file, { bigint: true });
  checkedMarker(before);
  const expected = fileIdentity(before);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    checkOpenedMarker(fd, file, expected, before.size);
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) { context.check(); const n = fs.readSync(fd, bytes, count, bytes.length - count, count); if (!n) break; count += n; }
    if (count !== Number(before.size)) fail("marker file size changed");
    const result = parseDirectStartAdmission(bytes.subarray(0, count), name);
    checkOpenedMarker(fd, file, expected, before.size);
    const end = fs.fstatSync(fd, { bigint: true }), after = fs.lstatSync(file, { bigint: true });
    if (end.mtimeNs !== before.mtimeNs || end.ctimeNs !== before.ctimeNs ||
        after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail("marker file changed while reading");
    context.check();
    return { ...result, fileIdentity: expected, fileSize: String(before.size) };
  } finally { fs.closeSync(fd); }
}
function append(file, record, context, expected) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (bytes.length > MAX_RECORD) fail("record exceeds its size limit");
  context.check();
  const before = fs.lstatSync(file, { bigint: true });
  checkedMarker(before, expected);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | NOFOLLOW | NONBLOCK);
  try {
    checkOpenedMarker(fd, file, expected, before.size);
    let offset = 0;
    while (offset < bytes.length) { context.check(); checkOpenedMarker(fd, file, expected, before.size + BigInt(offset)); const count = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (count <= 0) fail("write did not complete"); offset += count; }
    context.check(); fs.fsyncSync(fd);
    checkOpenedMarker(fd, file, expected, before.size + BigInt(bytes.length));
  } finally { fs.closeSync(fd); }
  context.check();
}
function syncExisting(file, context, expected) {
  context.check();
  const before = fs.lstatSync(file, { bigint: true });
  checkedMarker(before, expected);
  const fd = fs.openSync(file, fs.constants.O_RDWR | NOFOLLOW | NONBLOCK);
  try {
    checkOpenedMarker(fd, file, expected, before.size);
    context.check(); fs.fsyncSync(fd);
    checkOpenedMarker(fd, file, expected, before.size);
  } finally { fs.closeSync(fd); }
  context.check();
}
function entries(context, create = false) {
  const dir = directory(context, create);
  if (!dir) return { dir: null, markers: [] };
  context.check();
  const names = boundedNames(dir, MAX_MARKERS, context);
  const markers = names.map(name => {
    if (!NAME.test(name)) fail("contains an unknown entry");
    const marker = { name, file: path.join(dir, name), ...read(path.join(dir, name), name, context) };
    if (!sameIdentity(marker.pending.ownerIdentity, identity(context))) fail("record belongs to another state identity");
    return marker;
  });
  return { dir, markers };
}

/** broker pending の追記直前、同じ state mutex 内から呼ぶ。 */
export function requireNoDirectStart(context) {
  requireNoLegacyAdmission(context);
  const { markers } = entries(context);
  if (markers.some(marker => !marker.confirmed)) fail("has an unconfirmed owner; broker startup is blocked");
}

/** 複数 direct 起動は許すが、broker pending の検査と同一 mutex で予約する。 */
export function reserveDirectStart(cwd, validateBroker, { timeoutMs = 7500 } = {}) {
  return withStateSnapshot(cwd, (_state, context) => {
    const ownerIdentity = identity(context);
    requireNoLegacyAdmission(context);
    validateBroker(context);
    const { dir, markers } = entries(context, true);
    for (const marker of markers.filter(item => item.confirmed)) {
      context.check();
      checkedMarker(fs.lstatSync(marker.file, { bigint: true }), marker.fileIdentity);
      try { fs.unlinkSync(marker.file); } catch { /* 確認済み記録は回収できるまで保持する */ }
    }
    if (boundedNames(dir, MAX_MARKERS, context).length >= MAX_MARKERS) fail("has no capacity for another owner");
    const generation = randomUUID(), file = path.join(dir, `${generation}.jsonl`);
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, event: "pending", generation, ownerPid: process.pid, ownerIdentity })}\n`);
    if (bytes.length > MAX_RECORD) fail("owner record exceeds its size limit");
    context.check();
    let openedIdentity, markerIdentity, markerSize;
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n) fail("new owner file is invalid");
        openedIdentity = { dev: opened.dev, ino: opened.ino };
        markerIdentity = fileIdentity(opened);
        fs.writeFileSync(fd, bytes); context.check(); fs.fsyncSync(fd);
        checkOpenedMarker(fd, file, markerIdentity, BigInt(bytes.length));
        markerSize = String(bytes.length);
      } finally { fs.closeSync(fd); }
      syncDirectory(dir, context);
    } catch (error) {
      if (!openedIdentity) throw new Error(`Direct startup reservation failed before spawning; preserve ${file} and inspect it during explicit offline recovery: ${error?.message ?? error}`, { cause: error });
      try {
        context.check();
        const current = fs.lstatSync(file, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
            current.dev !== openedIdentity.dev || current.ino !== openedIdentity.ino) fail("new owner file identity changed before recovery");
        context.check();
        fs.unlinkSync(file);
        syncDirectory(dir, context);
      } catch (cleanupError) {
        throw new Error(`Direct startup reservation failed before spawning; recovery is unconfirmed at ${file}. Stop all runtimes and agents before explicit offline recovery: ${error?.message ?? error}`, { cause: cleanupError });
      }
      throw error;
    }
    return { generation, ownerIdentity, markerIdentity, markerSize, ...(process.platform === "linux" ? { epoch: context.epoch } : {}) };
  }, { timeoutMs, strictWorkspace: true });
}

/** 呼出元が保持する state mutex 内で予約と所有者を再検証する。 */
export function verifyDirectStartWithinContext(context, token) {
  if ((process.platform === "linux" && token?.epoch !== context.epoch) || !sameIdentity(identity(context), token?.ownerIdentity)) fail("epoch or identity changed before spawn");
  requireNoLegacyAdmission(context);
  const { markers } = entries(context);
  const marker = markers.find(item => item.pending.generation === token?.generation);
  if (!marker || marker.pending.ownerPid !== process.pid || !sameIdentity(marker.pending.ownerIdentity, token.ownerIdentity) ||
      marker.released || marker.confirmed || !token.markerIdentity || marker.fileSize !== token.markerSize ||
      !sameFileIdentity(marker.fileIdentity, token.markerIdentity)) fail("reservation marker identity or owner changed before spawn");
  context.check();
  return true;
}

/** spawn の直前に予約した marker と所有者を同一 mutex 下で再検証する。 */
export function verifyDirectStart(cwd, token, { timeoutMs = 7500 } = {}) {
  return withStateSnapshot(cwd, (_state, context) => verifyDirectStartWithinContext(context, token), { timeoutMs, strictWorkspace: true });
}

/** 自分の確定証拠を同期し、独立した確認記録を追加してから回収する。 */
export function finishDirectStart(cwd, token, proof, { timeoutMs = 7500 } = {}) {
  if (!["ready", "never-started", "posix-group-empty", "job-empty"].includes(proof)) return false;
  return withStateSnapshot(cwd, (_state, context) => {
    if (process.platform === "linux" && token?.epoch !== context.epoch) fail("epoch changed");
    requireNoLegacyAdmission(context);
    if (!sameIdentity(identity(context), token.ownerIdentity)) fail("state identity changed");
    const { dir, markers } = entries(context);
    const marker = markers.find(item => item.pending.generation === token.generation);
    if (!marker || marker.pending.ownerPid !== process.pid || !sameIdentity(marker.pending.ownerIdentity, token.ownerIdentity) ||
        !token.markerIdentity || !sameFileIdentity(marker.fileIdentity, token.markerIdentity)) fail("owner or marker identity changed");
    if (marker.released && marker.released.proof !== proof &&
        !(marker.released.proof === "ready" && ["posix-group-empty", "job-empty"].includes(proof))) fail("release proof changed");
    const confirmedProof = marker.released?.proof ?? proof;
    if (!marker.released) append(marker.file, { version: 1, event: "released", generation: token.generation, proof }, context, token.markerIdentity);
    else syncExisting(marker.file, context, token.markerIdentity);
    syncDirectory(dir, context);
    if (!marker.confirmed) append(marker.file, { version: 1, event: "confirmed", generation: token.generation, proof: confirmedProof }, context, token.markerIdentity);
    syncDirectory(dir, context);
    context.check();
    checkedMarker(fs.lstatSync(marker.file, { bigint: true }), token.markerIdentity);
    try { fs.unlinkSync(marker.file); syncDirectory(dir, context); } catch { /* 確認済みの記録は次回回収できる */ }
    return true;
  }, { timeoutMs, strictWorkspace: true });
}
