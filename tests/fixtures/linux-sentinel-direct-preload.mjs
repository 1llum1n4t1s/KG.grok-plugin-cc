// Mac にはない /proc と抽象 Unix socket だけを、直接起動した sentinel 内で模擬する。
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { EventEmitter } from "node:events";

const barrier = process.env.GROK_TEST_SENTINEL_BARRIER;
const readFileSync = fs.readFileSync;
const openSync = fs.openSync;
const lstatSync = fs.lstatSync;
const statSync = fs.statSync;
const readdirSync = fs.readdirSync;
const readlinkSync = fs.readlinkSync;
let readyFd;
let verification;

function anchored(target) {
  if (typeof target !== "string") return target;
  const match = /^\/proc\/self\/fd\/3(?:\/(.*))?$/.exec(target);
  if (!match) return target;
  const held = fs.fstatSync(3, { bigint: true });
  const named = lstatSync(barrier, { bigint: true });
  if (held.dev !== named.dev || held.ino !== named.ino) throw new Error("fixture barrier changed");
  return path.join(barrier, match[1] ?? "");
}
fs.lstatSync = function (target, ...options) { return lstatSync.call(this, anchored(target), ...options); };
fs.statSync = function (target, ...options) {
  if (verification && typeof target === "string") {
    const match = new RegExp(`^/proc/${process.pid}/fd/(\\d+)$`).exec(target);
    if (match) {
      const fd = Number(match[1]);
      if (fd === 3) {
        if (verification.fd3 === "absent") throw Object.assign(new Error("fixture fd 3 absent"), { code: "ENOENT" });
        if (verification.fd3 === "file") return fs.fstatSync(readyFd, ...options);
        if (verification.fd3 === "other") return statSync.call(this, path.join(path.dirname(barrier), "other-barrier"), ...options);
      }
      return fs.fstatSync(fd, ...options);
    }
  }
  return statSync.call(this, anchored(target), ...options);
};
fs.readdirSync = function (target, ...options) {
  if (verification && target === `/proc/${process.pid}/fd`) return ["3", String(readyFd)];
  return readdirSync.call(this, target, ...options);
};
fs.readlinkSync = function (target, ...options) {
  if (verification && typeof target === "string" && target.startsWith(`/proc/${process.pid}/ns/`)) {
    return `fixture-${target.slice(target.lastIndexOf("/") + 1)}`;
  }
  return readlinkSync.call(this, target, ...options);
};
fs.openSync = function (target, flags, ...options) {
  const resolved = anchored(target);
  const fd = openSync.call(this, resolved, flags, ...options);
  if (typeof target === "string" && target.startsWith("/proc/self/fd/3/")
      && resolved === path.join(barrier, "sentinel-ready.json") && typeof flags === "number" && (flags & 3) === 0) readyFd = fd;
  return fd;
};
fs.readFileSync = function (target, ...options) {
  if (typeof target === "string" && /^\/proc\/self\/fdinfo\/\d+$/.test(target)) {
    fs.fstatSync(Number(target.slice(target.lastIndexOf("/") + 1)));
    return "mnt_id:\t41\n";
  }
  if (target === `/proc/${process.pid}/stat`) {
    return `${process.pid} (sentinel fixture) S ${Array(19).fill("123456").join(" ")}\n`;
  }
  if (verification && target === `/proc/${process.pid}/status`) return `State:\tS\nNSpid:\t${process.pid}\n`;
  if (verification && typeof target === "string" && new RegExp(`^/proc/${process.pid}/fdinfo/\\d+$`).test(target)) return "flags:\t0\n";
  if (verification && target === `/proc/${process.pid}/cmdline`) {
    const args = process.argv.slice();
    if (verification.alias) args[3] = path.join(path.dirname(barrier), "other-namespace", "state.lock");
    return Buffer.from(`${args.join("\0")}\0`);
  }
  return readFileSync.call(this, anchored(target), ...options);
};

// 実ネットワークを開かず listen 完了だけを通知する。通信・停止経路は対象外。
net.createServer = () => {
  const server = new EventEmitter();
  server.listen = (address, callback) => {
    if (typeof address !== "string" || !address.startsWith("\0grok-state-lock-")) throw new Error("unexpected fixture address");
    process.nextTick(callback);
    return server;
  };
  return server;
};

process.on("message", async message => {
  if (message?.type !== "inspect") return;
  try {
    const held = fs.fstatSync(3, { bigint: true });
    const result = { type: "inspection", request: message.request,
      barrier: { dev: String(held.dev), ino: String(held.ino) } };
    if (message.ready) {
      if (!Number.isInteger(readyFd)) throw new Error("ready descriptor was not opened for reading");
      const stat = fs.fstatSync(readyFd, { bigint: true });
      const data = Buffer.alloc(4096);
      const bytes = fs.readSync(readyFd, data, 0, data.length, 0);
      result.ready = { dev: String(stat.dev), ino: String(stat.ino), content: data.subarray(0, bytes).toString("utf8") };
    }
    if (message.verify) {
      verification = message.verify;
      try {
        const { verifyLinuxSentinel } = await import("../../plugins/grok/scripts/lib/linux-state-sentinel.mjs");
        const sentinel = { generation: process.argv[4], nonce: process.argv[5], pid: process.pid, startTick: "123456" };
        if (!verification.legacy) sentinel.barrierFd = verification.invalidFd ? 4 : 3;
        const scope = { pidNamespace: "fixture-pid", timeNamespace: "fixture-time", netNamespace: "fixture-net" };
        try {
          verifyLinuxSentinel(barrier, { sentinel, barrierIdentity: result.barrier }, scope, "41");
          result.verification = { ok: true };
        } catch (error) {
          result.verification = { ok: false, reason: error.cause?.message ?? error.message };
        }
      } finally { verification = undefined; }
    }
    process.send(result);
  } catch (error) {
    process.send({ type: "inspection", request: message.request, error: error.message });
  }
});
