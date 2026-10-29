import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { fdMountId } from "./linux-epoch-recovery.mjs";

export const sentinelScript = fileURLToPath(import.meta.url);
const readyName = "sentinel-ready.json";
const historyRootOption = "--history-root-lock-fd=7";
const historyRootEnv = "GROK_SENTINEL_HISTORY_ROOT_LOCK";
const historyDeadlineOption = "--history-deadline-ns=";
const historyDeadlineEnv = "GROK_SENTINEL_HISTORY_DEADLINE_NS";
const address = nonce => `\0grok-state-lock-${nonce}`;

function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function same(a, b) { return !!a && !!b && a.dev === b.dev && a.ino === b.ino; }
function parseHistoryDeadline(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) throw new Error("invalid Linux sentinel history deadline");
  const deadline = BigInt(value);
  if (deadline > 18446744073709551615n) throw new Error("invalid Linux sentinel history deadline");
  return deadline;
}
function checkHistoryDeadline(deadline) {
  if (deadline !== null && process.hrtime.bigint() >= deadline) throw new Error("Linux sentinel history deadline expired");
}
function deadlineTimeout(deadline, maximumMs) {
  checkHistoryDeadline(deadline);
  if (deadline === null) return maximumMs;
  const remaining = deadline - process.hrtime.bigint();
  if (remaining <= 0n) throw new Error("Linux sentinel history deadline expired");
  return Math.max(1, Math.min(maximumMs, Number((remaining + 999999n) / 1000000n)));
}
function verifyNamedHistoryRoot(stateDir, expected, mount, deadline = null) {
  checkHistoryDeadline(deadline);
  const namedFd = fs.openSync(stateDir, checkedOpenFlags(true));
  try {
    const opened = fs.fstatSync(namedFd, { bigint: true });
    if (!opened.isDirectory() || opened.uid !== BigInt(process.getuid()) || (opened.mode & 0o077n) !== 0n ||
        !same(identity(opened), expected) || !same(identity(checked(stateDir, true)), expected) || fdMountId(namedFd) !== mount) {
      throw new Error("Linux sentinel named history root identity or mount differs");
    }
    checkHistoryDeadline(deadline);
  } finally { fs.closeSync(namedFd); }
}
function verifyHistoryRootLock(fd, stateDir, expected, mount, deadline = null) {
  checkHistoryDeadline(deadline);
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n ||
      !same(identity(stat), expected) || !same(identity(checked(stateDir, true)), expected) || fdMountId(fd) !== mount) {
    throw new Error("Linux sentinel history root lock identity or mount differs");
  }
  verifyNamedHistoryRoot(stateDir, expected, mount, deadline);
  try {
    // 同一 open-file-description なら lock を維持し、別 description の場合は
    // 既存 owner と競合する。無保護で書込みを進めない。
    const timeout = deadlineTimeout(deadline, 3000);
    execFileSync("/usr/bin/flock", ["-x", "-n", "3"], { stdio: ["ignore", "ignore", "pipe", fd], timeout });
  } catch (error) { throw new Error("Linux sentinel history root lock is unavailable", { cause: error }); }
  checkHistoryDeadline(deadline);
  const after = fs.fstatSync(fd, { bigint: true });
  if (!same(identity(after), expected) || !same(identity(checked(stateDir, true)), expected) || fdMountId(fd) !== mount) {
    throw new Error("Linux sentinel history root changed while checking the lock");
  }
  verifyNamedHistoryRoot(stateDir, expected, mount, deadline);
}
function checked(target, directory = false) {
  const stat = fs.lstatSync(target, { bigint: true });
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || stat.uid !== BigInt(process.getuid())
      || (stat.mode & 0o077n) !== 0n || stat.ino <= 0n || stat.dev <= 0n) throw new Error(`Linux sentinel state identity is invalid: ${target}`);
  return stat;
}
function checkedOpenFlags(directory = false) {
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW, O_DIRECTORY } = fs.constants;
  if (!Number.isInteger(O_NONBLOCK) || O_NONBLOCK <= 0 || !Number.isInteger(O_NOFOLLOW) || O_NOFOLLOW <= 0
      || (directory && (!Number.isInteger(O_DIRECTORY) || O_DIRECTORY <= 0))) {
    throw new Error("Linux sentinel requires nonblocking and no-follow open support");
  }
  return O_RDONLY | O_NONBLOCK | O_NOFOLLOW | (directory ? O_DIRECTORY : 0);
}
function syncFileDescriptor(fd, stage) {
  try { fs.fsyncSync(fd); }
  catch (error) { throw new Error(`Linux sentinel ${stage} fsync failed`, { cause: error }); }
}
function fsyncDiagnostic(error) {
  const match = /^Linux sentinel (marker|ready|directory) fsync failed$/.exec(error?.message ?? "");
  if (!match) return null;
  const code = error.cause?.code;
  return `GROK_SENTINEL_FSYNC:${match[1]}:${typeof code === "string" && /^[A-Z][A-Z0-9_]{0,15}$/.test(code) ? code : "UNKNOWN"}`;
}
function reportFsyncFailure(error) {
  const line = fsyncDiagnostic(error);
  if (line) try { fs.writeSync(2, `${line}\n`); } catch { /* 診断不能時も失敗を維持する。 */ }
}
function syncDirectory(target, expected, deadline = null) {
  if (!same(identity(checked(target, true)), expected)) throw new Error("Linux sentinel directory identity changed");
  const fd = fs.openSync(target, checkedOpenFlags(true));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || !same(identity(opened), expected)) throw new Error("Linux sentinel directory changed during sync");
    checkHistoryDeadline(deadline);
    syncFileDescriptor(fd, "directory");
    checkHistoryDeadline(deadline);
    if (!same(identity(checked(target, true)), expected)) throw new Error("Linux sentinel directory changed after sync");
  } finally { fs.closeSync(fd); }
}
function processStat(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const match = text.match(/^([1-9]\d*) \((.*)\) ([A-Za-z]) (.*)$/s);
  if (!match || match[1] !== String(pid)) throw new Error("Linux sentinel process stat is invalid");
  const fields = match[4].trim().split(/\s+/);
  const startTick = fields[18];
  if (!/^[1-9]\d*$/.test(startTick ?? "") || ["Z", "X", "x"].includes(match[3])) throw new Error("Linux sentinel is not alive");
  return startTick;
}
function pinnedProcessStat(sentinel, fd) {
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("Linux sentinel process descriptor is invalid");
  // procfs の stat は seek 可能な seq_file。毎回 offset 0 から取得し、EOF を再利用しない。
  const buffer = Buffer.allocUnsafe(65536);
  const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
  if (count <= 0 || count === buffer.length || buffer[count - 1] !== 0x0a) {
    throw new Error("Linux sentinel process stat length is invalid");
  }
  const match = buffer.toString("utf8", 0, count).match(/^([1-9]\d*) \((.*)\) ([A-Za-z]) (.*)$/s);
  if (!match || match[1] !== String(sentinel.pid)) throw new Error("Linux sentinel process stat is invalid");
  const startTick = match[4].trim().split(/\s+/)[18];
  if (!/^[1-9]\d*$/.test(startTick ?? "") || startTick !== sentinel.startTick) {
    throw new Error("Linux sentinel process start time is invalid");
  }
  return match[3];
}
export function openLinuxSentinelProcess(sentinel) {
  const fd = fs.openSync(`/proc/${sentinel.pid}/stat`, checkedOpenFlags());
  try {
    if (["Z", "X", "x"].includes(pinnedProcessStat(sentinel, fd))) throw new Error("Linux sentinel is not alive");
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
export function linuxSentinelExited(sentinel, fd) {
  try { return ["Z", "X", "x"].includes(pinnedProcessStat(sentinel, fd)); }
  catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}
function expectedArgs(executable, lockDir, sentinel) {
  return [executable, sentinelScript, "sentinel", lockDir, sentinel.generation, sentinel.nonce];
}

// 絶対 symlink を呼出元の root へ逃がさず、sentinel の root view 内で解決する。
function resolveSentinelExecutable(prefix, executable) {
  if (!path.isAbsolute(executable)) throw new Error("sentinel executable path is not absolute");
  const pending = executable.split("/"), resolved = [];
  let links = 0, steps = 0;
  while (pending.length) {
    if (++steps > 4096) throw new Error("sentinel executable path is too complex");
    const component = pending.shift();
    if (!component || component === ".") continue;
    if (component === "..") { resolved.pop(); continue; }
    const candidate = `${prefix}/root/${[...resolved, component].join("/")}`;
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (stat.isSymbolicLink()) {
      if (++links > 40) throw new Error("sentinel executable has too many symbolic links");
      const target = fs.readlinkSync(candidate);
      if (!target) throw new Error("sentinel executable symbolic link is empty");
      if (target.startsWith("/")) resolved.length = 0;
      pending.unshift(...target.split("/"));
    } else {
      if (pending.length && !stat.isDirectory()) throw new Error("sentinel executable path contains a non-directory");
      resolved.push(component);
    }
  }
  if (!resolved.length) throw new Error("sentinel executable path is invalid");
  return `${prefix}/root/${resolved.join("/")}`;
}

function sentinelExecutableIdentity(prefix, executable) {
  const root = fs.statSync(`${prefix}/root`, { bigint: true });
  const mountNamespace = fs.readlinkSync(`${prefix}/ns/mnt`);
  if (!root.isDirectory() || root.dev <= 0n || root.ino <= 0n || !/^mnt:\[[1-9]\d*\]$/.test(mountNamespace)) {
    throw new Error("sentinel root or mount namespace identity is invalid");
  }
  const named = fs.statSync(resolveSentinelExecutable(prefix, executable), { bigint: true });
  const running = fs.statSync(`${prefix}/exe`, { bigint: true });
  if (!named.isFile() || !running.isFile() || named.dev <= 0n || named.ino <= 0n ||
      running.dev <= 0n || running.ino <= 0n || !same(identity(named), identity(running))) {
    throw new Error("sentinel executable identity differs");
  }
  return { executable: identity(running), root: identity(root), mountNamespace };
}
export function verifyLinuxSentinel(lockDir, marker, scope, mount) {
  try {
    const s = marker?.sentinel;
    if (!s || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s.generation)
        || !/^[a-f0-9]{32}$/.test(s.nonce) || !Number.isSafeInteger(s.pid) || s.pid <= 0
        || !/^[1-9]\d*$/.test(s.startTick)) throw new Error("invalid sentinel marker");
    const requiresBarrierFd = Object.hasOwn(s, "barrierFd");
    if (requiresBarrierFd && s.barrierFd !== 3) throw new Error("invalid sentinel barrier descriptor marker");
    const readyPath = path.join(lockDir, readyName);
    const before = checked(readyPath);
    const readyIdentity = identity(before);
    const fd = fs.openSync(readyPath, checkedOpenFlags());
    try {
      if (fdMountId(fd) !== mount) throw new Error("Linux sentinel ready crosses a mount boundary");
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || !same(identity(before), identity(opened))) throw new Error("ready identity changed");
      const ready = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (ready.generation !== s.generation || ready.nonce !== s.nonce || ready.pid !== s.pid || ready.startTick !== s.startTick
          || !same(identity(checked(readyPath)), identity(before))) throw new Error("ready identity is invalid");
    } finally { fs.closeSync(fd); }
    const prefix = `/proc/${s.pid}`;
    const status = fs.readFileSync(`${prefix}/status`, "utf8");
    const nspid = status.split("\n").filter(line => line.startsWith("NSpid:"));
    const match = nspid.length === 1 ? nspid[0].match(/^NSpid:[\t ]+([1-9]\d*)[\t ]*\r?$/) : null;
    const states = status.split("\n").filter(line => line.startsWith("State:"));
    const state = states.length === 1 ? states[0].match(/^State:[\t ]+([A-Za-z])(?:[\t ]|$)/) : null;
    if (!match || match[1] !== String(s.pid) || !state || ["Z", "X", "x"].includes(state[1])
        || fs.readlinkSync(`${prefix}/ns/pid`) !== scope.pidNamespace
        || fs.readlinkSync(`${prefix}/ns/time`) !== scope.timeNamespace
        || fs.readlinkSync(`${prefix}/ns/net`) !== scope.netNamespace
        || processStat(s.pid) !== s.startTick) throw new Error("sentinel process identity differs");
    // 書込み FD は O_WRONLY。sentinel は fsync 完了後にだけ O_RDONLY の FD を保持する。
    let readyHeld = false;
    for (const name of fs.readdirSync(`${prefix}/fd`)) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.statSync(`${prefix}/fd/${name}`, { bigint: true });
        if (!same(identity(stat), readyIdentity)) continue;
        const info = fs.readFileSync(`${prefix}/fdinfo/${name}`, "utf8");
        const flags = info.match(/^flags:\s*([0-7]+)\s*$/m);
        if (!flags) throw new Error("sentinel ready descriptor flags are unavailable");
        if ((BigInt(`0o${flags[1]}`) & 3n) === 0n) readyHeld = true;
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ESRCH") throw error;
      }
    }
    if (!readyHeld) throw new Error("sentinel ready descriptor is unavailable");
    const actual = fs.readFileSync(`${prefix}/cmdline`);
    const args = actual.toString("utf8").split("\0");
    if (args.length !== 7 || args[6] !== "" || !Buffer.from(args.join("\0")).equals(actual)
        || !path.isAbsolute(args[0]) || !path.isAbsolute(args[3])) throw new Error("sentinel command is invalid");
    const executableIdentity = sentinelExecutableIdentity(prefix, args[0]);
    const expected = Buffer.from(`${expectedArgs(args[0], args[3], s).join("\0")}\0`);
    if (!actual.equals(expected) || !same(identity(checked(lockDir, true)), marker.barrierIdentity)) {
      throw new Error("sentinel command or barrier identity differs");
    }
    // 新 marker は barrier FD の保持を必須とする。旧 marker は FD 3 の用途を
    // 規定していないため、従来の argv パス照合だけを使う。
    if (requiresBarrierFd) {
      const heldBarrier = fs.statSync(`${prefix}/fd/3`, { bigint: true });
      if (!heldBarrier.isDirectory() || !same(identity(heldBarrier), marker.barrierIdentity)) {
        throw new Error("sentinel held barrier identity differs or is invalid");
      }
    } else if (!same(identity(checked(args[3], true)), marker.barrierIdentity)) {
      throw new Error("legacy sentinel barrier identity differs");
    }
    const executableAfter = sentinelExecutableIdentity(prefix, args[0]);
    if (!same(executableAfter.executable, executableIdentity.executable) ||
        !same(executableAfter.root, executableIdentity.root) ||
        executableAfter.mountNamespace !== executableIdentity.mountNamespace ||
        !fs.readFileSync(`${prefix}/cmdline`).equals(actual) ||
        fs.readlinkSync(`${prefix}/ns/pid`) !== scope.pidNamespace ||
        fs.readlinkSync(`${prefix}/ns/time`) !== scope.timeNamespace ||
        fs.readlinkSync(`${prefix}/ns/net`) !== scope.netNamespace ||
        processStat(s.pid) !== s.startTick) throw new Error("sentinel process identity differs");
    return s;
  } catch (error) {
    if (/mount/i.test(error?.message ?? "")) throw new Error("Linux state sentinel mount inspection failed", { cause: error });
    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw new Error(`Linux state sentinel inspection denied (${error.code}); verify state and /proc permissions`, { cause: error });
    }
    throw new Error("Linux state sentinel is unavailable or invalid; offline recovery is required", { cause: error });
  }
}

