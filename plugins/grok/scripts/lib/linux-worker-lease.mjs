import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";
import { fdMountId } from "./linux-epoch-recovery.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const PROTOCOL = "posix-linux-worker-lease-v6";
const NAMESPACE = "worker-leases-v1";
const LOCK_TIMEOUT_MS = 2000;
const LOCK_CONTENTION_STATUS = 200;
const owners = new WeakMap();
export const LINUX_LEASE_SLOT_COUNT = 256;

function validIdentity(value) {
  return Boolean(value && typeof value.dev === "string" && DECIMAL.test(value.dev)
    && typeof value.ino === "string" && DECIMAL.test(value.ino));
}
function same(a, b) { return Boolean(a && b && a.dev === b.dev && a.ino === b.ino); }
function validSlot(slot) { return Number.isInteger(slot) && slot >= 0 && slot < LINUX_LEASE_SLOT_COUNT; }
function slotName(slot) { return `slot-${String(slot).padStart(3, "0")}.lease`; }
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function checked(stat, directory) {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())
      || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n
      || (!directory && ((stat.mode & 0o400n) === 0n || stat.nlink !== 1n))
      || stat.dev <= 0n || stat.ino <= 0n) {
    throw new Error("Linux worker lease ownership, permissions or identity is invalid");
  }
  return identity(stat);
}
function flags(directory = false) {
  const { O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;
  if (process.platform !== "linux" || typeof process.getuid !== "function"
      || !Number.isInteger(O_NOFOLLOW) || O_NOFOLLOW <= 0
      || !Number.isInteger(O_NONBLOCK) || O_NONBLOCK <= 0
      || !Number.isInteger(O_DIRECTORY) || O_DIRECTORY <= 0) {
    throw new Error("Linux worker lease requires no-follow, nonblocking and directory opens");
  }
  return O_NOFOLLOW | O_NONBLOCK | (directory ? O_DIRECTORY : 0);
}
function at(fd, name) { return `/proc/self/fd/${fd}/${name}`; }
function mount(fd, expected) {
  if (fdMountId(fd) !== expected) throw new Error("Linux worker lease crosses a mount boundary");
}
function validateContext(context) {
  if (!context || context.protocol !== PROTOCOL || typeof context.check !== "function"
      || typeof context.stateDir !== "string" || !path.isAbsolute(context.stateDir)
      || path.resolve(context.stateDir) !== context.stateDir || !UUID.test(context.epoch ?? "")
      || !Number.isSafeInteger(context.rootFd) || context.rootFd < 0
      || !validIdentity(context.directoryIdentity) || !validIdentity(context.expectedDirectoryIdentity)) {
    throw new Error("Linux worker lease state context is invalid");
  }
}
function validateLease(lease, context) {
  const directory = path.join(context.stateDir, NAMESPACE, context.epoch);
  if (!lease || typeof lease.id !== "string" || !UUID.test(lease.id)
      || lease.stateGeneration !== context.epoch || !validSlot(lease.slot)
      || !validIdentity(lease) || lease.path !== path.join(directory, slotName(lease.slot))) {
    throw new Error("Linux worker lease record is invalid");
  }
}
function checkRoot(context, root, rootMount) {
  const result = context.check();
  if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
    void Promise.resolve(result).catch(() => {});
    throw new TypeError("Linux worker lease state check must be synchronous");
  }
  if (!same(checked(fs.fstatSync(context.rootFd, { bigint: true }), true), root)
      || !same(checked(fs.lstatSync(context.stateDir, { bigint: true }), true), root)) {
    throw new Error("Linux worker lease state root changed");
  }
  mount(context.rootFd, rootMount);
}
function openDirectory(parent, name, parentIdentity, rootMount) {
  const file = at(parent, name);
  const before = checked(fs.lstatSync(file, { bigint: true }), true);
  if (before.dev !== parentIdentity.dev) throw new Error("Linux worker lease directory crosses a filesystem boundary");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | flags(true));
  try {
    mount(fd, rootMount);
    if (!same(checked(fs.fstatSync(fd, { bigint: true }), true), before)
        || !same(checked(fs.lstatSync(file, { bigint: true }), true), before)) {
      throw new Error("Linux worker lease directory changed during open");
    }
    return { fd, name: file, identity: before };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function verifyDirectory(directory, rootMount) {
  mount(directory.fd, rootMount);
  if (!same(checked(fs.fstatSync(directory.fd, { bigint: true }), true), directory.identity)
      || !same(checked(fs.lstatSync(directory.name, { bigint: true }), true), directory.identity)) {
    throw new Error("Linux worker lease directory changed");
  }
}
// context は同じ state mutex 内でのみ有効。check() は protocol、epoch、
// sentinel と root の検証を含み、rootFd はその mutex の間 pin される。
// 呼出側は reserved slot の耐久性と、両 record・claim の照合を保証する。
function withDirectory(context, run) {
  flags(true);
  validateContext(context);
  const root = checked(fs.fstatSync(context.rootFd, { bigint: true }), true);
  if (!same(root, context.directoryIdentity)) throw new Error("Linux worker lease state root differs");
  const rootMount = fdMountId(context.rootFd);
  checkRoot(context, root, rootMount);
  const namespace = openDirectory(context.rootFd, NAMESPACE, root, rootMount);
  try {
    const directory = openDirectory(namespace.fd, context.epoch, namespace.identity, rootMount);
    try {
      if (!same(directory.identity, context.expectedDirectoryIdentity)) throw new Error("Linux worker lease epoch directory differs");
      const check = () => {
        checkRoot(context, root, rootMount);
        verifyDirectory(namespace, rootMount);
        verifyDirectory(directory, rootMount);
      };
      check();
      return run(directory, rootMount, check);
    } finally { fs.closeSync(directory.fd); }
  } finally { fs.closeSync(namespace.fd); }
}
function checkFile(fd, lease, directory, rootMount, check) {
  check();
  const file = at(directory.fd, slotName(lease.slot));
  const named = checked(fs.lstatSync(file, { bigint: true }), false);
  const stat = fs.fstatSync(fd, { bigint: true });
  const opened = checked(stat, false);
  mount(fd, rootMount);
  if (!same(named, opened) || !same(opened, lease) || opened.dev !== directory.identity.dev || stat.size !== 36n) {
    throw new Error("Linux worker lease file identity changed");
  }
  const bytes = Buffer.alloc(36);
  if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || bytes.toString("utf8") !== lease.id
      || !same(checked(fs.lstatSync(file, { bigint: true }), false), opened)) {
    throw new Error("Linux worker lease contents or name changed");
  }
  check();
}
function lockResult(fd, timeoutMs = LOCK_TIMEOUT_MS) {
  const result = spawnSync("/usr/bin/flock", ["-x", "-n", "-E", String(LOCK_CONTENTION_STATUS), "3"], {
    stdio: ["ignore", "pipe", "pipe", fd], timeout: Math.min(LOCK_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs))),
    killSignal: "SIGKILL", maxBuffer: 65536
  });
  const failure = /** @type {NodeJS.ErrnoException | undefined} */ (result.error);
  const code = typeof failure?.code === "string" && /^[A-Z][A-Z0-9_]{0,15}$/.test(failure.code) ? failure.code : null;
  const signal = typeof result.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(result.signal) ? result.signal : null;
  const status = Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : null;
  const state = result.error || result.signal !== null ? "unknown" : status === 0 ? "acquired" : status === LOCK_CONTENTION_STATUS ? "contended" : "unknown";
  return { state, code, signal, status };
}
function lockError(message, result) {
  return new Error(`${message} (code=${result.code ?? "none"}, signal=${result.signal ?? "none"}, status=${result.status ?? "none"})`);
}
function tryLock(fd, timeoutMs = LOCK_TIMEOUT_MS) { return lockResult(fd, timeoutMs).state === "acquired"; }

