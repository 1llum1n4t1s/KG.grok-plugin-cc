import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const LOCK_TIMEOUT_MS = 2000;
export const DARWIN_LEASE_SLOT_COUNT = 256;

function validSlot(slot) {
  return Number.isInteger(slot) && slot >= 0 && slot < DARWIN_LEASE_SLOT_COUNT;
}

function slotName(slot) {
  return `slot-${String(slot).padStart(3, "0")}.lease`;
}

function validIdentity(value) {
  return value && typeof value.dev === "string" && POSITIVE_DECIMAL.test(value.dev)
    && typeof value.ino === "string" && POSITIVE_DECIMAL.test(value.ino);
}

function flags() {
  const { O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (process.platform !== "darwin" || typeof process.getuid !== "function"
      || !Number.isInteger(O_NOFOLLOW) || O_NOFOLLOW <= 0
      || !Number.isInteger(O_NONBLOCK) || O_NONBLOCK <= 0) {
    throw new Error("Darwin worker lease requires no-follow and nonblocking opens");
  }
  return O_NOFOLLOW | O_NONBLOCK;
}

function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function checkedStat(stat, directory) {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())
      || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n
      || (!directory && (stat.mode & 0o400n) === 0n)
      || stat.dev <= 0n || stat.ino <= 0n || (!directory && stat.nlink !== 1n)) {
    throw new Error("Darwin worker lease ownership, permissions or identity is invalid");
  }
  return identity(stat);
}

function directoryIdentity(directory) {
  return checkedStat(fs.lstatSync(directory, { bigint: true }), true);
}

function checkFile(fd, lease, directory, expectedDirectory) {
  const before = directoryIdentity(directory);
  if (!same(before, expectedDirectory)) throw new Error("Darwin worker lease directory changed");
  const named = checkedStat(fs.lstatSync(lease.path, { bigint: true }), false);
  const stat = fs.fstatSync(fd, { bigint: true });
  const opened = checkedStat(stat, false);
  if (!same(named, opened) || !same(opened, lease) || opened.dev !== before.dev || stat.size !== 36n) {
    throw new Error("Darwin worker lease file identity changed");
  }
  const bytes = Buffer.alloc(36);
  if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || bytes.toString("utf8") !== lease.id
      || !same(checkedStat(fs.lstatSync(lease.path, { bigint: true }), false), opened)
      || !same(directoryIdentity(directory), before)) {
    throw new Error("Darwin worker lease contents or name changed");
  }
}

function validateLease(lease, context) {
  if (!lease || !context || typeof lease.id !== "string" || !UUID.test(lease.id)
      || typeof lease.stateGeneration !== "string" || !UUID.test(lease.stateGeneration)
      || lease.stateGeneration !== context.stateGeneration
      || !validSlot(lease.slot)
      || typeof lease.path !== "string" || !path.isAbsolute(lease.path)
      || path.resolve(lease.path) !== lease.path || path.basename(lease.path) !== slotName(lease.slot)
      || typeof context.expectedDirectory !== "string" || !path.isAbsolute(context.expectedDirectory)
      || path.resolve(context.expectedDirectory) !== context.expectedDirectory
      || path.dirname(lease.path) !== context.expectedDirectory
      || !validIdentity(context.expectedDirectoryIdentity) || !validIdentity(lease)) {
    throw new Error("Darwin worker lease record is invalid");
  }
}

function tryLock(fd, timeoutMs = LOCK_TIMEOUT_MS) {
  const result = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], {
    stdio: ["ignore", "pipe", "pipe", fd], timeout: Math.min(LOCK_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs))), killSignal: "SIGKILL", maxBuffer: 65536
  });
  return !result.error && result.signal === null && result.status === 0;
}

