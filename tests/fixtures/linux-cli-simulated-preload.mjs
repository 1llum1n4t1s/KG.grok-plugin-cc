// Mac の実 Node 子と lockf を使用する Linux CLI 統合模擬。procfs、mount、
// PID start tick、sentinel FD 観測、abstract socket は fixture 値であり、
// Linux kernel の flock・namespace・寿命・durability を実証しない。
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

if (process.platform !== "darwin") throw new Error("Linux CLI simulation requires macOS");
const root = process.env.GROK_LINUX_SIM_ROOT;
const stateDir = process.env.GROK_LINUX_SIM_STATE_DIR;
if (!root || !path.isAbsolute(root) || fs.realpathSync(root) !== root || !stateDir ||
    !path.isAbsolute(stateDir) || !stateDir.startsWith(`${root}${path.sep}`)) {
  throw new Error("Linux CLI simulation requires an isolated fixture root");
}
const registry = path.join(root, "processes");
const real = Object.fromEntries(["openSync", "closeSync", "readFileSync", "readlinkSync", "statSync", "lstatSync",
  "readdirSync", "opendirSync", "mkdirSync", "linkSync", "renameSync", "unlinkSync", "writeFileSync", "readSync", "writeSync", "fsyncSync", "statfsSync"].map(key => [key, fs[key]]));
const processRegistry = path.join(registry, `${process.pid}.json`);
// 実 Mac では同時に同じ PID を持つ process は存在しない。前回死亡した
// fixture marker は別 inode に原子的に置換し、pin 中の旧 FD と区別する。
try {
  const old = real.lstatSync(processRegistry, { bigint: true });
  if (!old.isFile() || old.isSymbolicLink() || old.uid !== BigInt(process.getuid()) || (old.mode & 0o077n) !== 0n || old.nlink !== 1n) {
    throw new Error("old process fixture marker is invalid");
  }
} catch (error) { if (error?.code !== "ENOENT") throw error; }
const freshRegistry = path.join(registry, `${process.pid}.${randomUUID()}.new`);
real.writeFileSync(freshRegistry, JSON.stringify({ argv: [process.execPath, ...process.argv.slice(1)] }), { flag: "wx", mode: 0o600 });
real.renameSync(freshRegistry, processRegistry);
Object.defineProperty(process, "platform", { value: "linux" });
// 障害試験だけで AggregateError の各原因末尾を出す。製品の例外処理は変更しない。
if (process.env.GROK_LINUX_SIM_AGGREGATE_DIAGNOSTIC === "1") {
  const NativeAggregateError = globalThis.AggregateError;
  globalThis.AggregateError = class extends NativeAggregateError {
    constructor(errors, message, options) {
      const causes = Array.from(errors);
      super(causes, message, options);
      const summary = causes.map((error, index) => `${index}: ${String(error?.message ?? error).slice(-600)}`).join("\n");
      real.writeSync(2, `[fixture aggregate causes]\n${summary}\n`);
    }
  };
}
if (process.env.GROK_LINUX_SIM_HOLD_OUTPUT === "1" && process.argv[1]?.endsWith("grok-companion.mjs") && process.argv[2] === "task") {
  const release = path.join(root, "release-worker");
  const timer = setInterval(() => { if (fs.existsSync(release)) clearInterval(timer); }, 20);
}
// 既に終了した fixture worker の PID/tick が別個体に再利用された観測を作る。
// 実プロセスへの signal は送らず、存在照会だけを模擬する。
const realKill = process.kill.bind(process);
const reusedPid = Number(process.env.GROK_LINUX_SIM_REUSED_PID);
if (Number.isSafeInteger(reusedPid) && reusedPid > 0) {
  process.kill = (pid, signal) => {
    if (pid === reusedPid) {
      if (signal === 0) return true;
      throw new Error("fixture refuses a signal to a simulated reused PID");
    }
    return realKill(pid, signal);
  };
}