// worker は opaque owner を lifecycle 終了まで強参照する。FD は公開せず、
// flock helper 以外の子へ渡さない。close/unlock を行わない協調 runtime を前提とする。
export function acquireLinuxWorkerLease({ context, slot, claimToken }) {
  if (!validSlot(slot) || typeof claimToken !== "string" || !UUID.test(claimToken)) throw new Error("Linux worker lease slot or claim is invalid");
  return withDirectory(context, (directory, rootMount, check) => {
    const id = randomUUID();
    const file = at(directory.fd, slotName(slot));
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | flags(), 0o600);
    try {
      fs.writeFileSync(fd, id, "utf8");
      const lease = Object.freeze({ id, path: path.join(context.stateDir, NAMESPACE, context.epoch, slotName(slot)),
        ...checked(fs.fstatSync(fd, { bigint: true }), false), stateGeneration: context.epoch, slot });
      checkFile(fd, lease, directory, rootMount, check);
      const locked = lockResult(fd);
      if (locked.state !== "acquired") throw lockError("Linux worker lease lock is unavailable", locked);
      checkFile(fd, lease, directory, rootMount, check);
      const readFd = fs.openSync(file, fs.constants.O_RDONLY | flags());
      try { checkFile(readFd, lease, directory, rootMount, check); }
      finally { fs.closeSync(readFd); }
      fs.fsyncSync(fd);
      fs.fsyncSync(directory.fd);
      checkFile(fd, lease, directory, rootMount, check);
      const owner = Object.freeze({});
      owners.set(owner, { fd, lease: Object.freeze({ ...lease }), epoch: context.epoch, claimToken, active: true });
      return { lease, owner };
    } catch (error) {
      fs.closeSync(fd);
      // 不確かな slot は消さない。回収は同じ state mutex 内で行う。
      throw error;
    }
  });
}

