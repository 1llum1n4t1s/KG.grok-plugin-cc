import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { processCommandContains } from "./process.mjs";
import { resolveStateDir, stateFallbackTempDir, withStateLockMigrationScope, withStateSnapshot } from "./state.mjs";
import { reserveDirectStart, requireNoDirectStart, requireNoLegacyAdmission } from "./direct-start-admission.mjs";

export const PID_FILE_ENV = "GROK_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "GROK_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_LOCK_FILE = "broker.lock";
// 旧版の無条件 teardown が読む broker.json / broker.lock と共有しない。
const BROKER_STATE_NAMESPACE = "broker-v2";
const LINUX_BROKER_STATE_NAMESPACE = "broker-v3";
const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function brokerStateDir(stateDir, epoch) {
  if (process.platform !== "linux") return path.join(stateDir, BROKER_STATE_NAMESPACE);
  if (!EPOCH.test(epoch ?? "")) throw new Error("Broker state epoch is unavailable");
  return path.join(stateDir, LINUX_BROKER_STATE_NAMESPACE, epoch);
}
function checkBrokerDirectories(stateDir, epoch) {
  if (process.platform !== "linux") return;
  for (const dir of [path.join(stateDir, LINUX_BROKER_STATE_NAMESPACE), brokerStateDir(stateDir, epoch)]) {
    let stat;
    try { stat = fs.lstatSync(dir); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw brokerAdmissionError("broker state directory is invalid or a symlink.");
  }
}
const BROKER_SHUTDOWN_TIMEOUT_MS = 2000;
const BROKER_IDLE_SHUTDOWN_ACK_TIMEOUT_MS = 750;
const FAILED_BROKER_STOP_TIMEOUT_MS = 1250;
const BROKER_START_TOTAL_TIMEOUT_MS = 4500;
const BROKER_READY_TIMEOUT_MS = 2000;
const BROKER_START_FINALIZE_RESERVE_MS = 750;
const BROKER_ADMISSION_FILE = "broker-admission.jsonl";
const BROKER_ADMISSION_VERSION = 2;
const MAX_BROKER_ADMISSION_BYTES = 4 * 1024 * 1024;
const MAX_BROKER_ADMISSION_RECORD_BYTES = 64 * 1024;
const POSIX_NONBLOCK = process.platform === "win32" ? 0 : (fs.constants.O_NONBLOCK ?? 0);
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function readBoundedBrokerFile(file, maximum = 65536) {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)) throw brokerAdmissionError("file is invalid.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | POSIX_NONBLOCK);
  try {
    const expected = stateIdentity(before), opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameStateIdentity(opened, expected, true) || opened.size !== before.size) throw brokerAdmissionError("file identity changed.");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
    const after = fs.fstatSync(fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    if (offset !== Number(before.size) || !after.isFile() || !current.isFile() || current.isSymbolicLink() ||
        !sameStateIdentity(after, expected, true) || !sameStateIdentity(current, expected, true) ||
        after.size !== before.size || current.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs) throw brokerAdmissionError("file changed while reading.");
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}

// 同期callback中だけ存在する。async contextへ継承せず、公開writerは必ず新scopeを作る。
let brokerScope = null;
function assertBrokerDeadline(deadline) {
  if (performance.now() >= deadline) throw new Error("Timed out within the Grok broker operation budget");
}
function brokerRemaining(deadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("Timed out within the Grok broker operation budget");
  return deadline === Infinity ? undefined : remaining;
}
function withBrokerStateScope(cwd, run, deadline = Infinity, pinnedStateDir = null, expectedEpoch = null) {
  assertBrokerDeadline(deadline);
  const stateDir = pinnedStateDir ?? resolveStateDir(cwd, { ...(deadline === Infinity ? {} : { deadline }), strictWorkspace: true });
  assertBrokerDeadline(deadline);
  return withStateLockMigrationScope(stateDir, check => {
    const previous = brokerScope;
    if (process.platform === "linux" && expectedEpoch && check.epoch !== expectedEpoch) throw new Error("Broker state epoch changed");
    brokerScope = { cwd, stateDir, epoch: check.epoch, brokerDir: brokerStateDir(stateDir, check.epoch), deadline,
      check() { assertBrokerDeadline(deadline); check(); checkBrokerDirectories(stateDir, check.epoch); check(); assertBrokerDeadline(deadline); } };
    try { brokerScope.check(); return run(); } finally { brokerScope = previous; }
  }, { timeoutMs: brokerRemaining(deadline) });
}
function withBrokerOperation(cwd, run, deadline = brokerScope?.deadline ?? Infinity) {
  if (brokerScope?.cwd === cwd) { brokerScope.check(); return run(); }
  return withBrokerStateScope(cwd, run, deadline);
}
function requireBrokerStateMigration(cwd) {
  if (brokerScope?.cwd !== cwd) throw new Error("A synchronous broker migration scope is required");
  brokerScope.check();
}

/** 継続接続でも生存 sentinel と marker を検証し、認可時の epoch に固定する。 */
export function verifyBrokerEpoch(cwd, epoch, { timeoutMs = 750 } = {}) {
  if (process.platform !== "linux") return true;
  if (!EPOCH.test(epoch ?? "")) throw brokerAdmissionError("epoch is unavailable.");
  return withStateSnapshot(cwd, (_state, context) => {
    if (context.epoch !== epoch) throw brokerAdmissionError("epoch changed.");
    requireNoLegacyAdmission(context);
    context.check();
    return true;
  }, { timeoutMs, strictWorkspace: true });
}

function withBrokerRecoverySnapshot(cwd, epoch, deadline, run) {
  if (process.platform !== "linux") return run();
  return withStateSnapshot(cwd, (_state, context) => {
    if (context.epoch !== epoch) throw brokerAdmissionError("epoch changed.");
    requireNoLegacyAdmission(context);
    context.check();
    const result = run();
    context.check();
    return result;
  }, { timeoutMs: brokerRemaining(deadline), strictWorkspace: true });
}

export function createBrokerSessionDir(prefix = "gkc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000, { signal = null } = {}) {
  const deadline = performance.now() + Math.max(0, timeoutMs);
  while (!signal?.aborted && performance.now() < deadline) {
    const ready = await new Promise((resolve) => {
      let socket;
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        try { socket?.destroy(); } catch { value = false; }
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), Math.max(0, deadline - performance.now()));
      const aborted = () => finish(false);
      try {
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) return finish(false);
        socket = connectToEndpoint(endpoint);
        socket.on("connect", () => finish(!socket.destroyed && performance.now() < deadline));
        socket.on("error", () => finish(false));
        socket.on("close", () => finish(false));
      } catch { finish(false); }
    });
    if (ready && !signal?.aborted && performance.now() < deadline) return true;
    if (signal?.aborted || performance.now() >= deadline) return false;
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(undefined); };
      const timer = setTimeout(done, Math.min(50, deadline - performance.now()));
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
    });
  }
  return false;
}

export async function sendBrokerShutdown(endpoint, timeoutMs = BROKER_SHUTDOWN_TIMEOUT_MS) {
  await /** @type {Promise<void>} */ (new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");

    // 接続はできたが応答が返らないブローカーで固まると、SessionEnd の
    // 短い予算を使い切って後続の後始末に到達しなくなる。必ず時間で切る。
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", finish);
    socket.on("error", finish);
    socket.on("close", finish);
  }));
}

/** 旧版・busy・応答不明は停止済みと判断しない。ACK は closing の受付のみ。 */
export async function requestIdleBrokerShutdown(session, timeoutMs = BROKER_IDLE_SHUTDOWN_ACK_TIMEOUT_MS, { beforeSend = null } = {}) {
  if (!session?.endpoint || !session?.generation) return false;
  const deadline = performance.now() + Math.max(0, timeoutMs);
  if (performance.now() >= deadline) return false;
  return new Promise((resolve) => {
    let socket;
    let buffer = "";
    let settled = false;
    let initialized = false;
    const finish = (accepted = false) => {
      if (settled) return;
      const confirmed = accepted && !socket?.destroyed && performance.now() < deadline;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* 切断の例外でも結果を確定する。 */ }
      resolve(confirmed);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    try {
      socket = connectToEndpoint(session.endpoint);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        try {
          if (settled || socket.destroyed || performance.now() >= deadline) return finish();
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "grok-companion", version: "1" } } })}\n`);
        } catch { finish(); }
      });
      socket.on("data", (chunk) => {
        try {
          if (settled || socket.destroyed || performance.now() >= deadline) return finish();
          buffer += chunk;
          if (buffer.length > 65536) return finish();
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const reply = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
            if (!initialized) {
              if (reply.id !== 1 || reply.error || reply.result?._meta?.grokBrokerGeneration !== session.generation) return finish();
              const allowed = beforeSend?.();
              if (allowed === false || allowed?.then || settled || socket.destroyed || performance.now() >= deadline) return finish();
              initialized = true;
              socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "broker/shutdownIfIdle", params: { generation: session.generation } })}\n`);
            } else {
              return finish(reply.id === 2 && !reply.error && reply.result?.closing === true && reply.result.generation === session.generation);
            }
          }
        } catch { finish(); }
      });
      socket.on("error", () => finish());
      socket.on("close", () => finish());
    } catch { finish(); }
  });
}

function sameBrokerSession(current, expected) {
  return current?.generation === expected?.generation && current?.endpoint === expected?.endpoint && current?.pid === expected?.pid &&
    (process.platform !== "linux" || (current?.epoch && current.epoch === expected?.epoch));
}

