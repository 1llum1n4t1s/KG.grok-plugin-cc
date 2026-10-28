import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { inspectPosixStateLockScope } from "./posix-state-lock.mjs";
import { parseBrokerAdmission } from "./broker-lifecycle.mjs";
import { parseDirectStartAdmission } from "./direct-start-admission.mjs";
import { assertDarwinLegacyGuardContext } from "./darwin-legacy-lock-migration.mjs";
import { assertDarwinLegacyOfflineAuthorization, assertDarwinMigrationStateContext } from "./state.mjs";

const BROKER_DIR = "broker-v2";
const JOURNAL = "broker-admission.jsonl";
const DIRECT_DIR = "direct-start-v1";
const PRESERVED_DIR = "direct-start-v1-preserved";
const MARKER_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const MAX_JOURNAL = 4 * 1024 * 1024;
const MAX_MARKER = 3 * 8192;
const MAX_MARKERS = 256;

function fail(detail) { throw new Error(`Darwin migration inventory ${detail}`); }
function same(a, b) { return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino); }
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function owned(stat, directory, dev, label) {
  if (typeof process.getuid !== "function" || !stat || stat.isSymbolicLink() ||
      !(directory ? stat.isDirectory() : stat.isFile()) || stat.uid !== BigInt(process.getuid()) ||
      stat.dev <= 0n || stat.dev !== BigInt(dev) || stat.ino <= 0n || (stat.mode & 0o7077n) !== 0n ||
      (!directory && (stat.nlink !== 1n || (stat.mode & 0o400n) === 0n))) fail(`${label} identity or permissions are invalid.`);
  return stat;
}
function maybe(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
function openFlags(directory = false) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;
  if (!(O_NOFOLLOW > 0) || !(O_NONBLOCK > 0)) fail("requires no-follow and nonblocking open support.");
  return O_RDONLY | O_NOFOLLOW | O_NONBLOCK | (directory ? (O_DIRECTORY ?? 0) : 0);
}
function directory(file, dev, expected, label) {
  const stat = owned(fs.lstatSync(file, { bigint: true }), true, dev, label);
  if (expected && !same(stat, expected)) fail(`${label} changed.`);
  return stat;
}
function names(file, dev, expected, maximum, label) {
  directory(file, dev, expected, label);
  const result = [], handle = fs.opendirSync(file);
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      result.push(entry.name);
      if (result.length > maximum) fail(`${label} has too many entries.`);
    }
  } finally { handle.closeSync(); }
  directory(file, dev, expected, label);
  return result.sort();
}
function syncDirectory(file, dev, expected, label) {
  directory(file, dev, expected, label);
  const fd = fs.openSync(file, openFlags(true));
  try {
    if (!same(owned(fs.fstatSync(fd, { bigint: true }), true, dev, label), expected)) fail(`${label} changed before sync.`);
    fs.fsyncSync(fd);
    directory(file, dev, expected, label);
  } finally { fs.closeSync(fd); }
}
function read(file, dev, maximum, label) {
  const before = owned(fs.lstatSync(file, { bigint: true }), false, dev, label);
  if (before.size > BigInt(maximum)) fail(`${label} exceeds its size limit.`);
  const fd = fs.openSync(file, openFlags());
  try {
    const check = stat => {
      owned(stat, false, dev, label);
      if (!same(stat, before) || stat.size !== before.size || stat.mode !== before.mode || stat.uid !== before.uid ||
          stat.gid !== before.gid || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs) fail(`${label} changed while reading.`);
    };
    check(fs.fstatSync(fd, { bigint: true }));
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    if (offset !== Number(before.size)) fail(`${label} changed size while reading.`);
    check(fs.fstatSync(fd, { bigint: true }));
    check(fs.lstatSync(file, { bigint: true }));
    return { bytes: bytes.subarray(0, offset), identity: identity(before) };
  } finally { fs.closeSync(fd); }
}

