import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fdMountId, initializeLinuxEpochRecovery, requireLinuxEpochRecovery } from "./linux-epoch-recovery.mjs";
import { linuxSentinelExited, openLinuxSentinelProcess, sentinelScript, verifyLinuxSentinel } from "./linux-state-sentinel.mjs";
import { assertDarwinMigrationAuthorization } from "./state.mjs";

const DARWIN_PROTOCOL = "posix-local-v4";
const LINUX_PROTOCOL = "posix-linux-worker-lease-v6";
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const LOCK = "native.lock";
const MARKER = "protocol.json";
const LINUX_ACTIVE_ROOTS = new Set();

function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function same(a, b) { return Boolean(a && b && a.dev === b.dev && a.ino === b.ino); }
function checkedStat(target, directory = false) {
  const stat = fs.lstatSync(target, { bigint: true });
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || stat.ino <= 0n || stat.dev <= 0n
      || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n) {
    throw new Error(`POSIX state lock ownership, permissions or identity is invalid: ${target}`);
  }
  return stat;
}
function utility(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1048576, ...options });
}

// root lock は native mutex より先に取得する。lockFd は callback や外部 API に
// 渡さず、この module だけが bootstrap の FD7 に同じ description を渡す。
function withLinuxRootLock(stateDir, timeoutMs, run) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError("Linux root lock timeout is invalid");
  const deadline = process.hrtime.bigint() + BigInt(Math.ceil(timeoutMs * 1000000));
  const remaining = () => {
    if (timeoutMs === 0) return 0;
    const ns = deadline - process.hrtime.bigint();
    if (ns <= 0n) throw new Error("Timed out acquiring Linux state root lock");
    return Number(ns) / 1000000;
  };
  if (!path.isAbsolute(stateDir) || path.resolve(stateDir) !== stateDir) {
    throw new Error("Linux state root must be an absolute directory");
  }
  const before = identity(checkedStat(stateDir, true)), key = `${before.dev}:${before.ino}`;
  if (LINUX_ACTIVE_ROOTS.has(key)) throw new Error("Linux state root lock cannot be reentered");
  const lockFd = fs.openSync(stateDir, checkedOpenFlags(true));
  try {
    const mount = fdMountId(lockFd);
    const check = () => {
      if (!same(before, identity(fs.fstatSync(lockFd, { bigint: true }))) ||
          !same(before, identity(checkedStat(stateDir, true))) || fdMountId(lockFd) !== mount) {
        throw new Error("Linux state root identity or mount changed");
      }
      const namedFd = fs.openSync(stateDir, checkedOpenFlags(true));
      try {
        if (!same(before, identity(fs.fstatSync(namedFd, { bigint: true }))) ||
            !same(before, identity(checkedStat(stateDir, true))) || fdMountId(namedFd) !== mount) {
          throw new Error("Linux named state root identity or mount changed");
        }
      } finally { fs.closeSync(namedFd); }
    };
    check();
    for (;;) {
      const budget = remaining();
      try {
        utility("/usr/bin/flock", ["-x", "-n", "3"], { stdio: ["ignore", "pipe", "pipe", lockFd], timeout: timeoutMs === 0 ? 5000 : Math.max(1, Math.ceil(budget)) });
        break;
      } catch (error) {
        if (error?.status !== 1 || error?.signal || error?.code) throw new Error("Linux state root lock utility failed", { cause: error });
        if (timeoutMs === 0) throw new Error("Timed out acquiring Linux state root lock");
        Atomics.wait(SLEEP, 0, 0, Math.min(10, remaining()));
      }
    }
    if (timeoutMs > 0) remaining();
    check(); LINUX_ACTIVE_ROOTS.add(key);
    try { return run({ lockFd, deadline, remaining, check, identity: before, mount }); }
    finally { LINUX_ACTIVE_ROOTS.delete(key); }
  } finally { fs.closeSync(lockFd); }
}
function hostId(timeout) {
  let id;
  if (process.platform === "linux") {
    try { id = fs.readFileSync("/etc/machine-id", "utf8").trim(); } catch { throw new Error("POSIX state lock host identity is unavailable"); }
    if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error("POSIX state lock host identity is unavailable");
  } else {
    try {
      const value = utility("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout });
      id = value.match(/"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"/i)?.[1];
    } catch { throw new Error("POSIX state lock host identity is unavailable"); }
    if (!id || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw new Error("POSIX state lock host identity is unavailable");
  }
  return createHash("sha256").update(`${process.platform}:${id.toLowerCase()}`).digest("hex");
}
function linuxProcessScope() {
  let bootId, pidNamespace, timeNamespace, netNamespace, status;
  try {
    bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
    pidNamespace = fs.readlinkSync("/proc/self/ns/pid");
    timeNamespace = fs.readlinkSync("/proc/self/ns/time");
    netNamespace = fs.readlinkSync("/proc/self/ns/net");
    status = fs.readFileSync("/proc/self/status", "utf8");
  } catch { throw new Error("POSIX state lock Linux process identity is unavailable"); }
  // procfs の PID view と kill(0) が同じ namespace に属することを確認する。
  const lines = status.split("\n").filter(line => line.startsWith("NSpid:"));
  const match = lines.length === 1 ? lines[0].match(/^NSpid:[\t ]+([1-9]\d*)[\t ]*\r?$/) : null;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)
      || !/^pid:\[[1-9]\d*\]$/.test(pidNamespace) || !/^time:\[[1-9]\d*\]$/.test(timeNamespace)
      || !/^net:\[[1-9]\d*\]$/.test(netNamespace) || !match || match[1] !== String(process.pid)) {
    throw new Error("POSIX state lock Linux process identity or procfs PID view is invalid");
  }
  return { bootId, pidNamespace, timeNamespace, netNamespace };
}
function filesystem(ancestor, timeout) {
  if (process.platform === "linux") {
    const type = Number(fs.statfsSync(ancestor).type);
    if (type !== 0xef53 && type !== 0x01021994) throw new Error("POSIX state lock requires a verified local filesystem (ext4 or tmpfs)");
    // ext2/3/4 は同じ statfs magic のため、mount namespace の型も照合する。
    const dev = fs.statSync(ancestor, { bigint: true }).dev;
    const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
    const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
    let mounts;
    try { mounts = fs.readFileSync("/proc/self/mountinfo", "utf8"); } catch { throw new Error("POSIX state lock filesystem inspection failed"); }
    const device = `${major}:${minor}`;
    const matches = [];
    for (const line of mounts.split("\n")) {
      const split = line.split(" - ");
      const fields = split[0].split(" ");
      if (fields[2] === device) {
        if (split.length !== 2 || !split[1]) throw new Error("POSIX state lock filesystem inspection failed");
        matches.push(split[1].split(" ")[0]);
      }
    }
    const expected = type === 0xef53 ? "ext4" : "tmpfs";
    if (!matches.length || matches.some(value => value !== expected)) throw new Error("POSIX state lock requires a verified local filesystem (ext4 or tmpfs)");
    return expected;
  }
  let mounts;
  try { mounts = utility("/sbin/mount", [], { timeout }); } catch { throw new Error("POSIX state lock filesystem inspection failed"); }
  const dev = fs.statSync(ancestor, { bigint: true }).dev;
  const canonical = fs.realpathSync.native(ancestor);
  const matches = [];
  for (const line of mounts.split("\n")) {
    const match = line.match(/^.+ on (.+) \(([^)]*)\)$/);
    if (!match) continue;
    const mountPoint = match[1];
    const options = match[2].split(", ").map(value => value.trim());
    // firmlink 経由のユーザーデータは Data volume と / のどちらにも見える。
    // 無関係な remote mount は stat しない（応答不能の場合がある）。
    const ancestorMount = mountPoint === "/" || canonical === mountPoint || canonical.startsWith(`${mountPoint}/`);
    const dataVolume = mountPoint === "/System/Volumes/Data" && options.includes("apfs") && options.includes("local");
    if (!ancestorMount && !dataVolume) continue;
    try {
      if (fs.statSync(mountPoint, { bigint: true }).dev === dev) matches.push(options);
    } catch { throw new Error("POSIX state lock filesystem inspection failed"); }
  }
  if (!matches.length || matches.some(options => !options.includes("apfs") || !options.includes("local"))) {
    throw new Error("POSIX state lock requires a verified local APFS filesystem");
  }
  return "apfs";
}
/**
 * @param {string} stateDir
 * @param {{ timeoutMs?: number }} options
 * @returns {{ hostId: string, fileSystem: string, directoryIdentity: { dev: string, ino: string }, bootId?: string, pidNamespace?: string, timeNamespace?: string, netNamespace?: string, volumeGuid?: string }}
 */
