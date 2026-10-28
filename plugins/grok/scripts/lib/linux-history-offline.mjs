import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { types } from "node:util";
import { fdMountId } from "./linux-epoch-recovery.mjs";

const ACTIVE_ROOT_LOCKS = new WeakSet();
const ACTIVE_IDENTITIES = new Set();
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const same = (a, b) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino);

function checkedDirectory(stat) {
  if (typeof process.getuid !== "function" || stat.isSymbolicLink() || !stat.isDirectory() ||
      stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== 0o700n || stat.dev <= 0n || stat.ino <= 0n) {
    throw new Error("Linux offline history root identity or permissions are invalid");
  }
  return identity(stat);
}

// 固定の信頼済み内部処理だけが使用する未接続 primitive。任意 callback に
// capability を公開しない。同じ process の敵対的 JS を sandbox 化するものではない。
// この排他を知らない旧 runtime の停止・再起動禁止は明示的な外部前提である。
function withLinuxHistoryOfflineRootLock(stateDir, options, run) {
  const started = performance.now();
  if (process.platform !== "linux" || typeof stateDir !== "string" || !path.isAbsolute(stateDir) || path.resolve(stateDir) !== stateDir ||
      !options || options.offlineConfirmed !== true || options.localOnly !== true || options.allOldProcessesStopped !== true ||
      options.expectedStateDir !== stateDir || typeof run !== "function" || types.isAsyncFunction(run)) {
    throw new Error("Linux offline history root lock requires an exact directory and all offline confirmations");
  }
  const timeoutMs = options.timeoutMs ?? 7500;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError("Linux offline history lock timeout is invalid");
  const deadline = started + timeoutMs;
  const checkDeadline = () => {
    if (timeoutMs > 0 && performance.now() >= deadline) throw new Error("Timed out acquiring Linux offline history root lock");
  };
  checkDeadline();
  if (fs.realpathSync.native(stateDir) !== stateDir) throw new Error("Linux offline history root must be its canonical path");
  checkDeadline();
  const before = checkedDirectory(fs.lstatSync(stateDir, { bigint: true }));
  checkDeadline();
  const key = `${before.dev}:${before.ino}`;
  if (ACTIVE_IDENTITIES.has(key)) throw new Error("Linux offline history root lock cannot be reentered");
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  // flock 用の open-file-description は callback へ公開しない。
  const lockFd = fs.openSync(stateDir, flags);
  try {
    checkDeadline();
    const fd = fs.openSync(stateDir, flags);
    try {
    checkDeadline();
    const mount = fdMountId(lockFd);
    const checkRoot = () => {
      if (!same(before, checkedDirectory(fs.fstatSync(lockFd, { bigint: true }))) ||
          !same(before, checkedDirectory(fs.fstatSync(fd, { bigint: true }))) ||
          !same(before, checkedDirectory(fs.lstatSync(stateDir, { bigint: true }))) ||
          fdMountId(lockFd) !== mount || fdMountId(fd) !== mount) {
        throw new Error("Linux offline history root changed or crossed a mount boundary");
      }
      // 同 inode の bind mount で名前付き path だけが変わる場合も検出する。
      const namedFd = fs.openSync(stateDir, flags);
      try {
        if (!same(before, checkedDirectory(fs.fstatSync(namedFd, { bigint: true }))) || fdMountId(namedFd) !== mount ||
            !same(before, checkedDirectory(fs.lstatSync(stateDir, { bigint: true })))) {
          throw new Error("Linux offline history named root changed or crossed a mount boundary");
        }
      } finally { fs.closeSync(namedFd); }
    };
    checkRoot();
    checkDeadline();
    for (;;) {
      // timeout=0 は非待機を一度試す。utility 自体の停止予算は 5 秒に制限する。
      checkDeadline();
      try {
        execFileSync("/usr/bin/flock", ["-x", "-n", "3"], { stdio: ["ignore", "pipe", "pipe", lockFd],
          timeout: timeoutMs === 0 ? 5000 : Math.min(5000, Math.max(1, Math.ceil(deadline - performance.now()))) });
        break;
      } catch (error) {
        if (error?.status !== 1 || error?.signal || error?.code) throw new Error("Linux offline history lock utility failed", { cause: error });
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new Error("Timed out acquiring Linux offline history root lock");
        Atomics.wait(SLEEP, 0, 0, Math.min(10, remaining));
      }
    }
    if (timeoutMs > 0 && performance.now() >= deadline) throw new Error("Timed out acquiring Linux offline history root lock");
    let active = true;
    const capability = Object.freeze({ stateDir, rootFd: fd, directoryIdentity: Object.freeze({ ...before }), mount,
      check() {
        if (!active || !ACTIVE_ROOT_LOCKS.has(capability)) throw new Error("Linux offline history root capability is no longer active");
        checkRoot();
      } });
    ACTIVE_IDENTITIES.add(key); ACTIVE_ROOT_LOCKS.add(capability);
    try {
      assertLinuxHistoryOfflineRootCapability(capability);
      const result = run(capability);
      if (result && typeof result.then === "function") {
        void Promise.resolve(result).catch(() => {});
        throw new TypeError("Linux offline history root lock callback must be synchronous");
      }
      assertLinuxHistoryOfflineRootCapability(capability);
      return result;
    } finally { active = false; ACTIVE_ROOT_LOCKS.delete(capability); ACTIVE_IDENTITIES.delete(key); }
    } finally { fs.closeSync(fd); }
  } finally { fs.closeSync(lockFd); }
}

function assertLinuxHistoryOfflineRootCapability(capability) {
  if (!capability || !ACTIVE_ROOT_LOCKS.has(capability)) throw new Error("Linux offline history root lock capability is unavailable");
  capability.check();
}

// 固定入口と接続するまでは参照だけを保持し、副作用のある呼出しを公開しない。
void withLinuxHistoryOfflineRootLock;

// 旧 boot の history replay には旧 marker と ledger の真正な offline capability も
// 必要。これらが統合されるまでは、全呼出しを副作用なしで拒否する。
export function recoverOfflineLinuxHistory(_context) {
  throw new Error("Linux offline history recovery is disabled pending a verified root lock and offline capability");
}