async function runSentinel(lockDir, generation, nonce) {
  const rootFlag = process.env[historyRootEnv];
  if (rootFlag !== undefined && rootFlag !== nonce) throw new Error("invalid Linux sentinel history root flag");
  const inheritedRoot = rootFlag !== undefined;
  const rawDeadline = process.env[historyDeadlineEnv];
  let historyDeadline = null;
  if (rawDeadline !== undefined) {
    const prefix = `${nonce}:`;
    if (!inheritedRoot || !rawDeadline.startsWith(prefix)) throw new Error("invalid Linux sentinel history deadline flag");
    historyDeadline = parseHistoryDeadline(rawDeadline.slice(prefix.length));
    checkHistoryDeadline(historyDeadline);
  }
  const barrier = identity(fs.fstatSync(3, { bigint: true }));
  if (!same(barrier, identity(checked(lockDir, true)))) throw new Error("sentinel barrier identity changed");
  const mount = fdMountId(3);
  const stateDir = path.dirname(lockDir);
  const rootIdentity = inheritedRoot ? identity(checked(stateDir, true)) : null;
  if (inheritedRoot) verifyHistoryRootLock(4, stateDir, rootIdentity, mount, historyDeadline);
  const anchoredLockDir = "/proc/self/fd/3/.";
  let input = "";
  let committed = false;
  let readyPublished = false;
  const localReadyDeadline = process.hrtime.bigint() + 5000000000n;
  const readyDeadline = historyDeadline !== null && historyDeadline < localReadyDeadline ? historyDeadline : localReadyDeadline;
  const timer = setTimeout(() => { if (!readyPublished) process.exit(1); }, deadlineTimeout(readyDeadline, 5000));
  process.stdout.on("error", () => {});
  process.stdin.setEncoding("utf8");
  process.stdin.on("end", () => { if (!committed) process.exit(1); });
  process.stdin.on("data", data => {
    if (committed) return;
    input += data;
    const expected = `commit:${nonce}`;
    if (!expected.startsWith(input)) process.exit(1);
    if (input !== expected) return;
    try { checkHistoryDeadline(readyDeadline); } catch { process.exit(1); }
    committed = true;
    const server = net.createServer(socket => {
      let request = "";
      socket.setTimeout(2000, () => socket.destroy());
      socket.on("error", () => {});
      socket.on("data", data => {
        request += data;
        if (request.length > 128) return socket.destroy();
        if (!request.endsWith("\n")) return;
        if (request !== `stop:${generation}:${nonce}\n`) return socket.end("denied\n");
        socket.end("stopped\n", () => server.close(() => process.exit(0)));
      });
    });
    server.on("error", () => process.exit(1));
    server.listen(address(nonce), () => {
      try {
        checkHistoryDeadline(readyDeadline);
        const startTick = processStat(process.pid);
        checkHistoryDeadline(readyDeadline);
        const readyPath = path.join(anchoredLockDir, readyName);
        const fd = fs.openSync(readyPath, "wx", 0o600);
        try {
          if (fdMountId(fd) !== mount) throw new Error("sentinel ready crosses a mount boundary");
          checkHistoryDeadline(readyDeadline);
          fs.writeFileSync(fd, `${JSON.stringify({ generation, nonce, pid: process.pid, startTick })}\n`);
          checkHistoryDeadline(readyDeadline);
          syncFileDescriptor(fd, "ready");
        } finally { fs.closeSync(fd); }
        checkHistoryDeadline(readyDeadline);
        syncDirectory(anchoredLockDir, barrier, readyDeadline);
        const expectedReady = identity(checked(readyPath));
        checkHistoryDeadline(readyDeadline);
        if (inheritedRoot) {
          verifyHistoryRootLock(4, stateDir, rootIdentity, mount, readyDeadline);
          checkHistoryDeadline(readyDeadline);
          // 保護された書込みと root の検証を済ませてから、長寿命の FD を公開する。
          fs.closeSync(4);
          checkHistoryDeadline(readyDeadline);
        }
        const readyFd = fs.openSync(readyPath, checkedOpenFlags());
        try {
          if (fdMountId(readyFd) !== mount) throw new Error("sentinel ready crosses a mount boundary");
          const openedReady = fs.fstatSync(readyFd, { bigint: true });
          if (!openedReady.isFile() || !same(identity(openedReady), expectedReady)
              || !same(identity(checked(readyPath)), expectedReady)) throw new Error("sentinel ready descriptor identity changed");
        } catch (error) { fs.closeSync(readyFd); throw error; }
        checkHistoryDeadline(readyDeadline);
        readyPublished = true;
        clearTimeout(timer);
        process.stdout.write("ready\n");
      } catch (error) {
        const diagnostic = fsyncDiagnostic(error);
        if (diagnostic) process.stdout.write(`${diagnostic}\n`, () => process.exit(1));
        else process.exit(1);
      }
    });
  });
  process.stdout.write("started\n");
}