export function inspectPosixStateLockScope(stateDir, options = {}) {
  const { timeoutMs } = options;
  if (timeoutMs !== undefined && timeoutMs <= 0) throw new Error("Timed out inspecting POSIX state lock");
  const deadline = performance.now() + (timeoutMs ?? 5000);
  const remaining = () => {
    const value = Math.ceil(deadline - performance.now());
    if (value <= 0) throw new Error("Timed out inspecting POSIX state lock");
    return value;
  };
  const processScope = process.platform === "linux" ? linuxProcessScope() : {};
  let ancestor = stateDir;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("POSIX state lock directory is unavailable");
    ancestor = parent;
  }
  const before = identity(fs.statSync(ancestor, { bigint: true }));
  const kind = filesystem(ancestor, remaining());
  const host = hostId(remaining());
  if (!same(before, identity(fs.statSync(ancestor, { bigint: true })))) throw new Error("POSIX state directory changed during filesystem inspection");
  return { hostId: host, fileSystem: kind, directoryIdentity: before, ...processScope };
}

function checkedOpenFlags(directory = false) {
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW, O_DIRECTORY } = fs.constants;
  if (!Number.isInteger(O_NONBLOCK) || O_NONBLOCK <= 0 || !Number.isInteger(O_NOFOLLOW) || O_NOFOLLOW <= 0) {
    throw new Error("POSIX state lock requires nonblocking and no-follow open support");
  }
  return O_RDONLY | O_NONBLOCK | O_NOFOLLOW | (directory ? (O_DIRECTORY ?? 0) : 0);
}
function openChecked(file) {
  const before = checkedStat(file);
  const fd = fs.openSync(file, checkedOpenFlags());
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !same(identity(before), identity(opened)) || !same(identity(opened), identity(checkedStat(file)))) {
      throw new Error(`POSIX state lock identity changed during open: ${file}`);
    }
    return { fd, stat: opened };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function withLinuxDirectories(stateDir, run) {
  const stateBefore = identity(checkedStat(stateDir, true));
  const stateFd = fs.openSync(stateDir, checkedOpenFlags(true));
  try {
    const state = fs.fstatSync(stateFd, { bigint: true });
    if (!state.isDirectory() || !same(identity(state), stateBefore) || !same(identity(checkedStat(stateDir, true)), stateBefore)) {
      throw new Error("POSIX state directory identity changed during open");
    }
    const statePath = `/proc/self/fd/${stateFd}/.`;
    const barrierName = `/proc/self/fd/${stateFd}/state.lock`;
    const before = identity(checkedStat(barrierName, true));
    const barrierFd = fs.openSync(barrierName, checkedOpenFlags(true));
    try {
      const barrier = fs.fstatSync(barrierFd, { bigint: true });
      if (!barrier.isDirectory() || !same(identity(barrier), before) || !same(identity(checkedStat(barrierName, true)), before)) {
        throw new Error("POSIX state lock directory identity changed during open");
      }
      const mount = fdMountId(stateFd);
      if (fdMountId(barrierFd) !== mount) throw new Error("POSIX state lock crosses a mount boundary");
      return run({ stateFd, barrierFd, statePath, lockDir: `/proc/self/fd/${barrierFd}/.`, mount });
    } finally { fs.closeSync(barrierFd); }
  } finally { fs.closeSync(stateFd); }
}
function checkLinuxMount(fd, mount) {
  if (fdMountId(fd) !== mount) throw new Error("POSIX state lock crosses a mount boundary");
}
function verifyLinuxHistoryJournal(linuxDirs, epoch, expected) {
  if (!linuxDirs || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(epoch ?? "") ||
      !expected || !/^[1-9][0-9]*$/.test(expected.dev ?? "") || !/^[1-9][0-9]*$/.test(expected.ino ?? "")) {
    throw new Error("Linux history journal identity is unavailable");
  }
  const namespace = `/proc/self/fd/${linuxDirs.stateFd}/history-journal-v1`;
  const namespaceBefore = checkedStat(namespace, true), namespaceIdentity = identity(namespaceBefore);
  if ((namespaceBefore.mode & 0o7777n) !== 0o700n || namespaceIdentity.dev !== expected.dev) throw new Error("Linux history namespace identity or mode changed");
  const namespaceFd = fs.openSync(namespace, checkedOpenFlags(true));
  try {
    if (!same(identity(fs.fstatSync(namespaceFd, { bigint: true })), namespaceIdentity)) throw new Error("Linux history namespace changed during open");
    checkLinuxMount(linuxDirs.stateFd, linuxDirs.mount); checkLinuxMount(namespaceFd, linuxDirs.mount);
    const name = `/proc/self/fd/${namespaceFd}/${epoch}`, before = checkedStat(name, true);
    if ((before.mode & 0o7777n) !== 0o700n || !same(identity(before), expected)) throw new Error("Linux history journal identity or mode changed");
    const fd = fs.openSync(name, checkedOpenFlags(true));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isDirectory() || opened.uid !== BigInt(process.getuid()) || (opened.mode & 0o7777n) !== 0o700n ||
          !same(identity(opened), expected) || !same(identity(checkedStat(name, true)), expected)) throw new Error("Linux history journal changed during open");
      checkLinuxMount(fd, linuxDirs.mount);
      if (!same(identity(fs.fstatSync(fd, { bigint: true })), expected) || !same(identity(checkedStat(name, true)), expected) ||
          !same(identity(fs.fstatSync(namespaceFd, { bigint: true })), namespaceIdentity) || !same(identity(checkedStat(namespace, true)), namespaceIdentity)) {
        throw new Error("Linux history journal or namespace identity changed during verification");
      }
      return namespaceIdentity;
    } finally { fs.closeSync(fd); }
  } finally { fs.closeSync(namespaceFd); }
}
function initializeLinuxHistoryJournal(linuxDirs, epoch, rootIdentity) {
  const namespace = `/proc/self/fd/${linuxDirs.stateFd}/history-journal-v1`;
  try { fs.mkdirSync(namespace, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  const before = checkedStat(namespace, true), namespaceIdentity = identity(before);
  if ((before.mode & 0o7777n) !== 0o700n || namespaceIdentity.dev !== rootIdentity.dev) throw new Error("Linux history namespace mode or filesystem is invalid");
  const namespaceFd = fs.openSync(namespace, checkedOpenFlags(true));
  try {
    const opened = fs.fstatSync(namespaceFd, { bigint: true });
    if (!same(identity(opened), namespaceIdentity) || (opened.mode & 0o7777n) !== 0o700n) throw new Error("Linux history namespace changed during creation");
    checkLinuxMount(namespaceFd, linuxDirs.mount); checkLinuxMount(linuxDirs.stateFd, linuxDirs.mount);
    fs.fsyncSync(namespaceFd); fs.fsyncSync(linuxDirs.stateFd);
    const entries = fs.opendirSync(`/proc/self/fd/${namespaceFd}/.`);
    let count = 0;
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (++count > 64 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.name)) {
          throw new Error("Linux history namespace contains unknown or excess epochs; offline recovery is required");
        }
        const oldPath = `/proc/self/fd/${namespaceFd}/${entry.name}`, oldBefore = checkedStat(oldPath, true), oldIdentity = identity(oldBefore);
        if ((oldBefore.mode & 0o7777n) !== 0o700n || oldIdentity.dev !== rootIdentity.dev) throw new Error("Old Linux history journal is invalid");
        const oldFd = fs.openSync(oldPath, checkedOpenFlags(true));
        try {
          if (!same(identity(fs.fstatSync(oldFd, { bigint: true })), oldIdentity)) throw new Error("Old Linux history journal changed");
          checkLinuxMount(oldFd, linuxDirs.mount);
          const oldEntries = fs.opendirSync(`/proc/self/fd/${oldFd}/.`);
          try { if (oldEntries.readSync()) throw new Error("Old Linux history journal contains unconfirmed evidence; offline recovery is required"); }
          finally { oldEntries.closeSync(); }
          fs.fsyncSync(oldFd);
          if (!same(identity(checkedStat(oldPath, true)), oldIdentity)) throw new Error("Old Linux history journal changed during inspection");
        } finally { fs.closeSync(oldFd); }
      }
    } finally { entries.closeSync(); }
    const end = fs.fstatSync(namespaceFd, { bigint: true });
    if (!same(identity(end), namespaceIdentity) || !same(identity(checkedStat(namespace, true)), namespaceIdentity) ||
        end.mtimeNs !== opened.mtimeNs || end.ctimeNs !== opened.ctimeNs) throw new Error("Linux history namespace changed during inspection");
    const journal = `/proc/self/fd/${namespaceFd}/${epoch}`;
    fs.mkdirSync(journal, { mode: 0o700 });
    const journalBefore = checkedStat(journal, true), historyJournalIdentity = identity(journalBefore);
    if ((journalBefore.mode & 0o7777n) !== 0o700n || historyJournalIdentity.dev !== rootIdentity.dev) throw new Error("Linux history journal mode or filesystem is invalid");
    const journalFd = fs.openSync(journal, checkedOpenFlags(true));
    try {
      if (!same(historyJournalIdentity, identity(fs.fstatSync(journalFd, { bigint: true })))) throw new Error("Linux history journal changed during creation");
      checkLinuxMount(journalFd, linuxDirs.mount);
      fs.fsyncSync(journalFd); fs.fsyncSync(namespaceFd); fs.fsyncSync(linuxDirs.stateFd);
      const verifiedNamespace = verifyLinuxHistoryJournal(linuxDirs, epoch, historyJournalIdentity);
      if (!same(verifiedNamespace, namespaceIdentity)) throw new Error("Linux history namespace changed before publication");
    } finally { fs.closeSync(journalFd); }
    return historyJournalIdentity;
  } finally { fs.closeSync(namespaceFd); }
}
function syncDirectory(directory, expected) {
  const before = identity(checkedStat(directory, true));
  if (!same(before, expected)) throw new Error("POSIX state lock directory identity changed before sync");
  const fd = fs.openSync(directory, checkedOpenFlags(true));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || !same(identity(opened), expected)) throw new Error("POSIX state lock directory identity changed during sync");
    fs.fsyncSync(fd);
    if (!same(identity(checkedStat(directory, true)), expected)) throw new Error("POSIX state lock directory identity changed after sync");
  } finally { fs.closeSync(fd); }
}
function validateCore(lockDir, scope, lockedIdentity, openedLock, linuxDirs) {
  const processScope = process.platform === "linux" ? linuxProcessScope() : null;
  const stateDir = linuxDirs?.statePath ?? path.dirname(lockDir);
  const dir = identity(checkedStat(stateDir, true));
  const barrier = identity(checkedStat(lockDir, true));
  const markerPath = path.join(lockDir, MARKER);
  const marker = openChecked(markerPath);
  try {
    if (linuxDirs) checkLinuxMount(marker.fd, linuxDirs.mount);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(marker.fd, "utf8")); } catch { throw new Error("POSIX state lock marker is invalid"); }
    const currentMarker = identity(marker.stat);
    const lockPath = path.join(lockDir, LOCK);
    const currentLock = identity(checkedStat(lockPath));
    if (linuxDirs) {
      const lock = openChecked(lockPath);
      try { checkLinuxMount(lock.fd, linuxDirs.mount); }
      finally { fs.closeSync(lock.fd); }
    }
    if (parsed?.protocol !== (processScope ? LINUX_PROTOCOL : DARWIN_PROTOCOL) || parsed.localOnly !== true || parsed.hostId !== scope.hostId || parsed.fileSystem !== scope.fileSystem
        || (processScope && (!parsed.historyJournalIdentity || typeof parsed.historyJournalIdentity.dev !== "string" || typeof parsed.historyJournalIdentity.ino !== "string"
          || !/^[1-9][0-9]*$/.test(parsed.historyJournalIdentity.dev) || !/^[1-9][0-9]*$/.test(parsed.historyJournalIdentity.ino)
          || parsed.historyJournalIdentity.dev !== dir.dev || !parsed.leaseDirectoryIdentity || typeof parsed.leaseDirectoryIdentity.dev !== "string" || typeof parsed.leaseDirectoryIdentity.ino !== "string"
          || !/^[1-9][0-9]*$/.test(parsed.leaseDirectoryIdentity.dev) || !/^[1-9][0-9]*$/.test(parsed.leaseDirectoryIdentity.ino)
          || parsed.leaseDirectoryIdentity.dev !== dir.dev || typeof parsed.epoch !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.epoch)
          || parsed.bootId !== processScope.bootId || parsed.pidNamespace !== processScope.pidNamespace
          || parsed.timeNamespace !== processScope.timeNamespace || parsed.netNamespace !== processScope.netNamespace
          || scope.bootId !== processScope.bootId || scope.pidNamespace !== processScope.pidNamespace
          || scope.timeNamespace !== processScope.timeNamespace || scope.netNamespace !== processScope.netNamespace
          || parsed.epoch !== parsed.sentinel?.generation))
        || (!processScope && (typeof parsed.epoch !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.epoch)))
        || !same(parsed.directoryIdentity, dir) || !same(parsed.barrierIdentity, barrier)
        || !same(parsed.markerIdentity, currentMarker) || !same(parsed.lockIdentity, currentLock)
        || (scope.directoryIdentity && !same(scope.directoryIdentity, dir))
        || (lockedIdentity && !same(lockedIdentity, dir)) || (openedLock && !same(openedLock, currentLock))
        || dir.dev !== barrier.dev || dir.dev !== currentMarker.dev || dir.dev !== currentLock.dev
        || !same(identity(checkedStat(markerPath)), currentMarker) || !same(identity(checkedStat(stateDir, true)), dir)
        || !same(identity(checkedStat(lockDir, true)), barrier)) {
      throw new Error("POSIX state lock identity or marker changed; offline recovery is required: stop every runtime, preserve the state.lock directory under a unique backup name, then explicitly migrate again");
    }
    // marker公開後のdir fsync失敗時も、別writerが未同期の公開を使わない。
    const historyNamespaceIdentity = processScope ? verifyLinuxHistoryJournal(linuxDirs, parsed.epoch, parsed.historyJournalIdentity) : null;
    syncDirectory(stateDir, dir);
    syncDirectory(lockDir, barrier);
    if (processScope) verifyLinuxSentinel(lockDir, parsed, processScope, linuxDirs.mount);
    if (!same(identity(checkedStat(markerPath)), currentMarker) || !same(identity(checkedStat(lockPath)), currentLock)) {
      throw new Error("POSIX state lock identity changed during directory sync");
    }
    return processScope ? { ...parsed, historyNamespaceIdentity } : parsed;
  } finally { fs.closeSync(marker.fd); }
}
function validate(lockDir, scope, lockedIdentity, openedLock, linuxDirs) {
  try {
    if (process.platform === "linux" && !linuxDirs) {
      return withLinuxDirectories(path.dirname(lockDir), dirs => validateCore(dirs.lockDir, scope, lockedIdentity, openedLock, dirs));
    }
    return validateCore(lockDir, scope, lockedIdentity, openedLock, linuxDirs);
  }
  catch (error) {
    if (error?.code === "ENOENT" || error?.message === "POSIX state lock marker is invalid") {
      throw new Error("POSIX state lock migration is incomplete or invalid; offline recovery is required: stop every runtime, preserve the state.lock directory under a unique backup name, then explicitly migrate again", { cause: error });
    }
    throw error;
  }
}
export function readPosixStateLockProtocol(lockDir, scope, lockedIdentity) { return validate(lockDir, scope, lockedIdentity); }

