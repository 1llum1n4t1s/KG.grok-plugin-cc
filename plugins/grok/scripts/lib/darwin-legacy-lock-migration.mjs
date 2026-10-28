import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { inspectPosixStateLockScope, readPosixStateLockProtocol } from "./posix-state-lock.mjs";
import { getProtectedDarwinJobIds } from "./darwin-lease-sweep.mjs";
import { assertDarwinLegacyOfflineAuthorization, assertDarwinLegacyPreflightToken, assertDarwinMigrationStateContext, assertDarwinPruneContext } from "./state.mjs";
import { preserveDarwinMigrationInventory, verifyDarwinMigrationPreservation } from "./darwin-migration-inventory.mjs";

// この directory と内容は永続する。消して再作成すると待機中の mutex が分裂する。
export const DARWIN_LEGACY_MIGRATION_DIR = ".darwin-legacy-migration";
const GUARD = "native.lock";
const TRANSITION = "transition.json";
const BACKUP = "legacy-state.lock";
const MANIFEST = "manifest.json";
const COMPLETION = "completion.json";
const MAX_MARKER_BYTES = 8192;
const MAX_LOCK_BYTES = 128;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const ACTIVE_MIGRATIONS = new Set();
const ACTIVE_GUARD_CONTEXTS = new WeakMap();
// v4 の固定 inventory・barrier 準備・offline authorization・state mutex capability は未完成。
// これらの固定検証が実装・検証されるまで旧 callback 入口と backup 作成を実行しない。
const FIXED_V4_MIGRATION_AVAILABLE = false;

function fail(message, cause) {
  throw new Error(`Darwin legacy lock migration ${message}`, cause ? { cause } : undefined);
}

/** 実 guard を保持する間だけ発行される context を、外部属性を読まずに検証する。 */
export function assertDarwinLegacyGuardContext(context, deadline = Infinity) {
  if ((typeof context !== "object" && typeof context !== "function") || context === null) fail("guard capability is unavailable.");
  const check = ACTIVE_GUARD_CONTEXTS.get(context);
  if (!check) fail("guard capability is unavailable.");
  if (typeof deadline !== "number" || Number.isNaN(deadline)) fail("guard deadline is invalid.");
  check(deadline);
  return true;
}