/** 削除先は自分が生成する専用 dir と既知 entry だけに限定する。 */
function brokerCleanupPaths(session, anchor = null) {
  if (!session?.generation || !Number.isInteger(session.pid) || session.pid <= 0 ||
      typeof session.sessionDir !== "string" || !path.isAbsolute(session.sessionDir)) return null;
  const dir = path.resolve(session.sessionDir);
  if (!/^gkc-[A-Za-z0-9]{6}$/.test(path.basename(dir))) return null;
  const log = path.join(dir, "broker.log");
  const pid = path.join(dir, "broker.pid");
  if (session.logFile !== log || session.pidFile !== pid) return null;
  let socketName = null;
  if (process.platform === "win32") {
    if (session.endpoint !== createBrokerEndpoint(dir)) return null;
  } else if (session.endpoint === `unix:${path.join(dir, "broker.sock")}`) {
    // 長い旧 endpoint も完全一致だけ許可する。切断された entry は拒否する。
    socketName = "broker.sock";
  } else {
    try {
      if (session.endpoint !== createBrokerEndpoint(dir) || session.endpoint !== `unix:${path.join(dir, "b")}`) return null;
      socketName = "b";
    } catch { return null; }
  }
  try {
    // OS の TEMP 自体には /var -> /private/var 等の正規 alias があり得る。
    // realpath で境界を固定し、削除にも alias を経由しない実pathを使う。
    const root = fs.realpathSync.native(path.resolve(os.tmpdir()));
    if (path.relative(root, fs.realpathSync.native(path.dirname(dir)))) return null;
    const rootStat = fs.lstatSync(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
    const rootKey = identity(rootStat);
    let dirStat = null;
    try { dirStat = fs.lstatSync(dir, { bigint: true }); } catch (error) { if (error?.code !== "ENOENT") return null; }
    if (dirStat && (!dirStat.isDirectory() || dirStat.isSymbolicLink())) return null;
    const realDir = dirStat ? fs.realpathSync.native(dir) : path.join(root, path.basename(dir));
    if (path.relative(root, path.dirname(realDir)) || path.basename(realDir) !== path.basename(dir)) return null;
    const dirKey = dirStat ? identity(dirStat) : anchor?.dirKey ?? null;
    if (anchor && (path.relative(anchor.root, root) || path.relative(anchor.dir, realDir) ||
        anchor.rootKey !== rootKey || anchor.dirKey !== dirKey)) return null;
    const realLog = path.join(realDir, "broker.log");
    const realPid = path.join(realDir, "broker.pid");
    const socket = socketName === null ? null : path.join(realDir, socketName);
    if (dirStat) {
      for (const name of fs.readdirSync(realDir)) {
        const entry = path.join(realDir, name);
        const stat = fs.lstatSync(entry);
        if (stat.isSymbolicLink() || !((entry === realLog || entry === realPid) ? stat.isFile() : entry === socket && stat.isSocket())) return null;
      }
    }
    return { dir: realDir, log: realLog, pid: realPid, socket, root, rootKey, dirKey };
  } catch { return null; }
}

function recordBrokerShutdown(cwd, session) {
  return withBrokerOperation(cwd, () => withBrokerRecoverySnapshot(cwd, session.epoch, brokerScope.deadline, () => {
    const lock = acquireBrokerLock(cwd);
    if (!lock) return "locked";
    try {
      const current = loadBrokerSession(cwd);
      if (!sameBrokerSession(current, session)) return "superseded";
      saveBrokerSessionWithin(cwd, { ...current, shutdownAcceptedGeneration: session.generation }, lock);
      return "saved";
    } finally { releaseBrokerLock(cwd, lock); }
  }));
}

/** Windows broker が所有 Job の停止を実証した時だけ呼ぶ。受付ACKとは別の耐久証拠。 */
export function recordBrokerAgentStopped(cwd, session) {
  if (process.platform !== "win32") return "unsupported";
  return withBrokerStateScope(cwd, () => {
    const lock = acquireBrokerLock(cwd);
    if (!lock) return "locked";
    try {
      const current = loadBrokerSession(cwd);
      if (!sameBrokerSession(current, session) || current?.ownerPlatform !== "win32") return "superseded";
      saveBrokerSessionWithin(cwd, { ...current, shutdownAgentTerminatedGeneration: session.generation }, lock);
      syncSavedBrokerSession(cwd);
      return "saved";
    } finally { releaseBrokerLock(cwd, lock); }
  });
}

/** ACK は死亡ではない。終了の確証がなければ回収用の記録を残す。 */
export async function cleanupIdleBrokerSession(cwd, session, { timeoutMs = 1800 } = {}) {
  const deadline = performance.now() + Math.max(0, timeoutMs);
  const anchor = brokerCleanupPaths(session);
  if (!anchor || performance.now() >= deadline) return false;
  const current = loadBrokerSession(cwd, deadline);
  if (!sameBrokerSession(current, session)) return false;
  const windows = process.platform === "win32";
  if (windows ? current.ownerPlatform !== "win32" :
    session.ownedGroup?.pgid !== session.pid || session.ownedGroup?.generation !== session.generation || session.ownedGroup?.platform !== process.platform) return false;
  // Linux の load は直前に epoch と旧記録を同じ同期区間で検証済み。
  // 他 OS の load は検証 scope を作らないため、通信前にここで確認する。
  if (process.platform !== "linux") withBrokerStateScope(cwd, () => {}, deadline, null, session.epoch);
  let accepted = session.shutdownAcceptedGeneration === session.generation ||
    current.shutdownAcceptedGeneration === session.generation ||
    (windows && current.shutdownAgentTerminatedGeneration === session.generation);
  if (!accepted) {
    if (!(await requestIdleBrokerShutdown(session, Math.min(BROKER_IDLE_SHUTDOWN_ACK_TIMEOUT_MS, brokerRemaining(deadline)), {
      beforeSend: () => withBrokerStateScope(cwd, () => withBrokerRecoverySnapshot(cwd, session.epoch, deadline, () => {
        if (!sameBrokerSession(loadBrokerSession(cwd), session)) return false;
        if (readBrokerAdmission(cwd).pending) return false;
        requireBrokerStateMigration(cwd);
        return true;
      }), deadline, null, session.epoch)
    }))) return false;
  }
  const markerDeadline = Math.min(deadline, performance.now() + 100);
  for (;;) {
    if (performance.now() >= deadline) return false;
    let result;
    try {
      result = withBrokerStateScope(cwd, () => {
        if (!accepted) {
          const marker = recordBrokerShutdown(cwd, session);
          if (marker === "locked") return "locked";
          if (marker !== "saved") return false;
          accepted = true;
        }
        const exited = brokerHasExited(cwd, session, deadline);
        if (exited !== true) return exited === false ? "waiting" : false;
        if (performance.now() >= deadline) return false;
        return cleanupBrokerArtifacts(cwd, session, anchor, deadline);
      }, deadline, null, session.epoch);
    } catch (error) {
      if (/timed out|deadline/i.test(error?.message ?? "")) return false;
      throw error;
    }
    if (result !== "locked" && result !== "waiting") return result;
    if (result === "locked" && performance.now() >= markerDeadline) return false;
    // signal 0だけの待機には検証scopeを保持しない。次の書込み前には新scopeを作る。
    do {
      if (performance.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, Math.min(result === "locked" ? 10 : 25, deadline - performance.now())));
      if (result === "locked" || brokerHasExited(cwd, session, deadline) !== false) break;
    } while (performance.now() < deadline);
  }
}

function brokerHasExited(cwd, session, deadline = Infinity) {
  try { process.kill(session.pid, 0); return false; }
  catch (error) { if (error?.code !== "ESRCH") return null; }
  if (process.platform === "win32") {
    const proof = loadBrokerSession(cwd, deadline);
    return sameBrokerSession(proof, session) && proof.shutdownAgentTerminatedGeneration === session.generation ? true : null;
  }
  try { process.kill(-session.ownedGroup.pgid, 0); return false; }
  catch (error) { return error?.code === "ESRCH" ? true : null; }
}

function cleanupBrokerArtifacts(cwd, session, anchor, deadline) {
  if (performance.now() >= deadline || !sameBrokerSession(loadBrokerSession(cwd), session)) return false;
  const paths = brokerCleanupPaths(session, anchor);
  if (!paths) return false;
  if (process.platform !== "win32") {
    // POSIX pathnameを条件付きでunlinkする原子的な手段はない。全artifactを保持する。
    return withStateSnapshot(cwd, (_state, context) => {
      context.check();
      if (process.platform === "linux" && context.epoch !== session.epoch) throw brokerAdmissionError("epoch changed before cleanup.");
      requireNoLegacyAdmission(context);
      const current = loadBrokerSession(cwd), admission = readBrokerAdmission(cwd);
      if (!sameBrokerSession(current, session) || current?.ownerPlatform !== process.platform ||
          current.ownedGroup?.pgid !== current.pid || current.ownedGroup?.generation !== current.generation ||
          current.ownedGroup?.platform !== process.platform || current.shutdownAcceptedGeneration !== current.generation ||
          admission.pending || admission.lastConfirmed?.outcome !== "ready" ||
          admission.lastConfirmed.generation !== current.generation || admission.lastConfirmed.endpoint !== current.endpoint ||
          admission.lastConfirmed.pid !== current.pid || brokerHasExited(cwd, current, deadline) !== true) return false;
      context.check();
      return clearBrokerSessionWithin(cwd, current);
    }, { timeoutMs: brokerRemaining(deadline), strictWorkspace: true });
  }
  try {
    // pid/socket の失敗時に診断 log を失わないよう、log は最後に扱う。
    for (const entry of [paths.pid, paths.socket, paths.log]) {
      if (!entry) continue;
      if (performance.now() >= deadline || !sameBrokerSession(loadBrokerSession(cwd), session)) return false;
      if (!brokerCleanupPaths(session, anchor)) return false;
      requireBrokerStateMigration(cwd);
      try { fs.unlinkSync(entry); } catch (error) { if (error?.code !== "ENOENT") return false; }
    }
    if (performance.now() >= deadline || !sameBrokerSession(loadBrokerSession(cwd), session) || !brokerCleanupPaths(session, anchor)) return false;
    requireBrokerStateMigration(cwd);
    try { fs.rmdirSync(paths.dir); } catch (error) { if (error?.code !== "ENOENT") return false; }
  } catch { return false; }
  if (performance.now() >= deadline) return false;
  return clearBrokerSessionWithin(cwd, session);
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  return withBrokerStateScope(cwd, () => withBrokerRecoverySnapshot(cwd, brokerScope.epoch, Infinity, () => spawnBrokerProcessWithin({ scriptPath, cwd, endpoint, pidFile, logFile, env })));
}