/** @param {{ offlineConfirmed?: boolean, expectedStateDir?: string }} options */
export function shutdownPosixStateLockSentinel(stateDir, options = {}) {
  if (process.platform !== "linux") throw new Error("Linux state sentinel shutdown is only available on Linux");
  if (options.offlineConfirmed !== true || typeof options.expectedStateDir !== "string"
      || !path.isAbsolute(options.expectedStateDir) || path.resolve(options.expectedStateDir) !== path.resolve(stateDir)) {
    throw new Error("Sentinel shutdown requires offline confirmation and the exact absolute state directory");
  }
  const scope = inspectPosixStateLockScope(stateDir);
  const lockDir = path.join(stateDir, "state.lock");
  return withPosixStateLock(stateDir, scope, () => {
    const marker = validate(lockDir, scope);
    const sentinel = marker.sentinel;
    let processFd;
    try {
      processFd = openLinuxSentinelProcess(sentinel);
      utility(process.execPath, [sentinelScript, "stop", sentinel.generation, sentinel.nonce], { timeout: 3000 });
      const deadline = performance.now() + 3000;
      while (!linuxSentinelExited(sentinel, processFd)) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error("sentinel did not exit");
        Atomics.wait(SLEEP, 0, 0, Math.min(10, remaining));
      }
    } catch (error) {
      throw new Error("Linux state sentinel shutdown could not be confirmed; offline recovery is required", { cause: error });
    } finally { if (processFd !== undefined) fs.closeSync(processFd); }
    return { stateDir, epoch: marker.epoch, stopped: true };
  }, { timeoutMs: 7500 });
}