/** 実 guard と実 state mutex の下で完成証拠を照合し、必要なときだけ公開する。 */
function checkDarwinMigrationCompletion(guardContext, stateContext, preflightToken, publish) {
  assertDarwinLegacyGuardContext(guardContext);
  assertDarwinPruneContext(stateContext);
  assertDarwinMigrationStateContext(stateContext, guardContext);
  if (guardContext.stateDir !== stateContext.stateDir || guardContext.hostId !== stateContext.hostId ||
      guardContext.directoryIdentity.dev !== stateContext.directoryIdentity?.dev ||
      guardContext.directoryIdentity.ino !== stateContext.directoryIdentity?.ino) fail("guard and state mutex belong to different states.");
  const deadline = performance.now() + 7500;
  const old = assertDarwinLegacyPreflightToken(preflightToken, guardContext, deadline);
  assertDarwinLegacyLockBackup(guardContext, preflightToken, deadline);
  const manifestFile = path.join(guardContext.migrationDir, MANIFEST);
  const manifest = readFile(manifestFile, MAX_MANIFEST_BYTES, "migration manifest");
  let value;
  try { value = JSON.parse(manifest.bytes.toString("utf8")); } catch { fail("migration manifest is corrupt."); }
  if (!exactKeys(value, ["version", "stateDir", "hostId", "state", "migrationDirectoryIdentity", "guardIdentity", "old", "preservation"]) ||
      !manifest.bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`)) || value.version !== 1 || value.stateDir !== guardContext.stateDir ||
      value.hostId !== guardContext.hostId || !same(value.state, guardContext.directoryIdentity) ||
      !same(value.migrationDirectoryIdentity, guardContext.migrationDirectoryIdentity) || !same(value.guardIdentity, guardContext.guardIdentity) ||
      !exactKeys(value.old, ["dev", "ino", "uid", "gid", "mode", "size", "sha256"]) ||
      Object.keys(old).some(key => value.old[key] !== old[key])) fail("migration manifest does not match its fixed scope.");
  verifyDarwinMigrationPreservation({ guardContext, migrationStateContext: stateContext, manifest: value.preservation, deadline });
  const completion = { version: 1, stateDir: guardContext.stateDir, hostId: guardContext.hostId,
    state: guardContext.directoryIdentity, migrationDirectoryIdentity: guardContext.migrationDirectoryIdentity,
    guardIdentity: guardContext.guardIdentity, barrierIdentity: stateContext.barrierIdentity,
    lockIdentity: stateContext.lockIdentity, markerIdentity: stateContext.markerIdentity, epoch: stateContext.epoch,
    manifestIdentity: identity(manifest.stat), manifestSha256: digest(manifest.bytes) };
  const bytes = Buffer.from(`${JSON.stringify(completion)}\n`), file = path.join(guardContext.migrationDir, COMPLETION);
  assertDarwinLegacyGuardContext(guardContext);
  assertDarwinPruneContext(stateContext);
  if (publish && !statMaybe(file)) {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const saved = readFile(file, MAX_MARKER_BYTES, "migration completion");
  if (!saved.bytes.equals(bytes)) fail("migration completion conflicts with the fixed evidence.");
  if (publish) {
    syncVerifiedFile(file, MAX_MARKER_BYTES, "migration completion", {}, saved, deadline);
    syncDir(guardContext.migrationDir, guardContext.migrationDirectoryIdentity, "migration directory");
  }
  assertDarwinLegacyLockBackup(guardContext, preflightToken, deadline);
  assertDarwinMigrationStateContext(stateContext, guardContext, deadline);
  return Object.freeze(completion);
}
export function publishDarwinMigrationCompletion(guardContext, stateContext, preflightToken) {
  return checkDarwinMigrationCompletion(guardContext, stateContext, preflightToken, true);
}
export function verifyDarwinMigrationCompletion(guardContext, stateContext, preflightToken) {
  return checkDarwinMigrationCompletion(guardContext, stateContext, preflightToken, false);
}
function statMaybe(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function same(stat, expected) {
  return Boolean(stat && expected && String(stat.dev) === expected.dev && String(stat.ino) === expected.ino);
}
function checkOwned(stat, directory, label, privateMode = true) {
  if (!stat || stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) ||
      stat.dev <= 0n || stat.ino <= 0n || stat.uid !== BigInt(process.getuid()) ||
      (stat.mode & (privateMode ? 0o077n : 0o022n)) !== 0n || (stat.mode & 0o7000n) !== 0n) {
    fail(`${label} ownership, permissions or identity is invalid.`);
  }
  if (!directory && (stat.mode & 0o400n) === 0n) fail(`${label} is not owner-readable.`);
  return stat;
}
function flags(directory = false) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;
  if (!(O_NOFOLLOW > 0) || !(O_NONBLOCK > 0)) fail("requires no-follow and nonblocking open support.");
  return O_RDONLY | O_NOFOLLOW | O_NONBLOCK | (directory ? (O_DIRECTORY ?? 0) : 0);
}
function checkDir(file, expected, label) {
  const stat = checkOwned(fs.lstatSync(file, { bigint: true }), true, label);
  if (expected && !same(stat, expected)) fail(`${label} changed.`);
  return stat;
}
function syncDir(file, expected, label) {
  checkDir(file, expected, label);
  const fd = fs.openSync(file, flags(true));
  try {
    const opened = checkOwned(fs.fstatSync(fd, { bigint: true }), true, label);
    if (!same(opened, expected)) fail(`${label} changed before synchronization.`);
    fs.fsyncSync(fd);
    checkDir(file, expected, label);
  } finally { fs.closeSync(fd); }
}
function readFile(file, limit, label, { privateMode = true, links = 1n, expected = null } = {}) {
  const before = checkOwned(fs.lstatSync(file, { bigint: true }), false, label, privateMode);
  if (before.nlink !== links || before.size > BigInt(limit) || (expected && !same(before, expected))) fail(`${label} is invalid.`);
  const fd = fs.openSync(file, flags());
  try {
    const opened = checkOwned(fs.fstatSync(fd, { bigint: true }), false, label, privateMode);
    if (!same(opened, identity(before)) || opened.nlink !== links || opened.size !== before.size ||
        opened.mode !== before.mode || opened.uid !== before.uid || opened.gid !== before.gid ||
        opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) fail(`${label} changed before reading.`);
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (!same(after, identity(before)) || !same(named, identity(before)) || named.isSymbolicLink() ||
        after.nlink !== links || named.nlink !== links || after.size !== before.size || named.size !== before.size ||
        after.mode !== before.mode || named.mode !== before.mode || after.uid !== before.uid || named.uid !== before.uid ||
        after.gid !== before.gid || named.gid !== before.gid || after.mtimeNs !== before.mtimeNs || named.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs || named.ctimeNs !== before.ctimeNs || offset !== Number(before.size)) fail(`${label} changed while reading.`);
    return { bytes: bytes.subarray(0, offset), stat: before };
  } finally { fs.closeSync(fd); }
}
function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...keys].sort().join("\n"));
}
function checkBackupDeadline(deadline) {
  if (typeof deadline !== "number" || Number.isNaN(deadline)) fail("backup deadline is invalid.");
  if (performance.now() >= deadline) throw new Error("Timed out verifying Darwin legacy lock backup");
}
function syncVerifiedFile(file, limit, label, options, before, deadline = Infinity) {
  checkBackupDeadline(deadline);
  const fd = fs.openSync(file, flags());
  try {
    checkBackupDeadline(deadline);
    const opened = checkOwned(fs.fstatSync(fd, { bigint: true }), false, label, options.privateMode !== false);
    if (!same(opened, identity(before.stat)) || opened.nlink !== before.stat.nlink || opened.size !== before.stat.size ||
        opened.mode !== before.stat.mode || opened.uid !== before.stat.uid || opened.gid !== before.stat.gid ||
        opened.mtimeNs !== before.stat.mtimeNs || opened.ctimeNs !== before.stat.ctimeNs) fail(`${label} changed before synchronization.`);
    checkBackupDeadline(deadline);
    fs.fsyncSync(fd);
    checkBackupDeadline(deadline);
    const after = readFile(file, limit, label, { ...options, expected: identity(before.stat) });
    checkBackupDeadline(deadline);
    if (!after.bytes.equals(before.bytes) || after.stat.mode !== before.stat.mode || after.stat.uid !== before.stat.uid ||
        after.stat.gid !== before.stat.gid || after.stat.mtimeNs !== before.stat.mtimeNs || after.stat.ctimeNs !== before.stat.ctimeNs) {
      fail(`${label} changed during synchronization.`);
    }
  } finally { fs.closeSync(fd); }
}

/** 認可された移行だけが固定 inventory とその保全資料を記録する。 */
export function writeDarwinMigrationManifest(guardContext, preflightToken, offlineAuthorization, deadline = performance.now() + 7500) {
  checkBackupDeadline(deadline);
  assertDarwinLegacyGuardContext(guardContext, deadline);
  assertDarwinLegacyOfflineAuthorization(offlineAuthorization, guardContext, preflightToken, deadline);
  const old = assertDarwinLegacyPreflightToken(preflightToken, guardContext, deadline);
  const { stateDir, hostId, directoryIdentity, migrationDir, migrationDirectoryIdentity, guardIdentity } = guardContext;
  const preserved = preserveDarwinMigrationInventory({ stateDir, guardContext, preflightToken, offlineAuthorization, deadline });
  const value = { version: 1, stateDir, hostId, state: directoryIdentity, migrationDirectoryIdentity, guardIdentity, old,
    preservation: { version: 1, ...preserved } };
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_MANIFEST_BYTES) fail("manifest exceeds its size limit.");
  const file = path.join(migrationDir, MANIFEST);
  checkBackupDeadline(deadline);
  assertDarwinLegacyOfflineAuthorization(offlineAuthorization, guardContext, preflightToken, deadline);
  if (!statMaybe(file)) {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      checkBackupDeadline(deadline);
      fs.fsyncSync(fd);
      checkBackupDeadline(deadline);
    } finally { fs.closeSync(fd); }
  }
  const saved = readFile(file, MAX_MANIFEST_BYTES, "migration manifest");
  if (!saved.bytes.equals(bytes)) fail("migration manifest conflicts with the verified inventory.");
  syncVerifiedFile(file, MAX_MANIFEST_BYTES, "migration manifest", {}, saved, deadline);
  syncDir(migrationDir, migrationDirectoryIdentity, "migration directory");
  checkBackupDeadline(deadline);
  assertDarwinLegacyOfflineAuthorization(offlineAuthorization, guardContext, preflightToken, deadline);
  return Object.freeze(value);
}

/** 実 guard・固定 token の下で旧 inode の no-clobber backup を耐久化する。旧名は解除しない。 */
export function prepareDarwinLegacyLockBackup(guardContext, preflightToken, offlineAuthorization, deadline = Infinity) {
  checkBackupDeadline(deadline);
  assertDarwinLegacyGuardContext(guardContext, deadline);
  assertDarwinLegacyOfflineAuthorization(offlineAuthorization, guardContext, preflightToken, deadline);
  const old = assertDarwinLegacyPreflightToken(preflightToken, guardContext, deadline);
  checkBackupDeadline(deadline);
  const { stateDir, migrationDir, directoryIdentity, migrationDirectoryIdentity, guardIdentity, hostId } = guardContext;
  const sourceFile = path.join(stateDir, "state.lock"), markerFile = path.join(migrationDir, TRANSITION);
  const backupFile = path.join(migrationDir, BACKUP);
  const expectedTransition = { version: 2, stateDir, state: directoryIdentity, hostId,
    guardIdentity, migrationDirectoryIdentity, old };
  const expectedBytes = Buffer.from(`${JSON.stringify(expectedTransition)}\n`);
  const markerStat = statMaybe(markerFile), backupStat = statMaybe(backupFile);
  checkBackupDeadline(deadline);
  if (!markerStat && backupStat) fail("backup exists without a transition marker.");
  // 旧名解除後の再開では source は存在しない。durable backup 自体を検証する。
  if (markerStat && backupStat) return assertDarwinLegacyLockBackup(guardContext, preflightToken, deadline);
  const source = readFile(sourceFile, MAX_LOCK_BYTES, "legacy lock", { privateMode: false, links: backupStat ? 2n : 1n, expected: old });
  checkBackupDeadline(deadline);
  if (String(source.stat.uid) !== old.uid || String(source.stat.gid) !== old.gid || String(source.stat.mode) !== old.mode ||
      String(source.stat.size) !== old.size || digest(source.bytes) !== old.sha256 || !/^[1-9]\d*\n$/.test(source.bytes.toString("utf8"))) {
    fail("legacy lock does not match the verified preflight.");
  }
  if (markerStat) {
    const marker = readFile(markerFile, MAX_MARKER_BYTES, "transition marker");
    checkBackupDeadline(deadline);
    if (!marker.bytes.equals(expectedBytes)) fail("transition marker does not match the verified preflight.");
    syncVerifiedFile(markerFile, MAX_MARKER_BYTES, "transition marker", {}, marker, deadline);
    syncDir(migrationDir, migrationDirectoryIdentity, "migration directory");
    checkBackupDeadline(deadline);
  } else {
    syncVerifiedFile(sourceFile, MAX_LOCK_BYTES, "legacy lock", { privateMode: false, links: 1n, expected: old }, source, deadline);
    syncDir(stateDir, directoryIdentity, "state directory");
    checkBackupDeadline(deadline);
    assertDarwinLegacyGuardContext(guardContext, deadline);
    assertDarwinLegacyOfflineAuthorization(offlineAuthorization, guardContext, preflightToken, deadline);
    assertDarwinLegacyPreflightToken(preflightToken, guardContext, deadline);
    checkBackupDeadline(deadline);
    const fd = fs.openSync(markerFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      checkBackupDeadline(deadline);
      fs.writeFileSync(fd, expectedBytes);
      checkBackupDeadline(deadline);
      fs.fsyncSync(fd);
      checkBackupDeadline(deadline);
    } finally { fs.closeSync(fd); }
    const marker = readFile(markerFile, MAX_MARKER_BYTES, "transition marker");
    checkBackupDeadline(deadline);
    if (!marker.bytes.equals(expectedBytes)) fail("transition marker changed during creation.");
    syncDir(migrationDir, migrationDirectoryIdentity, "migration directory");
    checkBackupDeadline(deadline);
  }
  const current = readFile(sourceFile, MAX_LOCK_BYTES, "legacy lock", { privateMode: false, links: 1n, expected: old });
  checkBackupDeadline(deadline);
  if (!current.bytes.equals(source.bytes) || current.stat.mode !== source.stat.mode || current.stat.uid !== source.stat.uid ||
      current.stat.gid !== source.stat.gid || current.stat.mtimeNs !== source.stat.mtimeNs || current.stat.ctimeNs !== source.stat.ctimeNs) {
    fail("legacy lock changed before backup.");
  }
  assertDarwinLegacyGuardContext(guardContext, deadline);
  assertDarwinLegacyOfflineAuthorization(offlineAuthorization, guardContext, preflightToken, deadline);
  assertDarwinLegacyPreflightToken(preflightToken, guardContext, deadline);
  checkBackupDeadline(deadline);
  fs.linkSync(sourceFile, backupFile);
  checkBackupDeadline(deadline);
  return assertDarwinLegacyLockBackup(guardContext, preflightToken, deadline);
}

/** 再開時も固定 guard と同一の transition だけを読み取る。 */
export function readDarwinLegacyTransition(guardContext, deadline = Infinity) {
  checkBackupDeadline(deadline);
  assertDarwinLegacyGuardContext(guardContext, deadline);
  const { stateDir, migrationDir, directoryIdentity, migrationDirectoryIdentity, guardIdentity, hostId } = guardContext;
  const marker = readFile(path.join(migrationDir, TRANSITION), MAX_MARKER_BYTES, "transition marker");
  let value;
  try { value = JSON.parse(marker.bytes.toString("utf8")); } catch { fail("transition marker is corrupt."); }
  if (!exactKeys(value, ["version", "stateDir", "state", "hostId", "guardIdentity", "migrationDirectoryIdentity", "old"]) ||
      !exactKeys(value.state, ["dev", "ino"]) || !exactKeys(value.guardIdentity, ["dev", "ino"]) ||
      !exactKeys(value.migrationDirectoryIdentity, ["dev", "ino"]) ||
      !exactKeys(value.old, ["dev", "ino", "uid", "gid", "mode", "size", "sha256"]) ||
      !marker.bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`)) || value.version !== 2 || value.stateDir !== stateDir ||
      value.hostId !== hostId || value.state.dev !== directoryIdentity.dev || value.state.ino !== directoryIdentity.ino ||
      value.guardIdentity.dev !== guardIdentity.dev || value.guardIdentity.ino !== guardIdentity.ino ||
      value.migrationDirectoryIdentity.dev !== migrationDirectoryIdentity.dev || value.migrationDirectoryIdentity.ino !== migrationDirectoryIdentity.ino ||
      !["dev", "ino"].every(key => /^[1-9]\d*$/.test(value.old[key])) ||
      !["uid", "gid", "mode", "size"].every(key => /^(0|[1-9]\d*)$/.test(value.old[key])) ||
      !/^[0-9a-f]{64}$/.test(value.old.sha256)) fail("transition marker does not match the verified guard.");
  checkBackupDeadline(deadline);
  assertDarwinLegacyGuardContext(guardContext, deadline);
  return Object.freeze({ ...value.old });
}