// 呼出側は state mutex と durable な reserved slot、検証済み filesystem・epoch を保証する。
// worker は取得した FD を自分の終了まで保持し、子プロセスへ渡さない。
export function acquireDarwinWorkerLease({ directory, stateGeneration, slot, expectedDirectoryIdentity }) {
  const openFlags = flags();
  if (typeof directory !== "string" || !path.isAbsolute(directory) || path.resolve(directory) !== directory
      || typeof stateGeneration !== "string" || !UUID.test(stateGeneration)
      || !validSlot(slot) || !validIdentity(expectedDirectoryIdentity)) {
    throw new Error("Darwin worker lease directory or generation is invalid");
  }
  const dir = directoryIdentity(directory);
  if (!same(dir, expectedDirectoryIdentity)) throw new Error("Darwin worker lease directory identity changed");
  const id = randomUUID();
  const file = path.join(directory, slotName(slot));
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | openFlags, 0o600);
  try {
    fs.writeFileSync(fd, id, "utf8");
    const stat = fs.fstatSync(fd, { bigint: true });
    const lease = { id, path: file, ...checkedStat(stat, false), stateGeneration, slot };
    checkFile(fd, lease, directory, dir);
    if (!tryLock(fd)) throw new Error("Darwin worker lease lock is unavailable");
    checkFile(fd, lease, directory, dir);
    // mode だけでは ACL 等による拒否を検出できないため、独立 FD の読取も確認する。
    const readFd = fs.openSync(file, fs.constants.O_RDONLY | openFlags);
    try { checkFile(readFd, lease, directory, dir); }
    finally { fs.closeSync(readFd); }
    fs.fsyncSync(fd);
    const dirFd = fs.openSync(directory, fs.constants.O_RDONLY | openFlags | (fs.constants.O_DIRECTORY ?? 0));
    try {
      const openedDir = checkedStat(fs.fstatSync(dirFd, { bigint: true }), true);
      if (!same(openedDir, dir) || !same(directoryIdentity(directory), dir)) {
        throw new Error("Darwin worker lease directory changed before sync");
      }
      fs.fsyncSync(dirFd);
      if (!same(directoryIdentity(directory), dir)) throw new Error("Darwin worker lease directory changed after sync");
    } finally { fs.closeSync(dirFd); }
    checkFile(fd, lease, directory, dir);
    return { lease, fd };
  } catch (error) {
    fs.closeSync(fd);
    // 不確かな名前は削除しない。回収は別の state mutex 管理下で行う。
    throw error;
  }
}

// 同じ worker が acquire で得た FD を渡す。lock 自体の保持はここでは検出できない。
// 呼出側が state mutex 内で marker・両 record・claim token を検証する。
export function validateOwnedDarwinWorkerLease({ fd, lease, expectedDirectory, expectedDirectoryIdentity, stateGeneration }) {
  flags();
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("Darwin worker lease FD is invalid");
  const context = { expectedDirectory, expectedDirectoryIdentity, stateGeneration };
  validateLease(lease, context);
  const dir = directoryIdentity(expectedDirectory);
  if (!same(dir, expectedDirectoryIdentity)) throw new Error("Darwin worker lease directory identity changed");
  checkFile(fd, lease, expectedDirectory, dir);
  return true;
}

// 呼出側は state mutex を保持し、検証済み directory の path と dev/ino を渡す。
// callback 内では marker epoch、両 record、名前と inode を再照合する。
// worker は lease -> mutex、ここは mutex ->
// 非待機 lease の順なので、ロックの取得を互いに待ち続けない。
export function withAvailableDarwinLease(lease, context, callback) {
  if (typeof callback !== "function" || types.isAsyncFunction(callback)) {
    throw new TypeError("Darwin worker lease callback must be synchronous");
  }
  const timeoutMs = context?.timeoutMs ?? LOCK_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return { status: "unknown" };
  const deadline = performance.now() + timeoutMs;
  let fd;
  try {
    const openFlags = flags();
    validateLease(lease, context);
    const directory = path.dirname(lease.path);
    const dir = directoryIdentity(directory);
    if (!same(dir, context.expectedDirectoryIdentity)) return { status: "unknown" };
    const before = checkedStat(fs.lstatSync(lease.path, { bigint: true }), false);
    if (!same(before, lease)) return { status: "unknown" };
    fd = fs.openSync(lease.path, fs.constants.O_RDONLY | openFlags);
    checkFile(fd, lease, directory, dir);
    const remaining = deadline - performance.now();
    if (remaining <= 0 || !tryLock(fd, remaining)) throw new Error("Darwin worker lease lock is unavailable");
    checkFile(fd, lease, directory, dir);
    if (performance.now() >= deadline) throw new Error("Darwin worker lease probe deadline expired");
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    return { status: "unknown" };
  }
  try {
    const value = callback();
    // thenable の生成時に起きた副作用は取り消せないため、呼出側は
    // 同期 callback のみを渡す責任を持つ。結果の非同期処理は許可しない。
    if (value !== null && (typeof value === "object" || typeof value === "function")
        && typeof value.then === "function") {
      throw new TypeError("Darwin worker lease callback returned a thenable; it must be synchronous");
    }
    return { status: "available", value };
  } finally {
    fs.closeSync(fd);
  }
}