function acquire(fd, stateDir, timeoutMs, run) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    let acquired = false;
    try {
      const executable = process.platform === "darwin" ? "/usr/bin/lockf" : "/usr/bin/flock";
      const args = process.platform === "darwin" ? ["-s", "-t", "0", "3"] : ["-x", "-n", "3"];
      utility(executable, args, { stdio: ["ignore", "pipe", "pipe", fd], timeout: remaining });
      acquired = true;
    } catch (error) {
      // exit 1 は非待機取得の競合。utility障害やcallback例外は再試行しない。
      const contentionStatus = process.platform === "darwin" ? 75 : 1;
      if (error?.status !== contentionStatus || error?.signal || error?.code) throw new Error(`POSIX state lock utility failed: ${stateDir}`, { cause: error });
    }
    if (acquired) {
      if (timeoutMs > 0 && performance.now() >= deadline) throw new Error("Timed out acquiring POSIX state lock");
      return run();
    }
    const remainingWait = deadline - performance.now();
    if (remainingWait <= 0) throw new Error(`Timed out acquiring POSIX state lock: ${stateDir}`);
    Atomics.wait(SLEEP, 0, 0, Math.min(10, remainingWait));
  }
}
function withPosixStateLockInternal(stateDir, scope, run, { timeoutMs }, root = null) {
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    if (timeoutMs === 0) return 0;
    const value = deadline - performance.now();
    if (value <= 0) throw new Error(`Timed out acquiring POSIX state lock: ${stateDir}`);
    return value;
  };
  const enter = linuxDirs => {
  if (linuxDirs && root && (!same(identity(fs.fstatSync(linuxDirs.stateFd, { bigint: true })), root.identity) || linuxDirs.mount !== root.mount)) {
    throw new Error("Linux state root descriptor identity or mount changed");
  }
  const lockDir = linuxDirs?.lockDir ?? path.join(stateDir, "state.lock");
  const parsed = validate(lockDir, scope, undefined, undefined, linuxDirs);
  const pinned = Object.freeze({ protocol: parsed.protocol, epoch: parsed.epoch,
    directoryIdentity: Object.freeze({ ...parsed.directoryIdentity }), barrierIdentity: Object.freeze({ ...parsed.barrierIdentity }),
    markerIdentity: Object.freeze({ ...parsed.markerIdentity }), lockIdentity: Object.freeze({ ...parsed.lockIdentity }),
    historyJournalIdentity: parsed.historyJournalIdentity ? Object.freeze({ ...parsed.historyJournalIdentity }) : null,
    historyNamespaceIdentity: parsed.historyNamespaceIdentity ? Object.freeze({ ...parsed.historyNamespaceIdentity }) : null });
  remaining();
  const lock = openChecked(path.join(lockDir, LOCK));
  try {
    if (linuxDirs) checkLinuxMount(lock.fd, linuxDirs.mount);
    if (!same(pinned.lockIdentity, identity(lock.stat))) throw new Error("POSIX state lock file was replaced");
    return acquire(lock.fd, stateDir, root ? root.remaining() : remaining(), () => {
      const checkLocked = () => {
        if (root) root.check();
        if (!same(identity(fs.fstatSync(lock.fd, { bigint: true })), identity(lock.stat))) throw new Error("POSIX locked descriptor identity changed");
        const current = validate(lockDir, scope, pinned.directoryIdentity, identity(lock.stat), linuxDirs);
        if (current.protocol !== pinned.protocol || current.epoch !== pinned.epoch ||
            !same(current.barrierIdentity, pinned.barrierIdentity) || !same(current.markerIdentity, pinned.markerIdentity) ||
            !same(current.lockIdentity, pinned.lockIdentity) ||
            (linuxDirs && (!same(current.historyJournalIdentity, pinned.historyJournalIdentity) ||
              !same(current.historyNamespaceIdentity, pinned.historyNamespaceIdentity)))) throw new Error("POSIX locked barrier or marker identity changed");
        return current;
      };
      checkLocked();
      return run(pinned.directoryIdentity, linuxDirs, pinned, checkLocked);
    });
  } finally { fs.closeSync(lock.fd); }
  };
  return process.platform === "linux" ? withLinuxDirectories(stateDir, enter) : enter();
}