/** 実 guard と state 発行 token に結び付いた durable transition/backup を照合する。 */
export function assertDarwinLegacyLockBackup(guardContext, preflightToken, deadline = Infinity) {
  checkBackupDeadline(deadline);
  assertDarwinLegacyGuardContext(guardContext, deadline);
  checkBackupDeadline(deadline);
  const expected = assertDarwinLegacyPreflightToken(preflightToken, guardContext, deadline);
  checkBackupDeadline(deadline);
  const { stateDir, migrationDir, directoryIdentity, migrationDirectoryIdentity, guardIdentity, hostId } = guardContext;
  const markerFile = path.join(migrationDir, TRANSITION), backupFile = path.join(migrationDir, BACKUP);
  const oldFile = path.join(stateDir, "state.lock");
  const marker = readFile(markerFile, MAX_MARKER_BYTES, "transition marker");
  checkBackupDeadline(deadline);
  let value;
  try { value = JSON.parse(marker.bytes.toString("utf8")); } catch { fail("transition marker is corrupt."); }
  if (!exactKeys(value, ["version", "stateDir", "state", "hostId", "guardIdentity", "migrationDirectoryIdentity", "old"]) ||
      !exactKeys(value.state, ["dev", "ino"]) || !exactKeys(value.guardIdentity, ["dev", "ino"]) ||
      !exactKeys(value.migrationDirectoryIdentity, ["dev", "ino"]) ||
      !exactKeys(value.old, ["dev", "ino", "uid", "gid", "mode", "size", "sha256"]) ||
      !marker.bytes.equals(Buffer.from(`${JSON.stringify(value)}\n`)) || value.version !== 2 || value.stateDir !== stateDir ||
      value.hostId !== hostId || value.state.dev !== directoryIdentity.dev || value.state.ino !== directoryIdentity.ino ||
      value.guardIdentity.dev !== guardIdentity.dev || value.guardIdentity.ino !== guardIdentity.ino ||
      value.migrationDirectoryIdentity.dev !== migrationDirectoryIdentity.dev || value.migrationDirectoryIdentity.ino !== migrationDirectoryIdentity.ino ||
      ["dev", "ino", "uid", "gid", "mode", "size", "sha256"].some(key => value.old[key] !== expected[key])) {
    fail("transition marker does not match the verified preflight.");
  }
  const source = statMaybe(oldFile);
  checkBackupDeadline(deadline);
  let links = 1n;
  if (source?.isFile() && !source.isSymbolicLink()) {
    if (!same(source, expected)) fail("legacy lock name points to another file.");
    links = 2n;
  } else if (source) {
    if (!source.isDirectory() || source.isSymbolicLink() || source.dev !== BigInt(directoryIdentity.dev)) fail("state lock name is invalid.");
    checkOwned(source, true, "state barrier");
  }
  const options = { privateMode: false, links, expected };
  const backup = readFile(backupFile, MAX_LOCK_BYTES, "preserved legacy lock", options);
  checkBackupDeadline(deadline);
  if (String(backup.stat.uid) !== expected.uid || String(backup.stat.gid) !== expected.gid ||
      String(backup.stat.mode) !== expected.mode || String(backup.stat.size) !== expected.size ||
      digest(backup.bytes) !== expected.sha256 || !/^[1-9]\d*\n$/.test(backup.bytes.toString("utf8"))) {
    fail("preserved legacy lock does not match the verified preflight.");
  }
  if (links === 2n) {
    const named = readFile(oldFile, MAX_LOCK_BYTES, "legacy lock", options);
    checkBackupDeadline(deadline);
    if (!named.bytes.equals(backup.bytes)) fail("legacy lock and backup do not match.");
  }
  assertDarwinLegacyGuardContext(guardContext, deadline);
  checkBackupDeadline(deadline);
  syncVerifiedFile(markerFile, MAX_MARKER_BYTES, "transition marker", {}, marker, deadline);
  syncVerifiedFile(backupFile, MAX_LOCK_BYTES, "preserved legacy lock", options, backup, deadline);
  checkBackupDeadline(deadline);
  syncDir(migrationDir, migrationDirectoryIdentity, "migration directory");
  checkBackupDeadline(deadline);
  syncDir(stateDir, directoryIdentity, "state directory");
  checkBackupDeadline(deadline);
  const after = readFile(backupFile, MAX_LOCK_BYTES, "preserved legacy lock", options);
  checkBackupDeadline(deadline);
  if (!after.bytes.equals(backup.bytes) || after.stat.mtimeNs !== backup.stat.mtimeNs || after.stat.ctimeNs !== backup.stat.ctimeNs) {
    fail("preserved legacy lock changed after synchronization.");
  }
  const afterMarker = readFile(markerFile, MAX_MARKER_BYTES, "transition marker", { expected: identity(marker.stat) });
  checkBackupDeadline(deadline);
  if (!afterMarker.bytes.equals(marker.bytes) || afterMarker.stat.mtimeNs !== marker.stat.mtimeNs || afterMarker.stat.ctimeNs !== marker.stat.ctimeNs) {
    fail("transition marker changed after synchronization.");
  }
  const namedAfter = statMaybe(oldFile);
  checkBackupDeadline(deadline);
  if (links === 2n) {
    const named = readFile(oldFile, MAX_LOCK_BYTES, "legacy lock", options);
    checkBackupDeadline(deadline);
    if (!named.bytes.equals(backup.bytes)) fail("legacy lock changed after synchronization.");
  } else if ((!source && namedAfter) || (source && (!namedAfter?.isDirectory() || namedAfter.isSymbolicLink() || !same(namedAfter, identity(source))))) {
    fail("state lock name changed after synchronization.");
  }
  assertDarwinLegacyPreflightToken(preflightToken, guardContext, deadline);
  checkBackupDeadline(deadline);
  assertDarwinLegacyGuardContext(guardContext, deadline);
  checkBackupDeadline(deadline);
  return true;
}