function spawnBrokerProcessWithin({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env, admissionPipe = false }) {
  requireBrokerStateMigration(cwd);
  let before;
  try { before = fs.lstatSync(logFile, { bigint: true }); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)) throw brokerAdmissionError("broker log is invalid.");
  const logFd = fs.openSync(logFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
    (before ? 0 : fs.constants.O_EXCL) | NOFOLLOW | POSIX_NONBLOCK, 0o600);
  try {
    const opened = fs.fstatSync(logFd, { bigint: true }), current = fs.lstatSync(logFile, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !current.isFile() || current.isSymbolicLink() ||
        !sameStateIdentity(current, stateIdentity(opened), true) || (before && !sameStateIdentity(opened, stateIdentity(before), true))) {
      throw brokerAdmissionError("broker log identity changed.");
    }
    requireBrokerStateMigration(cwd);
    const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
      cwd,
      env,
      detached: true,
      stdio: admissionPipe ? ["ignore", logFd, logFd, "pipe"] : ["ignore", logFd, logFd]
    });
    child.unref();
    return child;
  } finally { fs.closeSync(logFd); }
}

/** この起動で detached:true により作った直子/group だけを停止対象に固定する。 */
function createOwnedPosixBrokerStop(child, ownerDeadline = Infinity, mayStop = () => true) {
  const ownedPid = child.pid;
  let exited = false;
  let spawnFailed = false;
  let stopping = null;
  const hasExited = () => exited || spawnFailed || child.exitCode != null || Boolean(child.signalCode);
  child.once("exit", () => { exited = true; });
  child.once("error", () => {
    // PID を発行できなかった spawn の error だけが「起動していない」確証になる。
    if (!Number.isInteger(ownedPid) || ownedPid <= 0) spawnFailed = true;
  });
  return (requestedDeadline = ownerDeadline) => {
    if (stopping) return stopping;
    stopping = new Promise((resolve) => {
      if (spawnFailed) { resolve(true); return; }
      const deadline = Math.min(ownerDeadline, requestedDeadline, performance.now() + FAILED_BROKER_STOP_TIMEOUT_MS);
      if (performance.now() >= deadline) { resolve(false); return; }
      let settled = false;
      let signalTimer;
      let deadlineTimer;
      let signalAttempted = false;
      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        clearTimeout(signalTimer);
        clearTimeout(deadlineTimer);
        resolve(confirmed);
      };
      deadlineTimer = setTimeout(() => finish(false), deadline - performance.now());
      const inspect = () => {
        if (performance.now() >= deadline) { finish(false); return; }
        if (!mayStop()) { finish(false); return; }
        // 通常の Node/libuv は reap と exit callback の配送を同じ loop 内で終える。
        // timer phase 内の同期 guard→signal の間は、未reap直子が PID/PGID を予約する。
        // 任意の exit callback や await の後へ、この signal 部分だけを移動しない。
        // 独自 waitpid/setsid/setpgid を行う外部 native addon はこの保証に含めない。
        if (!hasExited() && !signalAttempted && Number.isInteger(ownedPid) && ownedPid > 0 && child.pid === ownedPid && !child.killed) {
          signalAttempted = true;
          try { process.kill(-ownedPid, "SIGTERM"); } catch { /* ESRCH/EPERM も死亡の証拠ではない */ }
        }
        if (hasExited()) {
          if (spawnFailed) { finish(true); return; }
          // 直子の exit だけでは同groupの agent が残り得る。終了後は観測専用にする。
          // PGID が再利用されても signal 0 の成功/EPERM は不明扱いで、停止signalを再送しない。
          // 別session/groupへ移った子孫の不存在までは、このgroup不在から推測しない。
          try { process.kill(-ownedPid, 0); } catch (error) {
            if (error?.code === "ESRCH") { finish(true); return; }
          }
        }
        signalTimer = setTimeout(inspect, Math.min(25, deadline - performance.now()));
      };
      signalTimer = setTimeout(inspect, 0);
    });
    return stopping;
  };
}

export function resolveBrokerStateDir(cwd, deadline = Infinity) {
  if (brokerScope?.cwd === cwd) return brokerScope.brokerDir;
  if (process.platform !== "linux") return brokerStateDir(resolveStateDir(cwd, deadline === Infinity ? undefined : { deadline, strictWorkspace: true }), null);
  return withBrokerStateScope(cwd, () => brokerScope.brokerDir, deadline);
}

function resolveBrokerStateFile(cwd, deadline = Infinity) {
  return path.join(resolveBrokerStateDir(cwd, deadline), BROKER_STATE_FILE);
}

function brokerAdmissionError(detail) {
  return new Error(`Broker admission journal ${detail}`);
}

function* iterateBrokerAdmission(bytes, epoch = null) {
  if (bytes.length > MAX_BROKER_ADMISSION_BYTES) throw brokerAdmissionError("exceeds its size limit; inspect it before restarting.");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || (text && !text.endsWith("\n"))) throw brokerAdmissionError("is incomplete or corrupt; automatic restart is blocked.");
  let pending = null;
  let lastConfirmed = null;
  const generations = new Set();
  let processedBytes = 0;
  for (const line of text ? text.slice(0, -1).split("\n") : []) {
    if (!line || Buffer.byteLength(line) > MAX_BROKER_ADMISSION_RECORD_BYTES) throw brokerAdmissionError("has an invalid record.");
    let record;
    try { record = JSON.parse(line); } catch { throw brokerAdmissionError("contains a corrupt record."); }
    if (process.platform === "linux" && epoch && record?.epoch !== epoch) throw brokerAdmissionError("contains a different epoch.");
    if (record?.version === 1) throw brokerAdmissionError("uses a legacy protocol without durable confirmation; keep it unchanged and perform offline recovery after stopping old runtimes.");
    if (record?.version !== BROKER_ADMISSION_VERSION || typeof record.generation !== "string" || !record.generation || record.generation.length > 128) throw brokerAdmissionError("has an unsupported record.");
    if (record.event === "pending") {
      if (pending || generations.has(record.generation) || !Number.isInteger(record.ownerPid) || record.ownerPid <= 0 ||
        !["platform", "lockToken", "endpoint", "sessionDir", "pidFile", "logFile"].every((key) => typeof record[key] === "string" && record[key].length > 0 && record[key].length <= 32768)) throw brokerAdmissionError("has conflicting ownership records.");
      generations.add(record.generation);
      pending = { ...record, spawned: false, pid: null, pgid: null };
    } else if (record.event === "spawned") {
      if (!pending || pending.generation !== record.generation || pending.spawned ||
        !(record.pid === null || (Number.isInteger(record.pid) && record.pid > 0)) ||
        record.pgid !== (pending.platform === "win32" ? null : record.pid)) throw brokerAdmissionError("has conflicting spawn ownership.");
      pending = { ...pending, spawned: true, pid: record.pid, pgid: record.pgid };
    } else if (record.event === "settled") {
      if (!pending || pending.generation !== record.generation || !pending.spawned || pending.settlement || record.pid !== pending.pid ||
        !["ready", "stopped"].includes(record.outcome) || (record.outcome === "ready" && !Number.isInteger(record.pid))) throw brokerAdmissionError("has an unproven settlement.");
      // 完全な行でもfsync失敗後に見え得る。確認行までは未確定generationを保持する。
      pending = { ...pending, settlement: { pid: record.pid, outcome: record.outcome } };
    } else if (record.event === "confirmed") {
      if (!pending || pending.generation !== record.generation || !pending.settlement ||
          record.pid !== pending.settlement.pid || record.outcome !== pending.settlement.outcome) throw brokerAdmissionError("has an unproven confirmation.");
      lastConfirmed = { generation: pending.generation, endpoint: pending.endpoint, pid: pending.pid, outcome: record.outcome };
      pending = null;
    } else throw brokerAdmissionError("has an unknown transition.");
    processedBytes += Buffer.byteLength(line) + 1;
    if (processedBytes >= 32768) { processedBytes = 0; yield; }
  }
  return { bytes, pending, lastConfirmed };
}

export function parseBrokerAdmission(bytes, epoch = null) {
  const iterator = iterateBrokerAdmission(bytes, epoch);
  for (;;) {
    const step = iterator.next();
    if (step.done) return step.value;
  }
}

const stateIdentity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
  uid: String(stat.uid), gid: String(stat.gid), nlink: String(stat.nlink) });
function sameStateIdentity(stat, expected, includeLinks = false) {
  const actual = stateIdentity(stat);
  return actual.dev === expected?.dev && actual.ino === expected?.ino && actual.mode === expected?.mode &&
    actual.uid === expected?.uid && actual.gid === expected?.gid && (!includeLinks || actual.nlink === expected?.nlink);
}

/** 呼出元のstate snapshot内で、後続の非同期検査に必要な対象を固定する。 */
function captureBrokerStateBaseline(stateDir) {
  const lockDir = path.join(stateDir, "state.lock"), marker = path.join(lockDir, "protocol.json");
  const state = fs.lstatSync(stateDir, { bigint: true }), barrier = fs.lstatSync(lockDir, { bigint: true });
  if (!state.isDirectory() || state.isSymbolicLink() || !barrier.isDirectory() || barrier.isSymbolicLink()) throw brokerAdmissionError("state identity is invalid.");
  const markerBefore = fs.lstatSync(marker, { bigint: true });
  if (!markerBefore.isFile() || markerBefore.isSymbolicLink() || markerBefore.size > 65536n) throw brokerAdmissionError("state protocol marker is invalid.");
  const fd = fs.openSync(marker, fs.constants.O_RDONLY | NOFOLLOW | POSIX_NONBLOCK);
  let markerBytes;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameStateIdentity(opened, stateIdentity(markerBefore), true) ||
        opened.size !== markerBefore.size || opened.size > 65536n) throw brokerAdmissionError("state protocol marker changed.");
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count <= 0) break;
      offset += count;
    }
    if (offset !== Number(opened.size)) throw brokerAdmissionError("state protocol marker changed.");
    markerBytes = buffer.subarray(0, offset);
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(marker, { bigint: true });
    if (!sameStateIdentity(after, stateIdentity(opened), true) || !sameStateIdentity(current, stateIdentity(opened), true) ||
        after.size !== opened.size || current.size !== opened.size || markerBytes.length !== Number(opened.size)) throw brokerAdmissionError("state protocol marker changed.");
  } finally { fs.closeSync(fd); }
  let native = null;
  if (process.platform !== "win32") {
    const stat = fs.lstatSync(path.join(lockDir, "native.lock"), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw brokerAdmissionError("native state lock is invalid.");
    native = stateIdentity(stat);
  }
  return { state: stateIdentity(state), barrier: stateIdentity(barrier), marker: stateIdentity(markerBefore), markerBytes, native };
}