async function runBootstrap(stateDir, lockDir, prepared, encoded, rootOption, deadlineOption, ...unexpected) {
  if (unexpected.length || (rootOption !== undefined && rootOption !== historyRootOption)) throw new Error("invalid Linux sentinel history root option");
  let historyDeadline = null;
  if (deadlineOption !== undefined) {
    if (rootOption !== historyRootOption || typeof deadlineOption !== "string" || !deadlineOption.startsWith(historyDeadlineOption)) {
      throw new Error("invalid Linux sentinel history deadline option");
    }
    historyDeadline = parseHistoryDeadline(deadlineOption.slice(historyDeadlineOption.length));
    checkHistoryDeadline(historyDeadline);
  }
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const { generation, nonce } = payload.sentinel;
  const mount = fdMountId(6);
  if (fdMountId(5) !== mount || fdMountId(3) !== mount || fdMountId(4) !== mount) throw new Error("sentinel bootstrap crosses a mount boundary");
  const inheritedRoot = rootOption === historyRootOption;
  if (inheritedRoot) {
    if (!same(identity(fs.fstatSync(6, { bigint: true })), payload.directoryIdentity)) throw new Error("Linux sentinel root identity differs");
    verifyHistoryRootLock(7, stateDir, payload.directoryIdentity, mount, historyDeadline);
  }
  const anchoredLockDir = "/proc/self/fd/5/.";
  const anchoredPrepared = path.join(anchoredLockDir, path.basename(prepared));
  const childEnv = { ...process.env };
  delete childEnv[historyRootEnv];
  delete childEnv[historyDeadlineEnv];
  if (inheritedRoot) childEnv[historyRootEnv] = nonce;
  if (historyDeadline !== null) childEnv[historyDeadlineEnv] = `${nonce}:${historyDeadline}`;
  deadlineTimeout(historyDeadline, 6500);
  const child = spawn(process.execPath, [sentinelScript, "sentinel", lockDir, generation, nonce], {
    detached: true, env: childEnv, stdio: inheritedRoot ? ["pipe", "pipe", "ignore", 5, 7] : ["pipe", "pipe", "ignore", 5]
  });
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  let buffer = "";
  let committed = false;
  let timeout;
  try { timeout = deadlineTimeout(historyDeadline, 6500); } catch { child.stdin.destroy(); process.exit(1); }
  const deadline = setTimeout(() => { child.stdin.destroy(); process.exit(1); }, timeout);
  child.on("error", () => process.exit(1));
  child.on("exit", () => { if (!committed) process.exit(1); });
  child.stdout.on("data", data => {
    buffer += data;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        checkHistoryDeadline(historyDeadline);
        if (line === "started") {
          if (!same(identity(fs.fstatSync(3, { bigint: true })), payload.lockIdentity)
              || !same(identity(fs.fstatSync(4, { bigint: true })), payload.markerIdentity)
              || !same(identity(fs.fstatSync(5, { bigint: true })), payload.barrierIdentity)
              || !same(identity(fs.fstatSync(6, { bigint: true })), payload.directoryIdentity)
              || !same(identity(checked(stateDir, true)), payload.directoryIdentity)
              || !same(identity(checked(lockDir, true)), payload.barrierIdentity)
              || !same(identity(checked(anchoredPrepared)), payload.markerIdentity)) throw new Error("migration identity changed");
          payload.sentinel.pid = child.pid;
          payload.sentinel.startTick = processStat(child.pid);
          checkHistoryDeadline(historyDeadline);
          fs.writeFileSync(4, `${JSON.stringify(payload)}\n`);
          checkHistoryDeadline(historyDeadline);
          syncFileDescriptor(4, "marker");
          checkHistoryDeadline(historyDeadline);
          fs.linkSync(anchoredPrepared, path.join(anchoredLockDir, "protocol.json"));
          checkHistoryDeadline(historyDeadline);
          syncDirectory(anchoredLockDir, payload.barrierIdentity, historyDeadline);
          checkHistoryDeadline(historyDeadline);
          child.stdin.write(`commit:${nonce}`, error => { if (error) process.exit(1); committed = true; });
        } else if (line === "ready") {
          clearTimeout(deadline);
          child.stdout.destroy();
          child.stdin.end();
          child.unref();
          process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(0));
        } else if (/^GROK_SENTINEL_FSYNC:(?:ready|directory):(?:[A-Z][A-Z0-9_]{0,15}|UNKNOWN)$/.test(line)) {
          try { fs.writeSync(2, `${line}\n`); } catch { /* 診断不能時も失敗を維持する。 */ }
          child.stdin.destroy();
          process.exit(1);
        } else throw new Error("unexpected sentinel response");
      } catch (error) { child.stdin.destroy(); reportFsyncFailure(error); process.exit(1); }
    }
  });
}

async function runStop(generation, nonce) {
  await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const socket = net.connect(address(nonce));
    let response = "";
    socket.setTimeout(2500, () => socket.destroy(new Error("sentinel stop timed out")));
    socket.on("connect", () => socket.write(`stop:${generation}:${nonce}\n`));
    socket.on("data", data => { response += data; });
    socket.on("end", () => response === "stopped\n" ? resolve() : reject(new Error("sentinel rejected stop")));
    socket.on("error", reject);
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === sentinelScript) {
  const [role, ...args] = process.argv.slice(2);
  try {
    if (role === "sentinel") await runSentinel(...args);
    else if (role === "bootstrap") await runBootstrap(...args);
    else if (role === "stop") await runStop(...args);
    else throw new Error("unknown Linux sentinel operation");
  } catch { process.exitCode = 1; }
}