export function withPosixStateLock(stateDir, scope, run, options) {
  return process.platform === "linux"
    ? withLinuxRootLock(stateDir, options.timeoutMs, root => withPosixStateLockInternal(stateDir, scope, run, options, root))
    : withPosixStateLockInternal(stateDir, scope, run, options);
}

function withLinuxMigrationRecoveryContext(stateDir, scope, lockIdentity, current, run, root = null) {
  const lockDir = path.join(stateDir, "state.lock");
  const dir = current.directoryIdentity;
  let active = true;
  const context = Object.freeze({
    stateDir,
    directoryIdentity: Object.freeze({ ...dir }),
    hostId: scope.hostId,
    volumeGuid: null,
    epoch: current.epoch,
    check() {
      if (!active) throw new Error("Linux state lock migration context is no longer active");
      if (root) { root.remaining(); root.check(); }
      const observed = validate(lockDir, scope, dir, lockIdentity);
      if (observed.epoch !== current.epoch || !same(observed.historyJournalIdentity, current.historyJournalIdentity) ||
          !same(observed.historyNamespaceIdentity, current.historyNamespaceIdentity)) throw new Error("Linux state lock epoch or history journal changed during migration");
    }
  });
  try {
    context.check();
    const result = run(context);
    if (result && typeof result.then === "function") throw new TypeError("Linux state lock migration callback must be synchronous");
    context.check();
    return result;
  } finally { active = false; }
}