async function matchesBrokerStateBaseline(stateDir, baseline) {
  if (!baseline) return false;
  const lockDir = path.join(stateDir, "state.lock"), marker = path.join(lockDir, "protocol.json");
  let handle;
  try {
    const [state, barrier, before] = await Promise.all([
      fs.promises.lstat(stateDir, { bigint: true }), fs.promises.lstat(lockDir, { bigint: true }), fs.promises.lstat(marker, { bigint: true })
    ]);
    if (!state.isDirectory() || state.isSymbolicLink() || !sameStateIdentity(state, baseline.state) ||
        !barrier.isDirectory() || barrier.isSymbolicLink() || !sameStateIdentity(barrier, baseline.barrier) ||
        !before.isFile() || before.isSymbolicLink() || !sameStateIdentity(before, baseline.marker, true) ||
        before.size !== BigInt(baseline.markerBytes.length)) return false;
    if (baseline.native) {
      const native = await fs.promises.lstat(path.join(lockDir, "native.lock"), { bigint: true });
      if (!native.isFile() || native.isSymbolicLink() || !sameStateIdentity(native, baseline.native, true)) return false;
    }
    handle = await fs.promises.open(marker, fs.constants.O_RDONLY | NOFOLLOW | POSIX_NONBLOCK);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameStateIdentity(opened, baseline.marker, true) || opened.size !== before.size) return false;
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead <= 0) return false;
      offset += bytesRead;
    }
    const [after, current] = await Promise.all([handle.stat({ bigint: true }), fs.promises.lstat(marker, { bigint: true })]);
    return bytes.equals(baseline.markerBytes) && sameStateIdentity(after, baseline.marker, true) &&
      sameStateIdentity(current, baseline.marker, true) && after.size === opened.size && current.size === opened.size;
  } catch { return false; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

/** 起動時grantに固定されたstateと、完全なconfirmed ready行を非同期で照合する。 */
export async function inspectBrokerConfirmation(grant, baseline, endpoint, generation) {
  if (!grant || grant.pid !== process.pid || grant.endpoint !== endpoint || grant.generation !== generation ||
      typeof generation !== "string" || !generation || typeof grant.ownerIdentity?.stateDir !== "string") return false;
  const expected = grant.ownerIdentity.directoryIdentity;
  const stateDir = grant.ownerIdentity.stateDir;
  const brokerDir = brokerStateDir(stateDir, grant.ownerIdentity.epoch);
  const journal = path.join(brokerDir, BROKER_ADMISSION_FILE);
  const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
  const directoryMatches = stat => stat.isDirectory() && !stat.isSymbolicLink() &&
    String(stat.dev) === expected?.dev && String(stat.ino) === expected?.ino;
  let handle;
  try {
    if (!(await matchesBrokerStateBaseline(stateDir, baseline))) return false;
    const stateBefore = await fs.promises.lstat(stateDir, { bigint: true });
    if (!directoryMatches(stateBefore)) return false;
    const dirBefore = await fs.promises.lstat(brokerDir, { bigint: true });
    if (!dirBefore.isDirectory() || dirBefore.isSymbolicLink()) return false;
    const before = await fs.promises.lstat(journal, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(MAX_BROKER_ADMISSION_BYTES)) return false;
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    handle = await fs.promises.open(journal, flags);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameStateIdentity(opened, stateIdentity(before), true) || opened.size !== before.size) return false;
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead <= 0) return false;
      offset += bytesRead;
    }
    const iterator = iterateBrokerAdmission(bytes, grant.ownerIdentity.epoch);
    let parsed;
    for (;;) {
      const step = iterator.next();
      if (step.done) { parsed = step.value; break; }
      await new Promise(resolve => setImmediate(resolve));
    }
    const [after, openedAfter, dirAfter, stateAfter] = await Promise.all([
      fs.promises.lstat(journal, { bigint: true }), handle.stat({ bigint: true }), fs.promises.lstat(brokerDir, { bigint: true }), fs.promises.lstat(stateDir, { bigint: true })
    ]);
    if (!after.isFile() || after.isSymbolicLink() || !openedAfter.isFile() ||
        !sameStateIdentity(after, stateIdentity(before), true) || !sameStateIdentity(openedAfter, stateIdentity(before), true) ||
        after.size !== opened.size || openedAfter.size !== opened.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
        openedAfter.mtimeNs !== before.mtimeNs || openedAfter.ctimeNs !== before.ctimeNs ||
        !dirAfter.isDirectory() || dirAfter.isSymbolicLink() || !sameIdentity(dirBefore, dirAfter) ||
        !directoryMatches(stateAfter) || !sameIdentity(stateBefore, stateAfter)) return false;
    if (!(await matchesBrokerStateBaseline(stateDir, baseline))) return false;
    const confirmed = parsed.lastConfirmed;
    return !parsed.pending && confirmed?.generation === generation && confirmed.endpoint === endpoint &&
      confirmed.pid === process.pid && confirmed.outcome === "ready";
  } catch { return false; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

function readBrokerAdmission(cwd, deadline = Infinity) {
  if (process.platform === "linux" && brokerScope?.cwd !== cwd) return withBrokerStateScope(cwd, () => readBrokerAdmission(cwd, deadline), deadline);
  const journal = path.join(resolveBrokerStateDir(cwd, deadline), BROKER_ADMISSION_FILE);
  let fd;
  let initial;
  try {
    initial = fs.lstatSync(journal, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n) throw new Error("not a regular journal");
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    fd = fs.openSync(journal, flags);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || !sameStateIdentity(stat, stateIdentity(initial), true) || stat.size !== initial.size) throw new Error("journal identity changed");
    if (stat.size === 0n) throw brokerAdmissionError("is empty; inspect it before restarting.");
    if (stat.size > BigInt(MAX_BROKER_ADMISSION_BYTES)) throw brokerAdmissionError("exceeds its size limit; inspect it before restarting.");
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      assertBrokerDeadline(Math.min(deadline, brokerScope?.deadline ?? Infinity));
      const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    const end = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(journal, { bigint: true });
    assertBrokerDeadline(Math.min(deadline, brokerScope?.deadline ?? Infinity));
    if (end.size > BigInt(MAX_BROKER_ADMISSION_BYTES) || count > MAX_BROKER_ADMISSION_BYTES) throw brokerAdmissionError("exceeds its size limit; inspect it before restarting.");
    if (!current.isFile() || current.isSymbolicLink() || !end.isFile() || !sameStateIdentity(current, stateIdentity(stat), true) ||
        !sameStateIdentity(end, stateIdentity(stat), true) || end.size !== stat.size || current.size !== stat.size || BigInt(count) !== stat.size ||
        end.mtimeNs !== stat.mtimeNs || end.ctimeNs !== stat.ctimeNs || current.mtimeNs !== stat.mtimeNs || current.ctimeNs !== stat.ctimeNs) {
      throw brokerAdmissionError("changed while being read; automatic restart is blocked.");
    }
    return { ...parseBrokerAdmission(bytes.subarray(0, count), brokerScope?.epoch), fileIdentity: stateIdentity(stat) };
  } catch (error) {
    if (error?.code === "ENOENT" && !initial) return { bytes: Buffer.alloc(0), pending: null, lastConfirmed: null, fileIdentity: null };
    if (/^Broker admission journal |^Timed out within the Grok broker/.test(error?.message ?? "")) throw error;
    throw brokerAdmissionError(`cannot be read: ${journal}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function requireSettledBrokerAdmission(cwd, ownStartupLock = null) {
  const admission = readBrokerAdmission(cwd);
  if (admission.pending) throw brokerAdmissionError(`has pending generation ${admission.pending.generation}; startup/termination is unconfirmed. Log: ${admission.pending.logFile}`);
  if (!admission.fileIdentity) {
    let exists = false;
    try { fs.lstatSync(resolveBrokerLockFile(cwd), { bigint: true }); exists = true; }
    catch (error) { if (error?.code !== "ENOENT") throw brokerAdmissionError("startup lock cannot be inspected while the journal is missing."); }
    if (ownStartupLock) {
      if (!exists || readBoundedBrokerFile(resolveBrokerLockFile(cwd)).toString("utf8") !== ownStartupLock) {
        throw brokerAdmissionError("startup lock ownership cannot be verified while the journal is missing.");
      }
    } else if (exists) throw brokerAdmissionError("is missing while a startup lock exists; offline recovery is required.");
  }
  const session = loadBrokerSession(cwd), confirmed = admission.lastConfirmed;
  if (session && (!confirmed || confirmed.outcome !== "ready" || confirmed.generation !== session.generation ||
      confirmed.endpoint !== session.endpoint || confirmed.pid !== session.pid)) throw brokerAdmissionError("saved broker session has no matching confirmation.");
}

/** direct起動の確認と予約を、broker pending追記と同じmutexで直列化する。 */
export function reserveDirectAdmission(cwd, { timeoutMs = 7500 } = {}) {
  const deadline = performance.now() + timeoutMs;
  return reserveDirectStart(cwd, context => {
    context.check();
    withBrokerStateScope(cwd, () => requireSettledBrokerAdmission(cwd), deadline, context.stateDir, context.epoch);
    context.check();
  }, { timeoutMs });
}

/** 保存済みbrokerの自動採用を、確認とhandshakeの間の世代変更から保護する。 */
function inspectManagedBrokerWithin(cwd, session, context, deadline) {
    context.check();
    if (process.platform === "linux" && session?.epoch !== context.epoch) throw brokerAdmissionError("managed broker epoch changed.");
    withBrokerStateScope(cwd, () => {
      requireSettledBrokerAdmission(cwd);
      const saved = loadBrokerSession(cwd), confirmed = readBrokerAdmission(cwd).lastConfirmed;
      if (!sameBrokerSession(saved, session) || !confirmed || confirmed.outcome !== "ready" ||
          confirmed.generation !== session?.generation || confirmed.endpoint !== session?.endpoint || confirmed.pid !== session?.pid) {
        throw brokerAdmissionError("saved broker has no matching confirmed generation.");
      }
    }, deadline, context.stateDir, context.epoch);
    context.check();
}

export function reserveManagedBroker(cwd, session, { timeoutMs = 7500 } = {}) {
  const deadline = performance.now() + timeoutMs;
  return reserveDirectStart(cwd, context => inspectManagedBrokerWithin(cwd, session, context, deadline), { timeoutMs });
}

/** cancelはpromptを送らないため、永続markerを作らず既存世代だけを確認する。 */
export function inspectManagedBrokerForCancel(cwd, session, { timeoutMs = 600 } = {}) {
  return withStateSnapshot(cwd, (_state, context) => {
    context.check();
    requireNoLegacyAdmission(context);
    const saved = loadBrokerSessionFromStateDir(context.stateDir, context.epoch);
    if ((process.platform === "linux" && saved?.epoch !== context.epoch) || !sameBrokerSession(saved, session) || typeof saved?.generation !== "string" || !saved.generation ||
        typeof saved?.endpoint !== "string" || !saved.endpoint || !Number.isInteger(saved?.pid) || saved.pid <= 0) {
      throw brokerAdmissionError("saved broker identity changed before cancellation.");
    }
    context.check();
    return true;
  }, { timeoutMs, strictWorkspace: true });
}

/** 専用の継承pipeと永続化済みspawn記録の両方を検証してから内側agentを許可する。 */
export async function authorizeBrokerChild(cwd, endpoint, { timeoutMs = 4000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  const received = await new Promise((resolve, reject) => {
    let stream, buffer = "", done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) { stream?.destroy(); reject(error); }
      else resolve({ grant: value, channel: stream });
    };
    const timer = setTimeout(() => finish(brokerAdmissionError("broker child authorization timed out.")), timeoutMs);
    try {
      stream = new net.Socket({ fd: 3, readable: true, writable: true });
      stream.setEncoding("utf8");
      stream.on("data", chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_BROKER_ADMISSION_RECORD_BYTES) return finish(brokerAdmissionError("broker child authorization is too large."));
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        if (end !== buffer.length - 1) return finish(brokerAdmissionError("broker child authorization is invalid."));
        try { finish(null, JSON.parse(buffer.slice(0, end))); }
        catch { finish(brokerAdmissionError("broker child authorization is invalid.")); }
      });
      stream.once("error", error => finish(error));
      stream.once("end", () => finish(brokerAdmissionError("broker child authorization ended before approval.")));
    } catch (error) { finish(error); }
  });
  const { grant, channel } = received;
  if (grant?.version !== 1 || grant.pid !== process.pid || grant.endpoint !== endpoint ||
      typeof grant.generation !== "string" || typeof grant.nonce !== "string" || !grant.nonce || !grant.ownerIdentity ||
      !grant.agentEnv || !["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "TMPDIR", "TMP", "TEMP"].every(key => grant.agentEnv[key] === null ||
        (typeof grant.agentEnv[key] === "string" && grant.agentEnv[key].length <= 16384))) {
    channel.destroy(); throw brokerAdmissionError("broker child authorization does not match this process.");
  }
  const remaining = deadline - performance.now();
  if (remaining <= 0) { channel.destroy(); throw brokerAdmissionError("broker child authorization timed out."); }
  try {
    let baseline;
    withStateSnapshot(cwd, (_state, context) => {
    context.check();
    requireNoLegacyAdmission(context);
    const expected = grant.ownerIdentity;
    if ((process.platform === "linux" && context.epoch !== expected.epoch) ||
        context.hostId !== expected.hostId || context.volumeGuid !== expected.volumeGuid ||
        context.directoryIdentity?.dev !== expected.directoryIdentity?.dev || context.directoryIdentity?.ino !== expected.directoryIdentity?.ino) {
      throw brokerAdmissionError("broker child state identity does not match its owner.");
    }
    return withBrokerStateScope(cwd, () => {
      const pending = readBrokerAdmission(cwd).pending;
      if (!pending || !pending.spawned || pending.settlement || pending.generation !== grant.generation ||
          pending.pid !== process.pid || pending.endpoint !== endpoint) throw brokerAdmissionError("broker child does not own the pending generation.");
      baseline = captureBrokerStateBaseline(context.stateDir);
      context.check();
      return true;
    }, deadline, context.stateDir, context.epoch);
    }, { timeoutMs: remaining, strictWorkspace: true });
    if (channel.readableEnded || channel.destroyed) throw brokerAdmissionError("broker owner disconnected before authorization.");
    return { grant, channel, baseline };
  } catch (error) { channel.destroy(); throw error; }
}

async function waitForBrokerAdmission(cwd, timeoutMs, deadline = performance.now() + timeoutMs) {
  let pending = null;
  for (;;) {
    if (performance.now() >= deadline && pending) throw brokerAdmissionError(`has pending generation ${pending.generation}; startup/termination is unconfirmed. Log: ${pending.logFile}`);
    assertBrokerDeadline(deadline);
    const admission = readBrokerAdmission(cwd, deadline);
    pending = admission.pending;
    if (!admission.pending) return;
    if (performance.now() >= deadline) throw brokerAdmissionError(`has pending generation ${admission.pending.generation}; startup/termination is unconfirmed. Log: ${admission.pending.logFile}`);
    let ownerLock;
    try { ownerLock = readBoundedBrokerFile(resolveBrokerLockFile(cwd, deadline)).toString("utf8"); } catch { /* 未完了は解除しない */ }
    if (ownerLock !== admission.pending.lockToken || performance.now() >= deadline) throw brokerAdmissionError(`has pending generation ${admission.pending.generation}; startup/termination is unconfirmed. Log: ${admission.pending.logFile}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - performance.now())));
  }
}