/** 確定済み backup の後だけ旧 lock の名前を解除する。barrier の正当性は証明しない。 */
export function releaseDarwinLegacyLockName(guardContext, preflightToken, offlineAuthorization, deadline = Infinity) {
  checkBackupDeadline(deadline);
  assertDarwinLegacyGuardContext(guardContext, deadline);
  assertDarwinLegacyOfflineAuthorization(offlineAuthorization, guardContext, preflightToken, deadline);
  const expected = assertDarwinLegacyPreflightToken(preflightToken, guardContext, deadline);
  checkBackupDeadline(deadline);
  assertDarwinLegacyLockBackup(guardContext, preflightToken, deadline);
  checkBackupDeadline(deadline);
  const oldFile = path.join(guardContext.stateDir, "state.lock"), source = statMaybe(oldFile);
  checkBackupDeadline(deadline);
  if (!source) {
    syncDir(guardContext.stateDir, guardContext.directoryIdentity, "state directory");
    checkBackupDeadline(deadline);
    assertDarwinLegacyLockBackup(guardContext, preflightToken, deadline);
    return true;
  }
  if (!source.isFile() || source.isSymbolicLink() || !same(source, expected)) fail("legacy lock name is unavailable or changed.");
  const sourceRecord = readFile(oldFile, MAX_LOCK_BYTES, "legacy lock", { privateMode: false, links: 2n, expected });
  checkBackupDeadline(deadline);
  if (String(sourceRecord.stat.uid) !== expected.uid || String(sourceRecord.stat.gid) !== expected.gid ||
      String(sourceRecord.stat.mode) !== expected.mode || String(sourceRecord.stat.size) !== expected.size ||
      digest(sourceRecord.bytes) !== expected.sha256) fail("legacy lock no longer matches the preflight.");
  assertDarwinLegacyGuardContext(guardContext, deadline);
  assertDarwinLegacyOfflineAuthorization(offlineAuthorization, guardContext, preflightToken, deadline);
  assertDarwinLegacyLockBackup(guardContext, preflightToken, deadline);
  checkBackupDeadline(deadline);
  const named = checkOwned(fs.lstatSync(oldFile, { bigint: true }), false, "legacy lock", false);
  if (!same(named, expected) || named.nlink !== 2n || named.size !== sourceRecord.stat.size ||
      named.mode !== sourceRecord.stat.mode || named.uid !== sourceRecord.stat.uid || named.gid !== sourceRecord.stat.gid ||
      named.mtimeNs !== sourceRecord.stat.mtimeNs || named.ctimeNs !== sourceRecord.stat.ctimeNs) fail("legacy lock changed before name release.");
  checkBackupDeadline(deadline);
  // Node/POSIX に条件付き unlink はない。旧 runtime と同 UID の namespace 変更禁止が前提。
  fs.unlinkSync(oldFile);
  checkBackupDeadline(deadline);
  syncDir(guardContext.stateDir, guardContext.directoryIdentity, "state directory");
  checkBackupDeadline(deadline);
  assertDarwinLegacyLockBackup(guardContext, preflightToken, deadline);
  checkBackupDeadline(deadline);
  return true;
}
function invoke(callback, value, name) {
  if (types.isAsyncFunction(callback)) fail(`${name} must be synchronous.`);
  const result = callback(value);
  if (result && typeof result.then === "function") {
    void Promise.resolve(result).catch(() => {});
    fail(`${name} must be synchronous.`);
  }
  if (result === false) fail(`${name} rejected the state.`);
  return result;
}
function acquire(fd, timeoutMs, run, deadline = performance.now() + timeoutMs) {
  for (;;) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) fail("guard acquisition timed out.");
    let acquired = false;
    try {
      execFileSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], { stdio: ["ignore", "pipe", "pipe", fd], timeout: remaining });
      acquired = true;
    } catch (error) {
      if (error?.code === "ETIMEDOUT") throw new Error("Timed out acquiring Darwin migration guard", { cause: error });
      if (error?.status !== 75 || error?.signal || error?.code) throw error;
    }
    if (acquired) {
      if (performance.now() >= deadline) fail("guard acquisition timed out.");
      return run();
    }
    const wait = deadline - performance.now();
    if (wait <= 0) fail("guard acquisition timed out.");
    Atomics.wait(SLEEP, 0, 0, Math.min(10, wait));
  }
}