/** @param {string} stateDir @param {{ expectedStateDir?: string, onDarwinMigrationStep?: (name: string) => any, darwinAuthorization?: object, prepareDarwinGeneration?: (generation: {stateDir: string, epoch: string, directoryIdentity: {dev: string, ino: string}}) => void, prepareLinuxGeneration?: (generation: {stateDir: string, epoch: string, directoryIdentity: {dev: string, ino: string}, rootFd: number, protocol: string, expectedDirectoryIdentity: {dev: string, ino: string}, expectedHistoryJournalIdentity: {dev: string, ino: string}, check: () => void}) => any }} options */
export function migratePosixStateLock(stateDir, { expectedStateDir, onDarwinMigrationStep, prepareDarwinGeneration, prepareLinuxGeneration, darwinAuthorization } = {}) {
  let darwinGuard = null;
  if (process.platform === "darwin") {
    darwinGuard = assertDarwinMigrationAuthorization(darwinAuthorization, stateDir, prepareDarwinGeneration);
    if (!darwinGuard) {
      try {
        fs.lstatSync(path.join(stateDir, ".darwin-legacy-migration"));
        throw new Error("Darwin migration evidence requires the dedicated offline recovery path; existing state was preserved");
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
  const step = name => {
    if (darwinGuard) assertDarwinMigrationAuthorization(darwinAuthorization, stateDir, prepareDarwinGeneration);
    if (process.platform !== "darwin" || !onDarwinMigrationStep) return;
    const result = onDarwinMigrationStep(name);
    if (result && typeof result.then === "function") {
      void Promise.resolve(result).catch(() => {});
      throw new TypeError("Darwin migration step must be synchronous");
    }
  };
  if (expectedStateDir !== undefined) {
    if (typeof expectedStateDir !== "string" || !path.isAbsolute(expectedStateDir)) throw new Error("Expected state directory must be an absolute path (--expected-state-dir)");
    if (path.resolve(expectedStateDir) !== path.resolve(stateDir)) throw new Error("Expected state directory does not match the effective state directory; no migration was performed");
  }
  inspectPosixStateLockScope(stateDir);
  const lockDir = path.join(stateDir, "state.lock");
  let existing;
  try { existing = fs.lstatSync(lockDir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new Error(`Existing legacy/symbolic state lock was left untouched; offline recovery is required: ${lockDir}`);
  }
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const migrate = root => {
  if (root) { root.remaining(); root.check(); }
  const dir = identity(checkedStat(stateDir, true));
  const scope = inspectPosixStateLockScope(stateDir);
  if (!same(scope.directoryIdentity, dir)) throw new Error("POSIX state directory identity changed during migration");
  // state directory の作成中に旧 writer が lock を作った場合も置換しない。
  existing = undefined;
  try { existing = fs.lstatSync(lockDir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`Existing legacy/symbolic state lock was left untouched; offline recovery is required: ${lockDir}`);
    return withPosixStateLockInternal(stateDir, scope, () => {
      const current = validate(lockDir, scope, dir);
      if (process.platform === "linux") {
        withLinuxMigrationRecoveryContext(stateDir, scope, current.lockIdentity, current, requireLinuxEpochRecovery, root);
      }
      return { ...current, stateDir };
    }, { timeoutMs: 7500 }, root);
  }
  if (darwinGuard) assertDarwinMigrationAuthorization(darwinAuthorization, stateDir, prepareDarwinGeneration);
  fs.mkdirSync(lockDir, { mode: 0o700 });
  step("barrier-created");
  const initialize = linuxDirs => {
  if (linuxDirs && root && (!same(identity(fs.fstatSync(linuxDirs.stateFd, { bigint: true })), root.identity) || linuxDirs.mount !== root.mount)) {
    throw new Error("Linux migration root descriptor identity or mount changed");
  }
  const activeStateDir = linuxDirs?.statePath ?? stateDir;
  const activeLockDir = linuxDirs?.lockDir ?? lockDir;
  syncDirectory(activeStateDir, dir);
  const lockPath = path.join(activeLockDir, LOCK);
  const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, 0o600);
  try {
    if (linuxDirs) checkLinuxMount(fd, linuxDirs.mount);
    const lockIdentity = identity(fs.fstatSync(fd, { bigint: true }));
    fs.fsyncSync(fd);
    syncDirectory(activeLockDir, identity(checkedStat(activeLockDir, true)));
    step("lock-file-synced");
    return acquire(fd, stateDir, root ? root.remaining() : 7500, () => {
      if (root) { root.remaining(); root.check(); }
      if (!same(dir, identity(checkedStat(activeStateDir, true))) || !same(lockIdentity, identity(checkedStat(lockPath)))) throw new Error("POSIX state lock changed during migration");
      const barrierIdentity = identity(checkedStat(activeLockDir, true));
      const preparedName = `prepared-${randomUUID()}.json`;
      const prepared = path.join(activeLockDir, preparedName);
      const markerFd = fs.openSync(prepared, "wx", 0o600);
      let payload;
      try {
        if (linuxDirs) checkLinuxMount(markerFd, linuxDirs.mount);
        payload = { protocol: process.platform === "linux" ? LINUX_PROTOCOL : DARWIN_PROTOCOL, localOnly: true, hostId: scope.hostId, fileSystem: scope.fileSystem, ...(process.platform === "linux" ? { bootId: scope.bootId, pidNamespace: scope.pidNamespace, timeNamespace: scope.timeNamespace, netNamespace: scope.netNamespace } : {}), directoryIdentity: dir, barrierIdentity, lockIdentity, markerIdentity: identity(fs.fstatSync(markerFd, { bigint: true })) };
        if (process.platform === "darwin") {
          payload = { ...payload, epoch: randomUUID() };
          if (typeof prepareDarwinGeneration !== "function") throw new Error("Darwin state generation preparation is required");
          prepareDarwinGeneration({ stateDir, epoch: payload.epoch, directoryIdentity: dir });
        }
        if (process.platform === "linux") {
          const epoch = randomUUID();
          if (typeof prepareLinuxGeneration !== "function") throw new Error("Linux state generation preparation is required");
          const historyJournalIdentity = initializeLinuxHistoryJournal(linuxDirs, epoch, dir);
          const namespacePath = `/proc/self/fd/${linuxDirs.stateFd}/worker-leases-v1`;
          try { fs.mkdirSync(namespacePath, { mode: 0o700 }); fs.fsyncSync(linuxDirs.stateFd); }
          catch (error) { if (error?.code !== "EEXIST") throw error; }
          const namespaceBefore = identity(checkedStat(namespacePath, true));
          if (namespaceBefore.dev !== dir.dev) throw new Error("Linux lease namespace crosses a filesystem boundary");
          const namespaceFd = fs.openSync(namespacePath, checkedOpenFlags(true));
          let leaseDirectoryIdentity;
          try {
            checkLinuxMount(namespaceFd, linuxDirs.mount);
            if (!same(namespaceBefore, identity(fs.fstatSync(namespaceFd, { bigint: true }))) ||
                !same(namespaceBefore, identity(checkedStat(namespacePath, true)))) throw new Error("Linux lease namespace changed during open");
            const epochPath = `/proc/self/fd/${namespaceFd}/${epoch}`;
            fs.mkdirSync(epochPath, { mode: 0o700 });
            fs.fsyncSync(namespaceFd);
            leaseDirectoryIdentity = identity(checkedStat(epochPath, true));
            const epochFd = fs.openSync(epochPath, checkedOpenFlags(true));
            try {
              checkLinuxMount(epochFd, linuxDirs.mount);
              if (leaseDirectoryIdentity.dev !== dir.dev || !same(leaseDirectoryIdentity, identity(fs.fstatSync(epochFd, { bigint: true })) )) {
                throw new Error("Linux lease epoch directory changed during open");
              }
              fs.fsyncSync(epochFd);
              let active = true;
              const check = () => {
                root.remaining(); root.check();
                if (!active || !same(dir, identity(fs.fstatSync(linuxDirs.stateFd, { bigint: true }))) ||
                    !same(dir, identity(checkedStat(stateDir, true))) || !same(barrierIdentity, identity(fs.fstatSync(linuxDirs.barrierFd, { bigint: true }))) ||
                    !same(barrierIdentity, identity(checkedStat(activeLockDir, true))) || !same(lockIdentity, identity(fs.fstatSync(fd, { bigint: true }))) ||
                    !same(lockIdentity, identity(checkedStat(lockPath))) ||
                    !same(namespaceBefore, identity(fs.fstatSync(namespaceFd, { bigint: true }))) ||
                    !same(namespaceBefore, identity(checkedStat(namespacePath, true))) ||
                    !same(leaseDirectoryIdentity, identity(fs.fstatSync(epochFd, { bigint: true }))) ||
                    !same(leaseDirectoryIdentity, identity(checkedStat(epochPath, true)))) throw new Error("Linux state changed during generation preparation");
                checkLinuxMount(linuxDirs.stateFd, linuxDirs.mount); checkLinuxMount(linuxDirs.barrierFd, linuxDirs.mount);
                checkLinuxMount(fd, linuxDirs.mount); checkLinuxMount(namespaceFd, linuxDirs.mount); checkLinuxMount(epochFd, linuxDirs.mount);
                verifyLinuxHistoryJournal(linuxDirs, epoch, historyJournalIdentity);
              };
              try {
                check();
                const prepared = prepareLinuxGeneration({ stateDir, directoryIdentity: dir, rootFd: linuxDirs.stateFd,
                  protocol: LINUX_PROTOCOL, epoch, expectedDirectoryIdentity: leaseDirectoryIdentity, expectedHistoryJournalIdentity: historyJournalIdentity, check });
                if (prepared && typeof prepared.then === "function") {
                  void Promise.resolve(prepared).catch(() => {});
                  throw new TypeError("Linux generation preparation must be synchronous");
                }
                check();
              } finally { active = false; }
            } finally { fs.closeSync(epochFd); }
          } finally { fs.closeSync(namespaceFd); }
          payload = { ...payload, epoch, leaseDirectoryIdentity, historyJournalIdentity, sentinel: { generation: epoch, nonce: randomBytes(16).toString("hex"), barrierFd: 3 } };
          const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
          try {
            root.remaining(); root.check();
            utility(process.execPath, [sentinelScript, "bootstrap", stateDir, lockDir, path.join(lockDir, preparedName), encoded,
              "--history-root-lock-fd=7", `--history-deadline-ns=${root.deadline}`],
            { stdio: ["ignore", "pipe", "pipe", fd, markerFd, linuxDirs.barrierFd, linuxDirs.stateFd, root.lockFd], timeout: Math.max(1, Math.ceil(root.remaining())) });
          } catch (error) {
            const diagnostic = typeof error?.stderr === "string" ? error.stderr : "";
            const failure = /^GROK_SENTINEL_FSYNC:(marker|ready|directory):([A-Z][A-Z0-9_]{0,15}|UNKNOWN)\r?\n$/.exec(diagnostic);
            if (failure) {
              throw new Error(`Linux state sentinel ${failure[1]} fsync failed (${failure[2]}); offline recovery is required`, { cause: error });
            }
            throw new Error("Linux state sentinel initialization failed; offline recovery is required", { cause: error });
          }
        } else {
          fs.writeFileSync(markerFd, `${JSON.stringify(payload)}\n`, "utf8");
          fs.fsyncSync(markerFd);
        }
      } finally { fs.closeSync(markerFd); }
      step("marker-prepared");
      if (process.platform !== "linux") {
        fs.linkSync(prepared, path.join(activeLockDir, MARKER));
        step("marker-published");
        syncDirectory(activeLockDir, barrierIdentity);
      }
      const current = validate(activeLockDir, scope, dir, lockIdentity, linuxDirs);
      if (process.platform === "linux") {
        // 初回 marker の作成者だけが、同じ native mutex 内で初期 guard を確定する。
        // 既存 marker や途中で失敗した marker は自動的に初期化しない。
        withLinuxMigrationRecoveryContext(stateDir, scope, lockIdentity, current, initializeLinuxEpochRecovery, root);
      }
      return { ...current, stateDir };
    });
  } finally { fs.closeSync(fd); }
  };
  return process.platform === "linux" ? withLinuxDirectories(stateDir, initialize) : initialize();
  };
  return process.platform === "linux" ? withLinuxRootLock(stateDir, 7500, migrate) : migrate(null);
}