function syncBrokerStateDirectory(cwd) {
  if (process.platform === "win32") return;
  requireBrokerStateMigration(cwd);
  const dir = resolveBrokerStateDir(cwd), before = fs.lstatSync(dir, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw brokerAdmissionError("broker directory is invalid.");
  const descriptor = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | NOFOLLOW | POSIX_NONBLOCK);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || !sameStateIdentity(opened, stateIdentity(before))) throw brokerAdmissionError("broker directory identity changed.");
    fs.fsyncSync(descriptor);
    const after = fs.lstatSync(dir, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameStateIdentity(after, stateIdentity(opened))) throw brokerAdmissionError("broker directory identity changed.");
  } finally { fs.closeSync(descriptor); }
}

function appendBrokerAdmission(cwd, record, lock) {
  return withBrokerOperation(cwd, () => {
  requireBrokerStateMigration(cwd);
  if (!lock || readBoundedBrokerFile(resolveBrokerLockFile(cwd)).toString("utf8") !== lock) throw brokerAdmissionError("lost its startup lock.");
  const previous = readBrokerAdmission(cwd);
  const bytes = Buffer.from(`${JSON.stringify({ version: BROKER_ADMISSION_VERSION, ...record,
    ...(process.platform === "linux" ? { epoch: brokerScope.epoch } : {}) })}\n`, "utf8");
  const reserve = record.event === "pending" ? MAX_BROKER_ADMISSION_RECORD_BYTES * 3 : 0;
  if (bytes.length > MAX_BROKER_ADMISSION_RECORD_BYTES || previous.bytes.length + bytes.length + reserve > MAX_BROKER_ADMISSION_BYTES) throw brokerAdmissionError("has no safe capacity for another generation.");
  parseBrokerAdmission(Buffer.concat([previous.bytes, bytes]), brokerScope.epoch);
  requireBrokerStateMigration(cwd);
  fs.mkdirSync(resolveBrokerStateDir(cwd), { recursive: true, mode: 0o700 });
  requireBrokerStateMigration(cwd);
  const journal = path.join(resolveBrokerStateDir(cwd), BROKER_ADMISSION_FILE);
  const descriptor = fs.openSync(journal, fs.constants.O_WRONLY | fs.constants.O_APPEND |
    (previous.fileIdentity ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL) | NOFOLLOW | POSIX_NONBLOCK, 0o600);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const expected = previous.fileIdentity ?? stateIdentity(opened);
    const check = expectedSize => {
      const fd = fs.fstatSync(descriptor, { bigint: true }), current = fs.lstatSync(journal, { bigint: true });
      if (!fd.isFile() || !current.isFile() || current.isSymbolicLink() || fd.nlink !== 1n || current.nlink !== 1n ||
          !sameStateIdentity(fd, expected, true) || !sameStateIdentity(current, expected, true) ||
          fd.size !== BigInt(expectedSize) || current.size !== BigInt(expectedSize)) throw brokerAdmissionError("journal identity changed before write.");
    };
    check(previous.bytes.length);
    let written = 0;
    while (written < bytes.length) {
      requireBrokerStateMigration(cwd);
      check(previous.bytes.length + written);
      const count = fs.writeSync(descriptor, bytes, written, bytes.length - written);
      if (count <= 0) throw brokerAdmissionError("could not finish its record.");
      written += count;
    }
    requireBrokerStateMigration(cwd);
    fs.fsyncSync(descriptor);
    check(previous.bytes.length + bytes.length);
  } finally { fs.closeSync(descriptor); }
  syncBrokerStateDirectory(cwd);
  });
}

function syncSavedBrokerSession(cwd) {
  return withBrokerOperation(cwd, () => {
  requireBrokerStateMigration(cwd);
  const file = resolveBrokerStateFile(cwd), before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw brokerAdmissionError("saved broker session is invalid.");
  const descriptor = fs.openSync(file, fs.constants.O_RDWR | NOFOLLOW | POSIX_NONBLOCK);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() ||
        !sameStateIdentity(opened, stateIdentity(before), true) || !sameStateIdentity(current, stateIdentity(before), true)) throw brokerAdmissionError("saved broker session identity changed.");
    requireBrokerStateMigration(cwd); fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  syncBrokerStateDirectory(cwd);
  });
}