/**
 * 全旧 process の停止と同 UID の namespace 変更禁止を確認した明示移行中のみ呼ぶ。
 * @param {{ stateDir?: string, scope?: { fileSystem?: string, hostId?: string, directoryIdentity?: { dev: string, ino: string } }, migrationDir?: string, migrationDirectoryIdentity?: { dev: string, ino: string }, guardContext?: any, deadline?: number }} options
 */
export function verifyDarwinMigrationInventory({ stateDir, scope, migrationDir, migrationDirectoryIdentity, guardContext, deadline = performance.now() + 7500 } = {}) {
  if (!Number.isFinite(deadline)) fail("requires a finite inspection deadline.");
  const remaining = () => {
    const value = deadline - performance.now();
    if (value <= 0) fail("inspection deadline exceeded.");
    return Math.ceil(value);
  };
  assertDarwinLegacyGuardContext(guardContext);
  remaining();
  if (process.platform !== "darwin" || typeof stateDir !== "string" || !path.isAbsolute(stateDir) ||
      path.resolve(stateDir) !== stateDir || fs.realpathSync.native(stateDir) !== stateDir ||
      migrationDir !== path.join(stateDir, ".darwin-legacy-migration") ||
      guardContext.stateDir !== stateDir || guardContext.migrationDir !== migrationDir ||
      guardContext.hostId !== scope?.hostId || guardContext.fileSystem !== scope?.fileSystem ||
      !same(guardContext.directoryIdentity, scope?.directoryIdentity ?? {}) ||
      !same(guardContext.migrationDirectoryIdentity, migrationDirectoryIdentity ?? {}) ||
      !/^[1-9]\d*$/.test(migrationDirectoryIdentity?.dev ?? "") ||
      !/^[1-9]\d*$/.test(migrationDirectoryIdentity?.ino ?? "")) fail("requires the canonical Darwin state directory and migration identity.");
  const state = fs.lstatSync(stateDir, { bigint: true });
  owned(state, true, state.dev, "state directory");
  const stateIdentity = identity(state), dev = stateIdentity.dev;
  const actualScope = inspectPosixStateLockScope(stateDir, { timeoutMs: remaining() });
  remaining();
  if (actualScope.fileSystem !== "apfs" || scope?.fileSystem !== "apfs" || !actualScope.hostId ||
      actualScope.hostId !== scope.hostId || !same(actualScope.directoryIdentity, stateIdentity) ||
      !same(scope.directoryIdentity ?? {}, stateIdentity)) fail("state host, filesystem or identity does not match.");
  directory(migrationDir, dev, migrationDirectoryIdentity, "migration directory");
  const checkRoot = () => {
    remaining();
    assertDarwinLegacyGuardContext(guardContext);
    remaining();
    directory(stateDir, dev, stateIdentity, "state directory");
    directory(migrationDir, dev, migrationDirectoryIdentity, "migration directory");
  };
  const brokerDir = path.join(stateDir, BROKER_DIR), directDir = path.join(stateDir, DIRECT_DIR);
  const broker = maybe(brokerDir), direct = maybe(directDir);
  let brokerIdentity, journal;
  if (broker) {
    brokerIdentity = identity(owned(broker, true, dev, "broker directory"));
    const entries = names(brokerDir, dev, brokerIdentity, 3, "broker directory");
    // broker.json / broker.lock は停止確認だけで所有権や安全な回収を証明できない。
    if (entries.some(name => name !== JOURNAL)) fail("broker directory contains unresolved or unknown entries.");
    if (entries.includes(JOURNAL)) {
      journal = read(path.join(brokerDir, JOURNAL), dev, MAX_JOURNAL, "broker journal");
      remaining();
      if (parseBrokerAdmission(journal.bytes).pending) fail("broker journal contains an unconfirmed generation.");
      for (const line of journal.bytes.toString("utf8").split("\n")) {
        if (!line) continue;
        const record = JSON.parse(line);
        if (record.event === "pending" && record.platform !== "darwin") fail("broker journal belongs to another platform.");
      }
    }
  }
  const markers = [];
  let directIdentity;
  if (direct) {
    directIdentity = identity(owned(direct, true, dev, "direct directory"));
    for (const name of names(directDir, dev, directIdentity, MAX_MARKERS, "direct directory")) {
      remaining();
      if (!MARKER_NAME.test(name)) fail("direct directory contains an unknown entry.");
      const source = read(path.join(directDir, name), dev, MAX_MARKER, "direct marker");
      remaining();
      const parsed = parseDirectStartAdmission(source.bytes, name), owner = parsed.pending.ownerIdentity;
      if (!parsed.confirmed || owner.stateDir !== stateDir || owner.hostId !== scope.hostId || owner.volumeGuid !== null ||
          !same(owner.directoryIdentity, stateIdentity)) fail("direct marker is unconfirmed or belongs to another state.");
      markers.push({ name, ...source });
    }
  }
  checkRoot();
  const brokerCopy = path.join(migrationDir, "broker-admission-preserved.jsonl");
  if (maybe(brokerCopy)) {
    if (!journal) fail("preserved broker journal has no verified source.");
    const copy = read(brokerCopy, dev, MAX_JOURNAL, "preserved broker journal");
    if (!copy.bytes.equals(journal.bytes) || same(copy.identity, journal.identity)) fail("preserved broker journal does not match its source.");
  }
  const preservedDir = path.join(migrationDir, PRESERVED_DIR);
  const preserved = maybe(preservedDir);
  if (preserved) {
    const preservedIdentity = identity(owned(preserved, true, dev, "preserved direct directory"));
    const existing = names(preservedDir, dev, preservedIdentity, MAX_MARKERS, "preserved direct directory");
    if (existing.some(name => !markers.some(marker => marker.name === name))) fail("preserved direct directory contains an unknown entry.");
    // コピー途中の停止では、既存分だけを検証し不足分は保全処理で作る。
    // 不明な名前や一致しないコピーを上書き・回収してはいけない。
    for (const name of existing) {
      const marker = markers.find(item => item.name === name);
      checkRoot();
      const destination = path.join(preservedDir, marker.name);
      const copy = read(destination, dev, MAX_MARKER, "preserved direct marker");
      if (!copy.bytes.equals(marker.bytes) || same(copy.identity, marker.identity)) fail("preserved direct marker does not match its source.");
    }
  }
  checkRoot();
  if (broker) {
    const current = names(brokerDir, dev, brokerIdentity, 3, "broker directory");
    if (current.join("\n") !== (journal ? JOURNAL : "")) fail("broker inventory changed.");
    if (journal) {
      const reread = read(path.join(brokerDir, JOURNAL), dev, MAX_JOURNAL, "broker journal");
      if (!same(reread.identity, journal.identity) || !reread.bytes.equals(journal.bytes)) fail("broker journal changed.");
    }
  } else if (maybe(brokerDir)) fail("broker directory appeared during inspection.");
  if (direct) {
    const current = names(directDir, dev, directIdentity, MAX_MARKERS, "direct directory");
    if (current.join("\n") !== markers.map(marker => marker.name).join("\n")) fail("direct inventory changed.");
    for (const marker of markers) {
      const reread = read(path.join(directDir, marker.name), dev, MAX_MARKER, "direct marker");
      if (!same(reread.identity, marker.identity) || !reread.bytes.equals(marker.bytes)) fail("direct marker changed.");
    }
  } else if (maybe(directDir)) fail("direct directory appeared during inspection.");
  checkRoot();
  remaining();
  return true;
}