const opened = new Map();
const pinnedStats = new Map();
const fault = process.env.GROK_LINUX_SIM_RECORD_FAULT;
const faultMarker = path.join(root, "record-fault-injected");
const renamed = new Set();
let fired = false;
function recordKind(value) {
  const actual = anchored(typeof value === "number" ? opened.get(value) : value);
  if (typeof actual !== "string") return null;
  if (path.dirname(actual) === stateDir && path.basename(actual).startsWith("state.json")) return "index";
  if (path.dirname(actual) === path.join(stateDir, "jobs") && /\.json(?:\.|$)/.test(path.basename(actual))) return "detail";
  return null;
}
function trigger(label) {
  if (fired || fault !== label) return false;
  fired = true;
  real.writeFileSync(faultMarker, label, { flag: "wx", mode: 0o600 });
  return true;
}
function ioFailure() { throw Object.assign(new Error("fixture injected record I/O failure"), { code: "EIO" }); }
const script = process.argv[1] ?? "";
if (script.endsWith("linux-state-sentinel.mjs")) {
  if (process.argv[2] === "bootstrap") {
    opened.set(3, path.join(process.argv[4], "native.lock"));
    opened.set(4, process.argv[5]);
    opened.set(5, process.argv[4]);
    opened.set(6, process.argv[3]);
  } else if (process.argv[2] === "sentinel") opened.set(3, process.argv[3]);
}
function anchored(value) {
  if (typeof value !== "string") return value;
  const match = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(value);
  if (!match) return value;
  const base = opened.get(Number(match[1]));
  if (!base) throw Object.assign(new Error("fixture descriptor is unavailable"), { code: "ENOENT" });
  return path.join(base, match[2] ?? "");
}
function live(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
function entry(pid) {
  if (!live(pid)) throw Object.assign(new Error("fixture process exited"), { code: "ENOENT" });
  return JSON.parse(real.readFileSync(path.join(registry, `${pid}.json`), "utf8"));
}
function output(value, options) {
  return typeof options === "string" || options?.encoding ? value : Buffer.from(value);
}
fs.openSync = function (target, ...options) {
  const procStat = typeof target === "string" && /^\/proc\/(\d+)\/stat$/.exec(target);
  if (procStat) {
    const pid = Number(procStat[1]);
    entry(pid);
    const fd = real.openSync.call(this, path.join(registry, `${pid}.json`), ...options);
    pinnedStats.set(fd, pid);
    return fd;
  }
  const actual = anchored(target), fd = real.openSync.call(this, actual, ...options);
  if (typeof actual === "string") opened.set(fd, actual);
  return fd;
};
fs.closeSync = function (fd) { opened.delete(fd); pinnedStats.delete(fd); return real.closeSync.call(this, fd); };
fs.readSync = function (fd, buffer, offset, length, position) {
  if (pinnedStats.has(fd)) {
    const pid = pinnedStats.get(fd);
    try {
      const opened = fs.fstatSync(fd, { bigint: true }), named = real.lstatSync(path.join(registry, `${pid}.json`), { bigint: true });
      if (opened.dev !== named.dev || opened.ino !== named.ino) throw Object.assign(new Error("fixture process generation exited"), { code: "ESRCH" });
    } catch (error) {
      if (error?.code === "ENOENT") throw Object.assign(new Error("fixture process generation exited"), { code: "ESRCH" });
      throw error;
    }
    try { realKill(pid, 0); } catch (error) { if (error.code === "ESRCH") throw error; throw error; }
    const text = Buffer.from(`${pid} (fixture) S ${Array(19).fill("123456").join(" ")}\n`);
    return text.copy(buffer, offset, 0, Math.min(length, text.length));
  }
  return real.readSync.call(this, fd, buffer, offset, length, position);
};
for (const method of ["lstatSync", "opendirSync", "mkdirSync", "unlinkSync"]) {
  fs[method] = function (target, ...options) {
    const actual = anchored(target), failurePath = process.env.GROK_LINUX_SIM_LOG_FAILURE;
    if (method === "lstatSync" && failurePath && actual === failurePath) {
      if (!failurePath.startsWith(`${root}${path.sep}`)) throw new Error("log failure fixture is outside its root");
      throw new Error(`fixture long diagnostic: ${'🚨"\\\n'.repeat(6000)}`);
    }
    const result = real[method].call(this, actual, ...options);
    if (method === "mkdirSync" && process.env.GROK_LINUX_SIM_JOURNAL_CRASH === "1" && actual === path.join(stateDir, "history-journal-v1")) process.exit(74);
    return result;
  };
}
for (const method of ["linkSync", "renameSync"]) {
  fs[method] = function (from, to, ...options) {
    const actualTo = anchored(to);
    if (method === "linkSync" && process.env.GROK_LINUX_SIM_ABORT_MARKER === "1" && process.argv[2] === "bootstrap"
        && path.basename(actualTo) === "protocol.json") process.exit(71);
    const kind = recordKind(actualTo);
    if (kind && trigger(`${kind}-rename`)) ioFailure();
    const result = real[method].call(this, anchored(from), actualTo, ...options);
    if (kind && method === "renameSync") {
      renamed.add(kind);
      if (trigger(`${kind}-crash`)) process.exit(72);
    }
    return result;
  };
}
fs.writeFileSync = function (target, value, ...options) {
  const kind = recordKind(target);
  if (kind && trigger(`${kind}-partial-write`)) {
    const partial = Buffer.from(value).subarray(0, Math.max(1, Math.floor(Buffer.byteLength(value) / 2)));
    real.writeFileSync.call(this, anchored(target), partial, ...options);
    ioFailure();
  }
  return real.writeFileSync.call(this, anchored(target), value, ...options);
};
fs.writeSync = function (fd, value, ...options) {
  if (fd === 2 && process.env.GROK_LINUX_SIM_STDERR_FAILURE === "1" && Buffer.isBuffer(value) &&
      value.subarray(0, 64).toString("utf8").startsWith("[grok] Could not write cancellation log:")) {
    throw Object.assign(new Error("fixture stderr is closed"), { code: "EPIPE" });
  }
  const kind = recordKind(fd);
  if (kind && trigger(`${kind}-partial-write`)) {
    const partial = Buffer.from(value).subarray(0, Math.max(1, Math.floor(Buffer.byteLength(value) / 2)));
    real.writeSync.call(this, fd, partial, 0, partial.length);
    ioFailure();
  }
  return real.writeSync.call(this, fd, value, ...options);
};
fs.fsyncSync = function (fd) {
  const kind = recordKind(fd), actual = opened.get(fd);
  if (kind && actual?.endsWith(".tmp") && trigger(`${kind}-file-fsync`)) ioFailure();
  for (const candidate of ["index", "detail"]) {
    const directory = candidate === "index" ? stateDir : path.join(stateDir, "jobs");
    if (renamed.has(candidate) && actual === directory && trigger(`${candidate}-dir-fsync`)) ioFailure();
  }
  return real.fsyncSync.call(this, fd);
};
fs.statSync = function (target, ...options) {
  if (typeof target === "string") {
    const match = /^\/proc\/(\d+)\/fd\/(3|9)$/.exec(target);
    if (match) {
      const argv = entry(match[1]).argv;
      if (!argv[1]?.endsWith("linux-state-sentinel.mjs") || argv[2] !== "sentinel") throw Object.assign(new Error("fixture FD unavailable"), { code: "ENOENT" });
      return real.statSync.call(this, match[2] === "3" ? argv[3] : path.join(argv[3], "sentinel-ready.json"), ...options);
    }
  }
  return real.statSync.call(this, anchored(target), ...options);
};
fs.readdirSync = function (target, ...options) {
  const match = typeof target === "string" && /^\/proc\/(\d+)\/fd$/.exec(target);
  if (match) { entry(match[1]); return ["3", "9"]; }
  return real.readdirSync.call(this, anchored(target), ...options);
};
fs.readlinkSync = function (target, ...options) {
  const match = typeof target === "string" && /^\/proc\/(?:self|\d+)\/ns\/(pid|time|net)$/.exec(target);
  if (match) return `${match[1]}:[12345]`;
  return real.readlinkSync.call(this, anchored(target), ...options);
};
fs.statfsSync = function (target, ...options) { return { ...real.statfsSync.call(this, target, ...options), type: 0xef53 }; };
fs.readFileSync = function (target, options) {
  if (target === "/etc/machine-id") return output("0123456789abcdef0123456789abcdef\n", options);
  if (target === "/proc/sys/kernel/random/boot_id") return output("11111111-1111-4111-8111-111111111111\n", options);
  if (target === "/proc/self/mountinfo") {
    const dev = real.statSync(root, { bigint: true }).dev;
    const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
    const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
    return output(`41 1 ${major}:${minor} / / rw - ext4 fixture rw\n`, options);
  }
  if (typeof target === "string" && /^\/proc\/self\/fdinfo\/\d+$/.test(target)) {
    const actual = opened.get(Number(target.slice(target.lastIndexOf("/") + 1)));
    if (fault === "jobs-mount" && actual && (actual === path.join(stateDir, "jobs") || actual.startsWith(`${path.join(stateDir, "jobs")}${path.sep}`))) {
      trigger("jobs-mount");
      return output("mnt_id:\t42\n", options);
    }
    return output("mnt_id:\t41\n", options);
  }
  const info = typeof target === "string" && /^\/proc\/(\d+)\/fdinfo\/\d+$/.exec(target);
  if (info) { entry(info[1]); return output("flags:\t0\n", options); }
  const match = typeof target === "string" && /^\/proc\/(self|\d+)\/(status|stat|cmdline)$/.exec(target);
  if (match) {
    const pid = match[1] === "self" ? process.pid : Number(match[1]);
    const record = entry(pid);
    if (match[2] === "status") return output(`State:\tS\nNSpid:\t${pid}\n`, options);
    if (match[2] === "stat") return output(`${pid} (fixture) S ${Array(19).fill("123456").join(" ")}\n`, options);
    return output(`${record.argv.join("\0")}\0`, options);
  }
  return real.readFileSync.call(this, anchored(target), options);
};
const realExecFileSync = childProcess.execFileSync;
const realSpawnSync = childProcess.spawnSync;
const realSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (process.env.GROK_LINUX_SIM_SPAWN_MARKER && command === process.env.GROK_BIN && Array.isArray(args) &&
      args[0] === "agent" && args[1] === "stdio" && !args.includes("--help")) {
    if (!process.env.GROK_LINUX_SIM_SPAWN_MARKER.startsWith(`${root}${path.sep}`)) throw new Error("agent spawn marker is outside fixture root");
    real.writeFileSync(process.env.GROK_LINUX_SIM_SPAWN_MARKER, "started\n", { flag: "a", mode: 0o600 });
  }
  return realSpawn.call(this, command, args, options);
};
childProcess.execFileSync = function (command, args, options) {
  if (command !== "/usr/bin/flock") return realExecFileSync.call(this, command, args, options);
  try { return realExecFileSync.call(this, "/usr/bin/lockf", ["-s", "-t", "0", "3"], options); }
  catch (error) { if (error.status === 75) error.status = 1; throw error; }
};
childProcess.spawnSync = function (command, args, options) {
  if (command === "/usr/bin/flock") {
    const result = realSpawnSync.call(this, "/usr/bin/lockf", ["-s", "-t", "0", "3"], options);
    const flag = args.indexOf("-E");
    if (result.status === 75) result.status = flag >= 0 ? Number(args[flag + 1]) : 1;
    return result;
  }
  return realSpawnSync.call(this, command, args, options);
};
function socketAddress(value) {
  if (typeof value !== "string" || !value.startsWith("\0grok-state-lock-")) return value;
  return path.join(root, `socket-${value.slice(-32)}`);
}
const realCreateServer = net.createServer, realConnect = net.connect;
net.createServer = function (...args) {
  const server = realCreateServer.call(this, ...args), listen = server.listen;
  server.listen = function (address, ...rest) { return listen.call(this, socketAddress(address), ...rest); };
  return server;
};
net.connect = function (address, ...args) { return realConnect.call(this, socketAddress(address), ...args); };
syncBuiltinESMExports();