function loadBrokerSessionFromStateDir(stateDir, epoch = null) {
  const stateFile = path.join(brokerStateDir(stateDir, epoch), BROKER_STATE_FILE);
  if (process.platform === "linux") {
    let before, fd;
    try {
      before = fs.lstatSync(stateFile, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 65536n) throw new Error("invalid session file");
      fd = fs.openSync(stateFile, fs.constants.O_RDONLY | NOFOLLOW | POSIX_NONBLOCK);
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || !sameStateIdentity(opened, stateIdentity(before), true) || opened.size !== before.size) throw new Error("session identity changed");
      const bytes = Buffer.alloc(Number(opened.size) + 1);
      let count = 0;
      while (count < bytes.length) { const n = fs.readSync(fd, bytes, count, bytes.length - count, count); if (!n) break; count += n; }
      const after = fs.lstatSync(stateFile, { bigint: true }), end = fs.fstatSync(fd, { bigint: true });
      if (BigInt(count) !== opened.size || end.size !== opened.size || after.size !== opened.size || !after.isFile() || !end.isFile() ||
          !sameStateIdentity(after, stateIdentity(opened), true) || !sameStateIdentity(end, stateIdentity(opened), true) ||
          end.mtimeNs !== opened.mtimeNs || end.ctimeNs !== opened.ctimeNs || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || after.isSymbolicLink()) throw new Error("session changed");
      const data = bytes.subarray(0, count), json = data.toString("utf8");
      if (!Buffer.from(json, "utf8").equals(data)) throw new Error("session encoding is invalid");
      const session = JSON.parse(json);
      if (session?.epoch !== epoch || typeof session.generation !== "string" || !session.generation ||
          typeof session.endpoint !== "string" || !session.endpoint || !Number.isInteger(session.pid) || session.pid <= 0) throw new Error("invalid session identity");
      return session;
    } catch (error) {
      if (error?.code === "ENOENT" && !before) return null;
      throw brokerAdmissionError("saved broker session is invalid; offline recovery is required.");
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  let before;
  try {
    before = fs.lstatSync(stateFile, { bigint: true });
    const session = JSON.parse(readBoundedBrokerFile(stateFile).toString("utf8"));
    if (!session || typeof session !== "object" || Array.isArray(session) ||
        typeof session.generation !== "string" || !session.generation.trim() ||
        typeof session.endpoint !== "string" || !session.endpoint.trim() ||
        !Number.isInteger(session.pid) || session.pid <= 0) throw new Error("invalid session identity");
    return session;
  } catch (error) {
    if (error?.code === "ENOENT" && !before) return null;
    throw brokerAdmissionError("saved broker session is invalid; offline recovery is required.");
  }
}

export function loadBrokerSession(cwd, deadline = Infinity) {
  if (brokerScope?.cwd === cwd) return loadBrokerSessionFromStateDir(brokerScope.stateDir, brokerScope.epoch);
  if (process.platform !== "linux") return loadBrokerSessionFromStateDir(resolveStateDir(cwd, deadline === Infinity ? undefined : { deadline, strictWorkspace: true }));
  return withBrokerStateScope(cwd, () => {
    withStateSnapshot(cwd, (_state, context) => {
      if (context.epoch !== brokerScope.epoch) throw brokerAdmissionError("epoch changed while loading session.");
      requireNoLegacyAdmission(context);
    }, { timeoutMs: brokerRemaining(deadline), strictWorkspace: true });
    return loadBrokerSessionFromStateDir(brokerScope.stateDir, brokerScope.epoch);
  }, deadline);
}

/** 明示 endpoint が保存済み managed session と完全一致する場合だけ識別する。 */
export function findExplicitManagedSession(cwd, endpoint) {
  if (process.platform !== "linux" || typeof endpoint !== "string") return null;
  try {
    const stateDir = resolveStateDir(cwd, { strictWorkspace: true });
    const candidates = [path.join(stateDir, BROKER_STATE_FILE)];
    try {
      const oldDir = path.join(stateDir, BROKER_STATE_NAMESPACE), oldStat = fs.lstatSync(oldDir);
      if (oldStat.isDirectory() && !oldStat.isSymbolicLink()) candidates.push(path.join(oldDir, BROKER_STATE_FILE));
    } catch { /* 不明な endpoint は管理外として扱う。 */ }
    const root = path.join(stateDir, LINUX_BROKER_STATE_NAMESPACE);
    try {
      const stat = fs.lstatSync(root);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const names = [], listing = fs.opendirSync(root);
        try { for (;;) { const entry = listing.readSync(); if (!entry) break; names.push(entry.name); if (names.length > 65) break; } }
        finally { listing.closeSync(); }
        if (names.length <= 65) for (const name of names) {
          if (!EPOCH.test(name)) continue;
          const dir = path.join(root, name), entry = fs.lstatSync(dir);
          if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.push(path.join(dir, BROKER_STATE_FILE));
        }
      }
    } catch { /* 未確認 endpoint は管理外として扱う。 */ }
    for (const file of candidates) {
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) continue;
        const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | POSIX_NONBLOCK);
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) continue;
          const bytes = Buffer.alloc(opened.size + 1);
          let count = 0;
          while (count < bytes.length) { const n = fs.readSync(fd, bytes, count, bytes.length - count, count); if (!n) break; count += n; }
          const after = fs.lstatSync(file), end = fs.fstatSync(fd);
          if (count !== opened.size || end.size !== opened.size || after.size !== opened.size ||
              after.dev !== opened.dev || after.ino !== opened.ino || end.mtimeMs !== opened.mtimeMs || end.ctimeMs !== opened.ctimeMs ||
              after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.isSymbolicLink()) continue;
          const data = bytes.subarray(0, count), json = data.toString("utf8");
          if (!Buffer.from(json, "utf8").equals(data)) continue;
          const session = JSON.parse(json);
          if (session?.endpoint === endpoint) return { session, legacy: !EPOCH.test(session.epoch ?? "") || file !== path.join(brokerStateDir(stateDir, session.epoch), BROKER_STATE_FILE) };
        } finally { fs.closeSync(fd); }
      } catch { /* 壊れた記録から endpoint の所有者は推測しない。 */ }
    }
  } catch { /* 外部 endpoint の動作はローカル状態に依存させない。 */ }
  return null;
}

export function saveBrokerSession(cwd, session, heldLock = null) {
  return withBrokerStateScope(cwd, () => withBrokerRecoverySnapshot(cwd, session?.epoch, Infinity, () => saveBrokerSessionWithin(cwd, session, heldLock)));
}

function saveBrokerSessionWithin(cwd, session, heldLock = null) {
  requireBrokerStateMigration(cwd);
  if (process.platform === "linux" && session?.epoch !== brokerScope.epoch) throw brokerAdmissionError("saved broker epoch changed.");
  const lock = heldLock ?? acquireBrokerLock(cwd);
  if (!lock) throw new Error("Broker state is locked.");
  try {
    const stateDir = resolveBrokerStateDir(cwd);
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const stateFile = resolveBrokerStateFile(cwd);
    const temporaryFile = `${stateFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    let temporaryIdentity = null;
    try {
      requireBrokerStateMigration(cwd);
      fs.writeFileSync(temporaryFile, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      temporaryIdentity = stateIdentity(fs.lstatSync(temporaryFile, { bigint: true }));
      requireBrokerStateMigration(cwd);
      fs.renameSync(temporaryFile, stateFile);
      temporaryIdentity = null;
    } finally {
      if (temporaryIdentity && fs.existsSync(temporaryFile)) {
        requireBrokerStateMigration(cwd);
        const current = fs.lstatSync(temporaryFile, { bigint: true });
        if (current.isFile() && !current.isSymbolicLink() && sameStateIdentity(current, temporaryIdentity, true)) fs.rmSync(temporaryFile, { force: true });
      }
    }
  } finally {
    if (!heldLock) releaseBrokerLock(cwd, lock);
  }
}

export function clearBrokerSession(cwd, expected = null) {
  // broker記録がない場合は、未移行保存先にもlockを新設しない。
  if (!fs.existsSync(resolveBrokerStateFile(cwd))) return expected == null;
  return withBrokerStateScope(cwd, () => withBrokerRecoverySnapshot(cwd, brokerScope.epoch, Infinity, () => clearBrokerSessionWithin(cwd, expected)));
}

function clearBrokerSessionWithin(cwd, expected = null) {
  const lock = acquireBrokerLock(cwd);
  if (!lock) return false;
  try {
    const current = loadBrokerSession(cwd);
    if (expected && (current?.generation !== expected.generation || current?.endpoint !== expected.endpoint || current?.pid !== expected.pid)) return false;
    const stateFile = resolveBrokerStateFile(cwd);
    if (fs.existsSync(stateFile)) {
      requireBrokerStateMigration(cwd);
      fs.unlinkSync(stateFile);
    }
    return true;
  } finally {
    releaseBrokerLock(cwd, lock);
  }
}

async function isBrokerEndpointReady(endpoint, generation, timeoutMs = 750) {
  if (!endpoint || typeof generation !== "string" || !generation) return false;
  return new Promise(resolve => {
    let socket, buffer = "", settled = false;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket?.destroy(); resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = connectToEndpoint(endpoint);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "grok-companion", version: "1" } } })}\n`));
      socket.on("data", chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 65536) return finish(false);
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        try {
          const message = JSON.parse(buffer.slice(0, end));
          finish(message.id === 1 && !message.error && message.result?._meta?.grokBrokerGeneration === generation);
        } catch { finish(false); }
      });
      socket.on("error", () => finish(false));
      socket.on("close", () => finish(false));
    } catch { finish(false); }
  });
}

function resolveBrokerLockFile(cwd, deadline = Infinity) {
  return path.join(resolveBrokerStateDir(cwd, deadline), BROKER_LOCK_FILE);
}

/**
 * ブローカー起動・状態保存・条件付き削除の排他ロック。取得時は所有 token を返す。
 *
 * 起動判定は「読んで、無ければ spawn して、書く」の 3 段なので、
 * 同じリポジトリで 2 プロセスが同時に走るとブローカーが二重に立ち、
 * 負けた側と配下の grok が誰にも参照されないまま残り続ける。
 */