// 独立 FD の競合と owner FD の再取得を確認する。FD の不正な close や
// unlock を同一 process 内で行わない協調 runtime の範囲でのみ有効。
export function validateOwnedLinuxWorkerLease({ owner, lease, context, claimToken }) {
  const held = owner && (typeof owner === "object" || typeof owner === "function") ? owners.get(owner) : undefined;
  if (!held?.active || !lease || !context || held.epoch !== context.epoch || held.claimToken !== claimToken
      || ["id", "path", "dev", "ino", "stateGeneration", "slot"].some(key => lease[key] !== held.lease[key])) {
    throw new Error("Linux worker lease owner is invalid");
  }
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  try {
  return withDirectory(context, (directory, rootMount, check) => {
    validateLease(lease, context);
    checkFile(held.fd, lease, directory, rootMount, check);
    const observer = fs.openSync(at(directory.fd, slotName(lease.slot)), fs.constants.O_RDONLY | flags());
    try {
      checkFile(observer, lease, directory, rootMount, check);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("Linux worker lease owner probe deadline expired");
      const result = lockResult(observer, remaining);
      if (result.state === "acquired") {
        // すでに失われた FD 番号を close すると、別用途に再利用された FD を閉じ得る。
        held.active = false;
        owners.delete(owner);
        throw new Error("Linux worker lease owner lock was lost");
      }
      if (result.state !== "contended") throw lockError("Linux worker lease owner lock is unavailable", result);
      const afterProbe = deadline - performance.now();
      if (afterProbe <= 0) throw new Error("Linux worker lease owner probe deadline expired");
      const ownerLock = lockResult(held.fd, afterProbe);
      if (ownerLock.state !== "acquired") throw lockError("Linux worker lease owner lock is unavailable", ownerLock);
      checkFile(held.fd, lease, directory, rootMount, check);
      if (performance.now() >= deadline) throw new Error("Linux worker lease owner probe deadline expired");
    } finally { fs.closeSync(observer); }
    return true;
  });
  } catch (error) {
    // FD の再利用や検査不能を区別できないため、以後この番号を close しない。
    // 実際の FD が残っている場合は worker 自身の終了時に OS が回収する。
    held.active = false;
    owners.delete(owner);
    throw error;
  }
}

// 先に失効させるため、close が失敗しても同じ FD 番号へ再度 close しない。
export function releaseLinuxWorkerLease(owner) {
  const held = owner && (typeof owner === "object" || typeof owner === "function") ? owners.get(owner) : undefined;
  if (!held?.active) return false;
  held.active = false;
  owners.delete(owner);
  fs.closeSync(held.fd);
  return true;
}

// observer は state mutex 内で非待機取得し、FD を保持した同期 callback 内で
// context.check()・両 record・epoch・claim を再照合してから確定する。
export function withAvailableLinuxLease(lease, context, callback) {
  if (typeof callback !== "function" || types.isAsyncFunction(callback)) {
    throw new TypeError("Linux worker lease callback must be synchronous");
  }
  const timeoutMs = context?.timeoutMs ?? LOCK_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return { status: "unknown" };
  const deadline = performance.now() + timeoutMs;
  let observed;
  let callbackEntered = false;
  try {
    observed = withDirectory(context, (directory, rootMount, check) => {
      validateLease(lease, context);
      const fd = fs.openSync(at(directory.fd, slotName(lease.slot)), fs.constants.O_RDONLY | flags());
      try {
        checkFile(fd, lease, directory, rootMount, check);
        const remaining = deadline - performance.now();
        if (remaining <= 0 || !tryLock(fd, remaining)) throw new Error("Linux worker lease lock is unavailable");
        checkFile(fd, lease, directory, rootMount, check);
        if (performance.now() >= deadline) throw new Error("Linux worker lease probe deadline expired");
        callbackEntered = true;
        const value = callback();
        if (value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function") {
          void Promise.resolve(value).catch(() => {});
          throw new TypeError("Linux worker lease callback returned a thenable; it must be synchronous");
        }
        return { status: "available", value };
      } finally { fs.closeSync(fd); }
    });
  } catch (error) {
    // callback の例外を成功や競合に変換しない。
    if (callbackEntered) throw error;
    return { status: "unknown" };
  }
  return observed;
}