/**
 * 実 FD の lockf を保持し、固定 validator 用の短命 guard context を返す。
 * この原語自体は inventory の認可、旧 lock の変更、通常 runtime の許可を行わない。
 * 呼出側は対象・offline 前提を確認し、state mutex は guard の後に取得する。
 * timeoutMs は scope 照会から capability 発行までの合計予算。同期 FS I/O は
 * 中断できず、各操作が戻った直後に期限を判定する。
 * @param {string} stateDir
 * @param {number} [timeoutMs]
 */
export function acquireDarwinMigrationGuard(stateDir, timeoutMs = 7500) {
  if (process.platform !== "darwin") fail("guard is supported only on Darwin.");
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir) || path.resolve(stateDir) !== stateDir ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("guard requires a canonical absolute state directory and finite timeout.");
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const value = deadline - performance.now();
    if (value <= 0) throw new Error("Timed out acquiring Darwin migration guard");
    return Math.ceil(value);
  };
  const inspectWithinDeadline = () => {
    try {
      const result = inspectPosixStateLockScope(stateDir, { timeoutMs: remaining() });
      remaining();
      return result;
    } catch (error) {
      if (performance.now() >= deadline) throw new Error("Timed out acquiring Darwin migration guard", { cause: error });
      throw error;
    }
  };
  if (fs.realpathSync.native(stateDir) !== stateDir) fail("state directory must be its canonical path.");
  remaining();
  if (ACTIVE_MIGRATIONS.has(stateDir)) fail("does not permit synchronous reentry.");
  ACTIVE_MIGRATIONS.add(stateDir);
  let fd, handedOff = false;
  try {
    const state = identity(checkDir(stateDir, null, "state directory"));
    remaining();
    const scope = inspectWithinDeadline();
    if (!scope || scope.fileSystem !== "apfs" || typeof scope.hostId !== "string" || !scope.hostId ||
        scope.directoryIdentity?.dev !== state.dev || scope.directoryIdentity?.ino !== state.ino) fail("local APFS scope is unavailable.");
    const migrationDir = path.join(stateDir, DARWIN_LEGACY_MIGRATION_DIR), guardFile = path.join(migrationDir, GUARD);
    let dir = statMaybe(migrationDir);
    remaining();
    if (!dir) {
      checkDir(stateDir, state, "state directory");
      remaining();
      try { fs.mkdirSync(migrationDir, { mode: 0o700 }); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
      remaining();
      syncDir(stateDir, state, "state directory");
      remaining();
      dir = fs.lstatSync(migrationDir, { bigint: true });
    }
    remaining();
    checkOwned(dir, true, "migration directory");
    if (dir.dev !== BigInt(state.dev)) fail("migration directory is on another filesystem.");
    const migrationDirectoryIdentity = identity(dir);
    try {
      remaining();
      fd = fs.openSync(guardFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      remaining();
      fs.fsyncSync(fd);
      remaining();
      syncDir(migrationDir, migrationDirectoryIdentity, "migration directory");
      remaining();
    } catch (error) {
      if (fd !== undefined || error?.code !== "EEXIST") throw error;
      fd = fs.openSync(guardFile, flags());
      remaining();
    }
    const opened = checkOwned(fs.fstatSync(fd, { bigint: true }), false, "migration guard");
    const guardIdentity = identity(opened);
    if (opened.nlink !== 1n || opened.size !== 0n || !same(fs.lstatSync(guardFile, { bigint: true }), guardIdentity)) fail("migration guard is invalid.");
    remaining();
    return acquire(fd, timeoutMs, () => {
      let active = true, acquiring = true;
      const check = (operationDeadline = Infinity) => {
        if (!active) fail("guard capability is no longer active.");
        const checkDeadline = acquiring ? Math.min(deadline, operationDeadline) : operationDeadline;
        const checkRemaining = () => {
          const value = checkDeadline - performance.now();
          if (value <= 0) throw new Error("Timed out verifying Darwin migration guard");
          return Number.isFinite(value) ? Math.ceil(value) : undefined;
        };
        checkRemaining();
        checkDir(stateDir, state, "state directory");
        const timeout = checkRemaining();
        let current;
        try {
          current = inspectPosixStateLockScope(stateDir, timeout === undefined ? {} : { timeoutMs: timeout });
        } catch (error) {
          if (performance.now() >= checkDeadline) throw new Error("Timed out verifying Darwin migration guard", { cause: error });
          throw error;
        }
        checkRemaining();
        if (current.fileSystem !== "apfs" || current.hostId !== scope.hostId ||
            current.directoryIdentity?.dev !== state.dev || current.directoryIdentity?.ino !== state.ino) fail("state scope changed.");
        checkDir(migrationDir, migrationDirectoryIdentity, "migration directory");
        const actual = checkOwned(fs.fstatSync(fd, { bigint: true }), false, "migration guard");
        const named = checkOwned(fs.lstatSync(guardFile, { bigint: true }), false, "migration guard");
        if (!same(actual, guardIdentity) || !same(named, guardIdentity) || actual.nlink !== 1n || named.nlink !== 1n ||
            actual.size !== 0n || named.size !== 0n) fail("migration guard changed.");
        checkRemaining();
      };
      check();
      remaining();
      fs.fsyncSync(fd);
      remaining();
      syncDir(migrationDir, migrationDirectoryIdentity, "migration directory");
      remaining();
      syncDir(stateDir, state, "state directory");
      remaining();
      check();
      remaining();
      const context = Object.freeze({ stateDir, migrationDir, hostId: scope.hostId, fileSystem: scope.fileSystem,
        directoryIdentity: Object.freeze({ ...state }), migrationDirectoryIdentity: Object.freeze({ ...migrationDirectoryIdentity }),
        guardIdentity: Object.freeze({ ...guardIdentity }) });
      remaining();
      ACTIVE_GUARD_CONTEXTS.set(context, check);
      const close = () => {
        if (!active) return;
        active = false;
        ACTIVE_GUARD_CONTEXTS.delete(context);
        ACTIVE_MIGRATIONS.delete(stateDir);
        fs.closeSync(fd);
      };
      acquiring = false;
      handedOff = true;
      return Object.freeze({ context, close });
    }, deadline);
  } finally {
    if (!handedOff) {
      ACTIVE_MIGRATIONS.delete(stateDir);
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

/**
 * 旧 writer・broker・agent の全停止と旧版の再起動禁止は呼出者の offline 確認。
 * inspectScope は local APFS/host/物理 state identity を確認する既存 API。
 * verifyInventory は全旧 state と broker/direct を非破壊で検証し、不明・未確定を拒否する。
 * runMigration は新 barrier の完全な準備・同期・検証を同期的に完了する。
 * callback は guard の名前・identity を inventory に含め、未検証 artifact を許可しない。
 * @param {string} stateDir
 * @param {{
 *   expectedStateDir?: string,
 *   offlineConfirmed?: boolean,
 *   localOnly?: boolean,
 *   inspectScope?: typeof inspectPosixStateLockScope,
 *   verifyInventory?: (context: {stateDir: string, scope: ReturnType<typeof inspectPosixStateLockScope>, migrationDir: string, migrationDirectoryIdentity: {dev: string, ino: string}}) => boolean,
 *   runMigration?: (context: {stateDir: string, scope: ReturnType<typeof inspectPosixStateLockScope>, migrationDir: string, migrationDirectoryIdentity: {dev: string, ino: string}}) => any,
 *   onStep?: ((name: string) => void) | null,
 *   timeoutMs?: number
 * }} [options]
 */
export function withDarwinLegacyLockMigration(stateDir, options = {}) {
  if (process.platform !== "darwin") fail("is supported only on Darwin.");
  if (!FIXED_V4_MIGRATION_AVAILABLE) fail("requires the fixed v4 state migration and mutex capability; existing state was left untouched.");
  const { expectedStateDir, offlineConfirmed, localOnly, inspectScope, verifyInventory, runMigration, onStep = null, timeoutMs = 7500 } = options;
  if (offlineConfirmed !== true || localOnly !== true || typeof stateDir !== "string" || !path.isAbsolute(stateDir) ||
      typeof expectedStateDir !== "string" || !path.isAbsolute(expectedStateDir) ||
      path.resolve(stateDir) !== path.resolve(expectedStateDir)) fail("requires explicit offline/local confirmation and the exact state directory.");
  if (inspectScope !== inspectPosixStateLockScope || typeof verifyInventory !== "function" || typeof runMigration !== "function" ||
      (onStep !== null && typeof onStep !== "function") || !Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("requires synchronous verification and migration callbacks.");
  const activeKey = path.resolve(stateDir);
  if (ACTIVE_MIGRATIONS.has(activeKey)) fail("does not permit synchronous reentry.");
  ACTIVE_MIGRATIONS.add(activeKey);
  try {
  if (fs.realpathSync.native(stateDir) !== path.resolve(stateDir)) fail("state directory must be its canonical path.");
  const state = identity(checkDir(stateDir, null, "state directory"));
  const scope = invoke(inspectScope, stateDir, "scope inspection");
  if (!scope || scope.fileSystem !== "apfs" || typeof scope.hostId !== "string" || !scope.hostId ||
      scope.directoryIdentity?.dev !== state.dev || scope.directoryIdentity?.ino !== state.ino) fail("local APFS scope is unavailable.");
  const migrationDir = path.join(stateDir, DARWIN_LEGACY_MIGRATION_DIR);
  const guardFile = path.join(migrationDir, GUARD), markerFile = path.join(migrationDir, TRANSITION);
  const backupFile = path.join(migrationDir, BACKUP), oldFile = path.join(stateDir, "state.lock");
  const step = name => { if (onStep) invoke(onStep, name, "step callback"); };
  function checkScope() {
    checkDir(stateDir, state, "state directory");
    const current = invoke(inspectScope, stateDir, "scope inspection");
    if (!current || current.fileSystem !== "apfs" || current.hostId !== scope.hostId ||
        current.directoryIdentity?.dev !== state.dev || current.directoryIdentity?.ino !== state.ino) fail("state scope changed.");
  }
  let dir = statMaybe(migrationDir);
  if (!dir) {
    checkScope();
    try { fs.mkdirSync(migrationDir, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    syncDir(stateDir, state, "state directory");
    dir = fs.lstatSync(migrationDir, { bigint: true });
  }
  checkOwned(dir, true, "migration directory");
  if (dir.dev !== BigInt(state.dev)) fail("migration directory is on another filesystem.");
  const dirIdentity = identity(dir);
  let guardFd;
  try {
    try {
      guardFd = fs.openSync(guardFile, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.fsyncSync(guardFd);
      syncDir(migrationDir, dirIdentity, "migration directory");
    } catch (error) {
      if (guardFd !== undefined || error?.code !== "EEXIST") throw error;
      guardFd = fs.openSync(guardFile, flags());
    }
    const guard = checkOwned(fs.fstatSync(guardFd, { bigint: true }), false, "migration guard");
    if (guard.nlink !== 1n || guard.size !== 0n || !same(fs.lstatSync(guardFile, { bigint: true }), identity(guard))) fail("migration guard is invalid.");
    return acquire(guardFd, timeoutMs, () => {
      const guardIdentity = identity(guard);
      let markerState = null;
      const checkMarker = () => {
        if (!markerState) return;
        const current = readFile(markerFile, MAX_MARKER_BYTES, "transition marker", { expected: markerState.identity });
        if (!current.bytes.equals(markerState.bytes)) fail("transition marker content changed.");
      };
      const check = () => {
        checkScope();
        checkDir(migrationDir, dirIdentity, "migration directory");
        const fdStat = checkOwned(fs.fstatSync(guardFd, { bigint: true }), false, "migration guard");
        const named = checkOwned(fs.lstatSync(guardFile, { bigint: true }), false, "migration guard");
        if (!same(fdStat, guardIdentity) || !same(named, guardIdentity) || fdStat.nlink !== 1n || named.nlink !== 1n || fdStat.size !== 0n || named.size !== 0n) fail("migration guard changed.");
        const entries = fs.readdirSync(migrationDir);
        if (entries.some(name => ![GUARD, TRANSITION, BACKUP].includes(name))) fail("migration directory has an unknown entry.");
        checkMarker();
      };
      check();
      const guardContext = Object.freeze({ stateDir, migrationDir, hostId: scope.hostId, fileSystem: scope.fileSystem,
        directoryIdentity: Object.freeze({ ...state }), migrationDirectoryIdentity: Object.freeze({ ...dirIdentity }),
        guardIdentity: Object.freeze({ ...guardIdentity }) });
      ACTIVE_GUARD_CONTEXTS.set(guardContext, check);
      try {
      // 他 process が guard を作った直後に取得した場合も、入力を変更する前に
      // 同じ guard inode とその名前を同期する。
      fs.fsyncSync(guardFd);
      syncDir(migrationDir, dirIdentity, "migration directory");
      syncDir(stateDir, state, "state directory");
      check();
      if (invoke(verifyInventory, { stateDir, scope, migrationDir, migrationDirectoryIdentity: dirIdentity }, "inventory verification") !== true) {
        fail("inventory verification must explicitly confirm the complete inventory.");
      }
      check();
      let marker;
      if (statMaybe(markerFile)) {
        const data = readFile(markerFile, MAX_MARKER_BYTES, "transition marker");
        markerState = { identity: identity(data.stat), bytes: Buffer.from(data.bytes) };
        try { marker = JSON.parse(data.bytes.toString("utf8")); } catch { fail("transition marker is corrupt."); }
        const fd = fs.openSync(markerFile, flags());
        try {
          const opened = checkOwned(fs.fstatSync(fd, { bigint: true }), false, "transition marker");
          if (!same(opened, markerState.identity) || opened.nlink !== 1n || opened.size !== BigInt(markerState.bytes.length)) fail("transition marker changed before synchronization.");
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        syncDir(migrationDir, dirIdentity, "migration directory");
        checkMarker();
      } else {
        if (statMaybe(backupFile)) fail("backup exists without a transition marker.");
        const old = readFile(oldFile, MAX_LOCK_BYTES, "legacy lock", { privateMode: false });
        if (!/^[1-9]\d*\n$/.test(old.bytes.toString("utf8"))) fail("legacy lock owner is invalid.");
        marker = { version: 1, stateDir: path.resolve(stateDir), state, hostId: scope.hostId,
          old: { ...identity(old.stat), uid: String(old.stat.uid), gid: String(old.stat.gid), mode: String(old.stat.mode),
            size: String(old.stat.size), sha256: digest(old.bytes) } };
        const bytes = Buffer.from(`${JSON.stringify(marker)}\n`);
        check();
        const fd = fs.openSync(markerFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        syncDir(migrationDir, dirIdentity, "migration directory");
        const data = readFile(markerFile, MAX_MARKER_BYTES, "transition marker");
        if (!data.bytes.equals(bytes)) fail("transition marker changed during creation.");
        markerState = { identity: identity(data.stat), bytes: Buffer.from(data.bytes) };
        step("transition-synced");
      }
      if (marker?.version !== 1 || marker.stateDir !== path.resolve(stateDir) || marker.hostId !== scope.hostId ||
          marker.state?.dev !== state.dev || marker.state?.ino !== state.ino ||
          !/^[1-9]\d*$/.test(marker.old?.dev ?? "") || !/^[1-9]\d*$/.test(marker.old?.ino ?? "") ||
          !/^[0-9]+$/.test(marker.old?.uid ?? "") || !/^[0-9]+$/.test(marker.old?.gid ?? "") ||
          !/^[0-9]+$/.test(marker.old?.mode ?? "") || !/^[0-9]+$/.test(marker.old?.size ?? "") ||
          !/^[0-9a-f]{64}$/.test(marker.old?.sha256 ?? "")) fail("transition marker does not match the current state.");
      function oldMatches(file, links) {
        const old = readFile(file, MAX_LOCK_BYTES, "preserved legacy lock", { privateMode: false, links, expected: marker.old });
        if (String(old.stat.uid) !== marker.old.uid || String(old.stat.gid) !== marker.old.gid || String(old.stat.mode) !== marker.old.mode ||
            String(old.stat.size) !== marker.old.size || digest(old.bytes) !== marker.old.sha256 || !/^[1-9]\d*\n$/.test(old.bytes.toString("utf8"))) fail("preserved legacy lock changed.");
        return old;
      }
      check();
      let source = statMaybe(oldFile), backup = statMaybe(backupFile);
      if (!backup) {
        if (!source || !source.isFile()) fail("legacy lock is missing before backup.");
        oldMatches(oldFile, 1n);
        check();
        fs.linkSync(oldFile, backupFile);
        step("backup-linked");
        oldMatches(oldFile, 2n); oldMatches(backupFile, 2n);
        syncDir(migrationDir, dirIdentity, "migration directory");
        step("backup-synced");
        source = statMaybe(oldFile); backup = statMaybe(backupFile);
      }
      if (source && source.isFile() && !source.isSymbolicLink()) {
        oldMatches(oldFile, 2n); oldMatches(backupFile, 2n);
        const fd = fs.openSync(oldFile, flags());
        try {
          if (!same(fs.fstatSync(fd, { bigint: true }), marker.old)) fail("legacy lock changed before synchronization.");
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        oldMatches(oldFile, 2n); oldMatches(backupFile, 2n);
        syncDir(migrationDir, dirIdentity, "migration directory");
        // 条件付き unlink は Node/POSIX にない。同 UID の namespace 変更禁止が前提。
        check();
        fs.unlinkSync(oldFile);
        step("legacy-name-unlinked");
        syncDir(stateDir, state, "state directory");
        step("legacy-name-synced");
      } else if (source && (!source.isDirectory() || source.isSymbolicLink())) fail("state lock was replaced.");
      oldMatches(backupFile, 1n);
      syncDir(migrationDir, dirIdentity, "migration directory");
      syncDir(stateDir, state, "state directory");
      check();
      const result = invoke(runMigration, { stateDir, scope, migrationDir, migrationDirectoryIdentity: dirIdentity }, "barrier migration");
      if (result?.protocol !== "posix-local-v3" || result.hostId !== scope.hostId || result.fileSystem !== "apfs" ||
          result.directoryIdentity?.dev !== state.dev || result.directoryIdentity?.ino !== state.ino ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.epoch ?? "")) {
        fail("barrier migration did not return a verified protocol.");
      }
      const barrier = checkDir(oldFile, result.barrierIdentity, "new state barrier");
      if (!result.barrierIdentity || barrier.dev !== BigInt(state.dev)) fail("new state barrier identity is unavailable.");
      const published = path.join(oldFile, "protocol.json"), native = path.join(oldFile, "native.lock");
      const publishedStat = checkOwned(fs.lstatSync(published, { bigint: true }), false, "new protocol marker");
      if (!same(publishedStat, result.markerIdentity) || ![1n, 2n].includes(publishedStat.nlink)) fail("new protocol marker identity changed.");
      const publishedBytes = readFile(published, MAX_MARKER_BYTES, "new protocol marker", { links: publishedStat.nlink, expected: result.markerIdentity }).bytes;
      let publishedMarker;
      try { publishedMarker = JSON.parse(publishedBytes.toString("utf8")); } catch { fail("new protocol marker is corrupt."); }
      const nativeStat = checkOwned(fs.lstatSync(native, { bigint: true }), false, "new native lock");
      if (!same(nativeStat, result.lockIdentity) || nativeStat.nlink !== 1n || publishedMarker?.protocol !== result.protocol ||
          publishedMarker.epoch !== result.epoch || publishedMarker.hostId !== result.hostId || publishedMarker.fileSystem !== "apfs" ||
          publishedMarker.directoryIdentity?.dev !== state.dev || publishedMarker.directoryIdentity?.ino !== state.ino ||
          publishedMarker.barrierIdentity?.dev !== result.barrierIdentity.dev || publishedMarker.barrierIdentity?.ino !== result.barrierIdentity.ino ||
          publishedMarker.markerIdentity?.dev !== result.markerIdentity.dev || publishedMarker.markerIdentity?.ino !== result.markerIdentity.ino ||
          publishedMarker.lockIdentity?.dev !== result.lockIdentity.dev || publishedMarker.lockIdentity?.ino !== result.lockIdentity.ino) {
        fail("new state protocol does not match its files.");
      }
      const verified = readPosixStateLockProtocol(oldFile, scope, state);
      if (verified.protocol !== result.protocol || verified.epoch !== result.epoch || verified.hostId !== scope.hostId) {
        fail("new state protocol validation disagrees with migration.");
      }
      getProtectedDarwinJobIds({ stateDir, epoch: verified.epoch });
      const rechecked = readPosixStateLockProtocol(oldFile, scope, state);
      if (rechecked.protocol !== verified.protocol || rechecked.epoch !== verified.epoch || rechecked.hostId !== verified.hostId) {
        fail("new state protocol changed during ledger validation.");
      }
      check();
      oldMatches(backupFile, 1n);
      return result;
      } finally { ACTIVE_GUARD_CONTEXTS.delete(guardContext); }
    });
  } finally { if (guardFd !== undefined) fs.closeSync(guardFd); }
  } finally { ACTIVE_MIGRATIONS.delete(activeKey); }
}