function acquireBrokerLock(cwd) {
  return withBrokerOperation(cwd, () => {
  requireBrokerStateMigration(cwd);
  const lockFile = resolveBrokerLockFile(cwd);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  try {
    const token = `${process.platform === "linux" ? `${brokerScope.epoch}:` : ""}${process.pid}:${randomUUID()}\n`;
    requireBrokerStateMigration(cwd);
    fs.writeFileSync(lockFile, token, { flag: "wx" });
    return token;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  // 時刻だけの奪取は、生きた所有者の保存・削除と競合する。
  // 所有不明のロックは保持し、呼び出し側の直接起動へ委ねる。
  return null;
  });
}

function releaseBrokerLock(cwd, token) {
  try {
    return withBrokerOperation(cwd, () => {
    requireBrokerStateMigration(cwd);
    const lockFile = resolveBrokerLockFile(cwd);
    if (readBoundedBrokerFile(lockFile).toString("utf8") === token) {
      requireBrokerStateMigration(cwd);
      fs.unlinkSync(lockFile);
    }
    });
  } catch {
    // 後始末の失敗は起動の成否に影響しない。
  }
}

export async function ensureBrokerSession(cwd, options = {}) {
  const deadline = performance.now() + (options.timeoutMs ?? BROKER_START_TOTAL_TIMEOUT_MS);
  const authMode = (options.env ?? process.env).XAI_API_KEY ? "api-key" : "browser";
  let lock = null;
  let owned = null;
  let released = false;
  let pendingAttempted = false;
  let operationEpoch = null;
  const finish = () => {
    if (lock && pendingAttempted) {
      try { fs.lstatSync(path.join(resolveBrokerStateDir(cwd), BROKER_ADMISSION_FILE), { bigint: true }); }
      catch { released = true; return; } // journal 消失・照会不能時は lock を証拠として保持する。
    }
    if (lock) releaseBrokerLock(cwd, lock);
    released = true;
  };
  const prepare = () => {
    const select = () => {
      const admission = readBrokerAdmission(cwd);
      if (admission.pending) return { kind: "admission" };
      const existing = loadBrokerSession(cwd);
      if (existing) return { kind: "existing", session: existing };
      lock = acquireBrokerLock(cwd);
      return lock ? { kind: "start" } : { kind: "rival" };
    };
    let step;
    if (process.platform === "linux") {
      if (operationEpoch && operationEpoch !== brokerScope.epoch) throw brokerAdmissionError("epoch changed while startup was pending.");
      operationEpoch = brokerScope.epoch;
      step = withStateSnapshot(cwd, (_state, context) => {
        if (context.epoch !== operationEpoch) throw brokerAdmissionError("epoch changed before startup.");
        requireNoLegacyAdmission(context);
        context.check();
        return select();
      }, { timeoutMs: brokerRemaining(deadline), strictWorkspace: true });
    } else step = select();
    if (step.kind === "start") return { kind: "start", prepared: prepareBrokerStart(cwd, options, lock, value => { owned = value; }, () => { pendingAttempted = true; }) };
    return step;
  };
  try {
    let step = withBrokerStateScope(cwd, prepare, deadline);
    const admissionDeadline = Math.min(deadline, performance.now() + BROKER_READY_TIMEOUT_MS);
    while (step.kind === "admission") {
      await waitForBrokerAdmission(cwd, brokerRemaining(admissionDeadline), admissionDeadline);
      step = withBrokerStateScope(cwd, prepare, deadline);
    }
    if (step.kind === "existing") return await readyBrokerSession(cwd, step.session, authMode, deadline);
    if (step.kind === "rival") {
      const rivalDeadline = Math.min(deadline, performance.now() + BROKER_READY_TIMEOUT_MS);
      // 待機中の読取りだけでcold検査を反復せず、最後のfresh検証をphase内に予約する。
      // 短予算・遅い照会では最終scopeが失敗し、未検証のnullは返さない。
      const finalReserve = Math.min(BROKER_START_FINALIZE_RESERVE_MS, brokerRemaining(rivalDeadline) / 2);
      const waitDeadline = rivalDeadline - finalReserve;
      while (performance.now() < waitDeadline) {
        let rival;
        try {
          await waitForBrokerAdmission(cwd, brokerRemaining(waitDeadline), waitDeadline);
          rival = withBrokerStateScope(cwd, () => loadBrokerSession(cwd), waitDeadline, null, operationEpoch);
        } catch (error) {
          // 待機用の期限だけを使い切った場合、予約済みの最終検証で pending を再確認する。
          if (performance.now() >= waitDeadline && performance.now() < rivalDeadline && /timed out|deadline/i.test(error?.message ?? "")) break;
          throw error;
        }
        if (rival) {
          const current = withBrokerStateScope(cwd, () => loadBrokerSession(cwd), rivalDeadline, null, operationEpoch);
          const ready = current ? await readyBrokerSession(cwd, current, authMode, rivalDeadline) : null;
          if (ready) return ready;
        }
        if (performance.now() >= waitDeadline) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(50, waitDeadline - performance.now())));
      }
      return withBrokerStateScope(cwd, () => {
        requireSettledBrokerAdmission(cwd);
        return null;
      }, rivalDeadline, null, operationEpoch);
    }
    return await startBrokerSession(cwd, options, lock, { deadline, prepared: step.prepared, owned, finish });
  } catch (error) {
    if (owned?.stopOnError && !owned.readySettlementDurable) await owned.stopOnError();
    throw error;
  } finally {
    // 期限後・検証不能時はlock/journalを保留し、無検証の削除で解除しない。
    if (lock && !released && performance.now() < deadline) {
      try { withBrokerStateScope(cwd, () => withBrokerRecoverySnapshot(cwd, operationEpoch, deadline, finish), deadline, null, operationEpoch); } catch { /* 未確認の起動記録を保持する。 */ }
    }
  }
}

async function readyBrokerSession(cwd, current, authMode, deadline, heldLock = null) {
  if (current.authMode && current.authMode !== authMode) {
    return withBrokerStateScope(cwd, () => withBrokerRecoverySnapshot(cwd, current.epoch, deadline, () => { requireSettledBrokerAdmission(cwd); return null; }), deadline, null, current.epoch);
  }
  const ready = await isBrokerEndpointReady(current.endpoint, current.generation, Math.min(750, brokerRemaining(deadline)));
  return withBrokerStateScope(cwd, () => withBrokerRecoverySnapshot(cwd, current.epoch, deadline, () => {
    if (!ready) { requireSettledBrokerAdmission(cwd); throw brokerAdmissionError("broker generation could not be confirmed at its endpoint."); }
    const lock = heldLock ?? acquireBrokerLock(cwd);
    if (!lock) throw brokerAdmissionError("readiness remains unconfirmed while broker state is locked.");
    try {
      const ownsLock = () => readBoundedBrokerFile(resolveBrokerLockFile(cwd)).toString("utf8") === lock;
      if (!ownsLock()) throw brokerAdmissionError("lost the lock before confirming broker readiness.");
      requireSettledBrokerAdmission(cwd);
      const saved = loadBrokerSession(cwd);
      const confirmed = readBrokerAdmission(cwd).lastConfirmed;
      if (typeof saved?.generation !== "string" || !saved.generation.trim() ||
          typeof saved?.endpoint !== "string" || !saved.endpoint.trim() ||
          !Number.isInteger(saved?.pid) || saved.pid <= 0 || !sameBrokerSession(saved, current) ||
          !confirmed || confirmed.outcome !== "ready" || confirmed.generation !== saved.generation ||
          confirmed.endpoint !== saved.endpoint || confirmed.pid !== saved.pid ||
          (saved.authMode && saved.authMode !== authMode)) {
        throw brokerAdmissionError("broker generation or identity changed while readiness was pending.");
      }
      requireBrokerStateMigration(cwd);
      if (!ownsLock()) throw brokerAdmissionError("lost the lock before adopting the settled broker generation.");
      return saved;
    } finally {
      if (!heldLock) releaseBrokerLock(cwd, lock);
    }
  }), deadline, null, current.epoch);
}