/**
 * 認可済み offline migration だけが不変コピーを作る。
 * @param {{ stateDir?: string, guardContext?: any, preflightToken?: object, offlineAuthorization?: object, deadline?: number }} options
 */
export function preserveDarwinMigrationInventory({ stateDir, guardContext, preflightToken, offlineAuthorization, deadline = performance.now() + 7500 } = {}) {
  const check = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline) fail("preservation deadline exceeded.");
    assertDarwinLegacyOfflineAuthorization(offlineAuthorization, guardContext, preflightToken, deadline);
    if (guardContext.stateDir !== stateDir) fail("preservation state directory changed.");
  };
  check();
  const { migrationDir, migrationDirectoryIdentity, directoryIdentity, hostId, fileSystem } = guardContext;
  const scope = { hostId, fileSystem, directoryIdentity }, dev = directoryIdentity.dev;
  verifyDarwinMigrationInventory({ stateDir, scope, migrationDir, migrationDirectoryIdentity, guardContext, deadline });
  check();
  const copy = (sourcePath, destination, destinationDir, destinationIdentity, maximum, label) => {
    check();
    const source = read(sourcePath, dev, maximum, label);
    if (!maybe(destination)) {
      const fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, source.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      check(); syncDirectory(destinationDir, dev, destinationIdentity, "preserved inventory directory");
    }
    const saved = read(destination, dev, maximum, `preserved ${label}`);
    if (!saved.bytes.equals(source.bytes) || same(saved.identity, source.identity)) fail(`preserved ${label} does not match its independent source.`);
    const fd = fs.openSync(destination, openFlags());
    try {
      if (!same(owned(fs.fstatSync(fd, { bigint: true }), false, dev, `preserved ${label}`), saved.identity)) fail(`preserved ${label} changed before sync.`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    check(); syncDirectory(destinationDir, dev, destinationIdentity, "preserved inventory directory");
    const sourceAfter = read(sourcePath, dev, maximum, label), savedAfter = read(destination, dev, maximum, `preserved ${label}`);
    if (!same(sourceAfter.identity, source.identity) || !sourceAfter.bytes.equals(source.bytes) ||
        !same(savedAfter.identity, saved.identity) || !savedAfter.bytes.equals(saved.bytes)) fail(`${label} changed during preservation.`);
    check();
    return Object.freeze({ name: path.basename(destination), identity: Object.freeze({ ...saved.identity }),
      size: String(saved.bytes.length), sha256: createHash("sha256").update(saved.bytes).digest("hex") });
  };
  let broker = null;
  const brokerPath = path.join(stateDir, BROKER_DIR, JOURNAL);
  if (maybe(brokerPath)) broker = copy(brokerPath, path.join(migrationDir, "broker-admission-preserved.jsonl"),
    migrationDir, migrationDirectoryIdentity, MAX_JOURNAL, "broker journal");
  const directPath = path.join(stateDir, DIRECT_DIR), sourceDir = maybe(directPath), direct = [];
  if (sourceDir) {
    const sourceIdentity = identity(owned(sourceDir, true, dev, "direct directory"));
    const sourceNames = names(directPath, dev, sourceIdentity, MAX_MARKERS, "direct directory");
    if (sourceNames.length) {
      const preservedDir = path.join(migrationDir, PRESERVED_DIR);
      if (!maybe(preservedDir)) {
        check(); fs.mkdirSync(preservedDir, { mode: 0o700 });
        syncDirectory(migrationDir, dev, migrationDirectoryIdentity, "migration directory");
      }
      const preservedIdentity = identity(directory(preservedDir, dev, null, "preserved direct directory"));
      const existing = names(preservedDir, dev, preservedIdentity, MAX_MARKERS, "preserved direct directory");
      if (existing.some(name => !sourceNames.includes(name))) fail("preserved direct directory contains an unknown entry.");
      for (const name of sourceNames) {
        if (!MARKER_NAME.test(name)) fail("direct directory contains an unknown entry.");
        direct.push(copy(path.join(directPath, name), path.join(preservedDir, name), preservedDir, preservedIdentity, MAX_MARKER, "direct marker"));
      }
    }
  }
  verifyDarwinMigrationInventory({ stateDir, scope, migrationDir, migrationDirectoryIdentity, guardContext, deadline });
  check();
  return Object.freeze({ broker, direct: Object.freeze(direct) });
}

/**
 * 移行専用 mutex と guard の下で、完成証拠に記載された独立コピーを照合する。
 * live journal や direct marker は移行後に変化し得るので参照しない。
 * @param {{ guardContext?: any, migrationStateContext?: any, manifest?: any, deadline?: number }} options
 */
export function verifyDarwinMigrationPreservation(options = {}) {
  // 未認証の manifest getter に触れる前に、両方の実能力を確認する。
  const guardContext = options.guardContext, migrationStateContext = options.migrationStateContext;
  const deadline = options.deadline ?? performance.now() + 7500;
  const check = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline) fail("preservation verification deadline exceeded.");
    assertDarwinLegacyGuardContext(guardContext, deadline);
    assertDarwinMigrationStateContext(migrationStateContext, guardContext, deadline);
  };
  check();
  const manifest = options.manifest;
  const keys = (value, expected) => value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
  if (!keys(manifest, ["version", "broker", "direct"]) || manifest.version !== 1 ||
      !Array.isArray(manifest.direct) || manifest.direct.length > MAX_MARKERS) fail("preservation manifest schema is invalid.");
  const { stateDir, migrationDir, migrationDirectoryIdentity, directoryIdentity, hostId } = guardContext;
  const dev = directoryIdentity.dev;
  directory(migrationDir, dev, migrationDirectoryIdentity, "migration directory");
  const validateCopy = (entry, file, maximum, label) => {
    check();
    if (!keys(entry, ["name", "identity", "size", "sha256"]) ||
        !keys(entry.identity, ["dev", "ino"]) || !/^[1-9]\d*$/.test(entry.identity.dev) ||
        !/^[1-9]\d*$/.test(entry.identity.ino) || !/^(0|[1-9]\d*)$/.test(entry.size) ||
        !/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`${label} manifest entry is invalid.`);
    const saved = read(file, dev, maximum, label);
    if (!same(saved.identity, entry.identity) || String(saved.bytes.length) !== entry.size ||
        createHash("sha256").update(saved.bytes).digest("hex") !== entry.sha256) fail(`${label} does not match its manifest.`);
    check();
    return saved.bytes;
  };
  const brokerFile = path.join(migrationDir, "broker-admission-preserved.jsonl");
  if (manifest.broker === null) {
    if (maybe(brokerFile)) fail("unexpected preserved broker journal.");
  } else {
    if (manifest.broker?.name !== "broker-admission-preserved.jsonl") fail("preserved broker journal name is invalid.");
    const bytes = validateCopy(manifest.broker, brokerFile, MAX_JOURNAL, "preserved broker journal");
    if (parseBrokerAdmission(bytes).pending) fail("preserved broker journal contains an unconfirmed generation.");
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (record.event === "pending" && record.platform !== "darwin") fail("preserved broker journal belongs to another platform.");
    }
  }
  const preservedDir = path.join(migrationDir, PRESERVED_DIR), preserved = maybe(preservedDir);
  if (!preserved && manifest.direct.length) fail("preserved direct directory is missing.");
  if (preserved) {
    const dirIdentity = identity(owned(preserved, true, dev, "preserved direct directory"));
    const actual = names(preservedDir, dev, dirIdentity, MAX_MARKERS, "preserved direct directory");
    const declared = manifest.direct.map(entry => entry?.name);
    if (declared.some(name => typeof name !== "string" || !MARKER_NAME.test(name)) ||
        declared.join("\n") !== [...new Set(declared)].sort().join("\n") || actual.join("\n") !== declared.join("\n")) fail("preserved direct inventory does not match its manifest.");
    for (const entry of manifest.direct) {
      const bytes = validateCopy(entry, path.join(preservedDir, entry.name), MAX_MARKER, "preserved direct marker");
      const parsed = parseDirectStartAdmission(bytes, entry.name), owner = parsed.pending.ownerIdentity;
      if (!parsed.confirmed || owner.stateDir !== stateDir || owner.hostId !== hostId || owner.volumeGuid !== null ||
          !same(owner.directoryIdentity, directoryIdentity)) fail("preserved direct marker belongs to another state or is unconfirmed.");
    }
    directory(preservedDir, dev, dirIdentity, "preserved direct directory");
  }
  check();
  directory(migrationDir, dev, migrationDirectoryIdentity, "migration directory");
  return true;
}