function prepareBrokerStart(cwd, options, lock, onOwned, onPendingAttempt = () => {}) {
  requireBrokerStateMigration(cwd);
  requireSettledBrokerAdmission(cwd, lock);
  // ロックを取った後にもう一度見る。待っている間に別プロセスが
  // 立ち上げ切っているかもしれない。
  const current = loadBrokerSession(cwd);
  const authMode = (options.env ?? process.env).XAI_API_KEY ? "api-key" : "browser";
  if (current) return { current, authMode };

  requireBrokerStateMigration(cwd);
  let sessionDir, endpoint, pidFile, logFile;
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  // mkdtemp の接尾辞は 6 文字。起動不能な長さは dir や pending の作成前に拒否する。
  if (!options.createBrokerEndpoint) createBrokerEndpoint(path.join(os.tmpdir(), "gkc-000000"), options.platform);
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../acp-broker.mjs", import.meta.url));

  const generation = randomUUID();
  const requestedEnv = options.env ?? process.env;
  const agentEnv = Object.fromEntries(["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "TMPDIR", "TMP", "TEMP"].map(key => [key, requestedEnv[key] ?? null]));
  if (Object.values(agentEnv).some(value => value !== null && (typeof value !== "string" || value.length > 16384))) {
    throw brokerAdmissionError("agent environment metadata is invalid.");
  }
  // spawn より先に barrier を永続化する。以後の保存失敗でも次回の無記録再起動を許さない。
  const deadline = brokerScope.deadline;
  let ownerIdentity;
  withStateSnapshot(cwd, (_state, context) => {
    context.check();
    if (context.stateDir !== brokerScope.stateDir || (process.platform === "linux" && context.epoch !== brokerScope.epoch)) throw brokerAdmissionError("state identity or epoch changed before startup.");
    requireNoDirectStart(context);
    sessionDir = createBrokerSessionDir();
    endpoint = endpointFactory(sessionDir, options.platform);
    pidFile = path.join(sessionDir, "broker.pid");
    logFile = path.join(sessionDir, "broker.log");
    ownerIdentity = { stateDir: context.stateDir, directoryIdentity: { ...context.directoryIdentity },
      hostId: context.hostId, volumeGuid: context.volumeGuid, ...(process.platform === "linux" ? { epoch: context.epoch } : {}) };
    const grantSize = Buffer.byteLength(JSON.stringify({ version: 1, generation, endpoint, pid: Number.MAX_SAFE_INTEGER,
      ownerIdentity, nonce: "0".repeat(36), agentEnv })) + 1;
    if (grantSize > MAX_BROKER_ADMISSION_RECORD_BYTES) throw brokerAdmissionError("broker child authorization is too large.");
    onPendingAttempt();
    appendBrokerAdmission(cwd, { event: "pending", generation, ownerPid: process.pid,
      platform: process.platform, lockToken: lock, endpoint, sessionDir, pidFile, logFile }, lock);
    context.check();
  }, { timeoutMs: brokerRemaining(deadline), strictWorkspace: true });
  const env = { ...(options.env ?? process.env), GROK_COMPANION_BROKER_GENERATION: generation };
  for (const key of ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"]) {
    if (process.env[key] === undefined) delete env[key]; else env[key] = process.env[key];
  }
  for (const key of ["TMPDIR", "TMP", "TEMP"]) env[key] = stateFallbackTempDir();
  return withStateSnapshot(cwd, (_state, context) => {
  if (process.platform === "linux" && context.epoch !== ownerIdentity.epoch) throw brokerAdmissionError("epoch changed before broker spawn.");
  requireNoLegacyAdmission(context);
  context.check();
  const child = spawnBrokerProcessWithin({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env,
    admissionPipe: true
  });
  // 数値 PID の再照会へ所有権を置き換えず、待機前にこの spawn の exit を観測する。
  const ownerDeadline = brokerScope.deadline;
  const mayStop = () => {
    if (process.platform !== "linux") return true;
    try { return verifyBrokerEpoch(cwd, ownerIdentity.epoch, { timeoutMs: Math.max(1, Math.min(750, ownerDeadline - performance.now())) }); }
    catch { return false; }
  };
  const stopOwnedPosixBroker = process.platform === "win32" ? null : createOwnedPosixBrokerStop(child, ownerDeadline, mayStop);
  const ownedPid = child.pid ?? null;
  let handleStopAttempted = false;
  const stopOnError = stopOwnedPosixBroker ?? (() => {
    if (!handleStopAttempted && performance.now() < ownerDeadline && child.exitCode == null && !child.signalCode) {
      handleStopAttempted = true;
      try { child.kill(); } catch { /* agent停止の証拠にはせずjournalを保持する。 */ }
    }
  });
  const prepared = { endpoint, pidFile, logFile, sessionDir, child, ownedPid, authMode, generation, epoch: ownerIdentity.epoch,
    stop: stopOwnedPosixBroker, stopOnError, readySettlementDurable: false };
  onOwned(prepared); // scope末尾の検証がthrowしても、所有するchild handleを外側に残す。
  let observerFailed = false, observerError;
  try {
    if (options.onBrokerSpawn) {
      const hookResult = options.onBrokerSpawn(child);
      if (hookResult && typeof hookResult.then === "function") {
        // 同期契約の拒否とは別に、返された Promise の未処理 rejection を防ぐ。
        void Promise.resolve(hookResult).catch(() => {});
        throw new TypeError("Broker spawn observation must be synchronous");
      }
    }
  } catch (error) {
    observerFailed = true;
    observerError = error;
  }
  // 通知失敗でも従来どおり spawned の記録を試みる。append 失敗は記録の不確定を優先する。
  appendBrokerAdmission(cwd, { event: "spawned", generation, pid: ownedPid,
    pgid: process.platform === "win32" ? null : ownedPid }, lock);
  if (observerFailed) throw observerError;
  if (!Number.isInteger(ownedPid) || ownedPid <= 0) {
    prepared.admissionChannel = /** @type {import("node:stream").Duplex | null} */ (child.stdio?.[3] ?? null);
    prepared.readyAck = Promise.resolve(false);
    return prepared;
  }
  if (!child.stdio?.[3]) throw brokerAdmissionError("cannot verify the spawned broker identity.");
  const admissionChannel = /** @type {import("node:stream").Duplex} */ (child.stdio[3]);
  const nonce = randomUUID();
  prepared.admissionChannel = admissionChannel;
  prepared.readyAck = new Promise(resolve => {
    let buffer = "", settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    admissionChannel.on("data", chunk => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > MAX_BROKER_ADMISSION_RECORD_BYTES) return finish(false);
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      if (end !== buffer.length - 1) return finish(false);
      try {
        const ack = JSON.parse(buffer.slice(0, end));
        finish(ack?.version === 1 && ack.event === "ready" && ack.generation === generation &&
          (process.platform !== "linux" || ack.epoch === ownerIdentity.epoch) &&
          ack.endpoint === endpoint && ack.pid === ownedPid && ack.nonce === nonce);
      } catch { finish(false); }
    });
    admissionChannel.once("error", () => finish(false));
    admissionChannel.once("end", () => finish(false));
    admissionChannel.once("close", () => finish(false));
    child.once("exit", () => finish(false));
  });
  admissionChannel.write(`${JSON.stringify({ version: 1, generation, endpoint, pid: ownedPid, ownerIdentity, nonce, agentEnv })}\n`);
  return prepared;
  }, { timeoutMs: brokerRemaining(deadline), strictWorkspace: true });
}

async function startBrokerSession(cwd, options, lock, control = {}) {
  const deadline = control.deadline ?? performance.now() + (options.timeoutMs ?? BROKER_START_TOTAL_TIMEOUT_MS);
  let owned = control.owned ?? null;
  try {
    const prepared = control.prepared ?? withBrokerStateScope(cwd,
      () => prepareBrokerStart(cwd, options, lock, value => { owned = value; }), deadline);
    if (prepared.current) return await readyBrokerSession(cwd, prepared.current, prepared.authMode, deadline, lock);
    const { endpoint, pidFile, logFile, sessionDir, child, ownedPid, authMode, generation, stop } = prepared;
    const remaining = brokerRemaining(deadline);
    // 通常のready 2000ms/停止1250msを保ち、最後のnative検査・settle・解放を予約する。
    // 明示の短予算では各phaseを縮め、未確認の停止をfallbackへ昇格させない。
    const finalizeReserve = Math.min(BROKER_START_FINALIZE_RESERVE_MS, remaining / 3);
    const stopReserve = stop ? Math.min(FAILED_BROKER_STOP_TIMEOUT_MS, (remaining - finalizeReserve) / 2) : 0;
    const readyBudget = Math.min(BROKER_READY_TIMEOUT_MS, remaining - finalizeReserve - stopReserve);
    const stopDeadline = deadline - finalizeReserve;
    const controller = new AbortController();
    const ownerExited = () => controller.abort();
    child.once("exit", ownerExited);
    child.once("error", ownerExited);
    if (child.exitCode != null || child.signalCode) controller.abort();
    let ready;
    try {
      const ack = new Promise(resolve => {
        const timer = setTimeout(() => finish(false), readyBudget);
        const aborted = () => finish(false);
        const finish = value => { clearTimeout(timer); controller.signal.removeEventListener("abort", aborted); resolve(value); };
        controller.signal.addEventListener("abort", aborted, { once: true });
        if (controller.signal.aborted) return finish(false);
        prepared.readyAck.then(finish, () => finish(false));
      });
      const [endpointReady, ackReady] = await Promise.all([waitForBrokerEndpoint(endpoint, readyBudget, { signal: controller.signal }), ack]);
      ready = endpointReady && ackReady;
    } finally {
      child.removeListener("exit", ownerExited);
      child.removeListener("error", ownerExited);
      controller.abort(); // 負けたsocket/timerも残さない。
      prepared.admissionChannel?.destroy();
    }
    if (!ready) {
      if (!stop) {
        // Windowsは所有child handleだけを停止し、数値PID再照会を停止権限へ昇格させない。
        // そのhandleの終了は配下agent/Jobの停止証明ではないのでadmissionを保留する。
        await prepared.stopOnError();
        throw new Error(`Failed shared Grok broker termination is unconfirmed. Admission remains pending. Log: ${logFile}`);
      }
      if (stop && !(await stop(stopDeadline))) {
        // 子の終了を確認できない時は記録を消さず、別agentを直接起動して成功扱いしない。
        throw new Error(`Could not confirm that the failed shared Grok broker stopped. Log: ${logFile}`);
      }
      return withBrokerStateScope(cwd, () => withBrokerRecoverySnapshot(cwd, prepared.epoch, deadline, () => {
        // 起動失敗の診断logと、停止を確認できないadmissionは保持する。
        // POSIXでは失敗した起動のpathnameも別のentryへ交換され得るため保持する。
        if (process.platform === "win32") teardownBrokerSession({
          endpoint, pidFile, logFile, sessionDir,
          pid: null,
          killProcess: null,
          keepLog: true,
          beforeChange: () => requireBrokerStateMigration(cwd)
        });
        appendBrokerAdmission(cwd, { event: "settled", generation, pid: ownedPid, outcome: "stopped" }, lock);
        appendBrokerAdmission(cwd, { event: "confirmed", generation, pid: ownedPid, outcome: "stopped" }, lock);
        process.stderr.write(`Shared Grok broker did not start; falling back to a direct run. Log: ${logFile}\n`);
        control.finish?.();
        return null;
      }), deadline, null, prepared.epoch);
    }

    return withBrokerStateScope(cwd, () => withBrokerRecoverySnapshot(cwd, prepared.epoch, deadline, () => {
      const session = {
        endpoint, pidFile, logFile, sessionDir,
        pid: child.pid ?? null, authMode, generation,
        ...(process.platform === "linux" ? { epoch: prepared.epoch } : {}),
        ownerPlatform: process.platform,
        ...(process.platform === "win32" ? {} : { ownedGroup: { pgid: ownedPid, generation, platform: process.platform } })
      };
      saveBrokerSessionWithin(cwd, session, lock);
      syncSavedBrokerSession(cwd);
      appendBrokerAdmission(cwd, { event: "settled", generation, pid: ownedPid, outcome: "ready" }, lock);
      // 同一token下でsettledのwrite/fsync/close/必要dir同期が戻った経路だけが確認行を書く。
      // ここからは完全confirmedを他callerが採用し得るため、後段失敗でready ownerを停止しない。
      prepared.readySettlementDurable = true;
      appendBrokerAdmission(cwd, { event: "confirmed", generation, pid: ownedPid, outcome: "ready" }, lock);
      control.finish?.();
      return session;
    }), deadline, null, prepared.epoch);
  } catch (error) {
    if (owned?.stopOnError && !owned.readySettlementDurable) await owned.stopOnError();
    throw error;
  }
}

export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  killProcess = null,
  keepLog = false,
  beforeChange = null
}) {
  if (Number.isFinite(pid) && killProcess && processCommandContains(pid, "acp-broker.mjs")) {
    try {
      beforeChange?.();
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    beforeChange?.();
    fs.unlinkSync(pidFile);
  }

  if (!keepLog && logFile && fs.existsSync(logFile)) {
    beforeChange?.();
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        beforeChange?.();
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      beforeChange?.();
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
