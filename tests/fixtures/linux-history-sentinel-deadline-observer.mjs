// 実 syscall 復帰後だけを遅らせ、次の処理と証拠の有無を観測する。
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const { GROK_LINUX_SIM_ROOT: root, GROK_HISTORY_DEADLINE_EVENTS: events,
  GROK_HISTORY_DELAY_STAGE: stage, GROK_HISTORY_TEST_DEADLINE_NS: deadlineText,
  GROK_HISTORY_READY_VISIBLE: visible, GROK_HISTORY_READY_EARLY: early,
  GROK_HISTORY_VERIFY_RELEASE: verifyRelease, GROK_HISTORY_VERIFY_ROLE: verifyRole } = process.env;
const role = process.argv[2];
if (events && process.argv[1]?.endsWith("linux-state-sentinel.mjs") && ["bootstrap", "sentinel"].includes(role)) {
  if (!root || path.dirname(events) !== root) throw new Error("Invalid deadline observer path");
  if (stage && !/^[0-9]+$/.test(deadlineText ?? "")) throw new Error("Invalid observed deadline");
  const deadline = stage ? BigInt(deadlineText) : null, pauseWord = new Int32Array(new SharedArrayBuffer(4));
  const record = value => fs.appendFileSync(events, `${value}\n`, { mode: 0o600 });
  const delayUntil = until => {
    while (process.hrtime.bigint() <= until) {
      const remaining = Number((until - process.hrtime.bigint()) / 1000000n);
      Atomics.wait(pauseWord, 0, 0, Math.min(30, Math.max(1, remaining)));
    }
  };
  const lateReturn = label => {
    record(`${label}-started:${process.hrtime.bigint()}`);
    delayUntil(deadline + 100000000n);
    record(`${label}-returned:${process.hrtime.bigint()}`);
  };
  const execute = childProcess.execFileSync, invoke = childProcess.spawnSync, spawn = childProcess.spawn;
  const open = fs.openSync, close = fs.closeSync, write = fs.writeFileSync, link = fs.linkSync, sync = fs.fsyncSync;
  const readyFds = new Set();
  let linked = false, readyWritten = false, readyDirectorySynced = false, rootClosed = false;
  fs.openSync = function (name, ...options) {
    const fd = open.call(this, name, ...options);
    if (role === "sentinel" && typeof name === "string" && name.endsWith("/sentinel-ready.json")) {
      readyFds.add(fd);
      const flags = options[0], readOnly = flags === "r" || (typeof flags === "number" && (flags & 3) === 0);
      if (readOnly) {
        record("ready-read-open");
        if (visible && !fs.existsSync(visible)) fs.writeFileSync(visible, "read-only-ready-fd", { flag: "wx", mode: 0o600 });
        if (!rootClosed && early) {
          if (!fs.existsSync(early)) fs.writeFileSync(early, "before-final-root-check", { flag: "wx", mode: 0o600 });
          if (["visibility", "ready-dir-late"].includes(stage)) {
            const limit = Date.now() + 10000;
            while (!fs.existsSync(verifyRelease) && Date.now() < limit) Atomics.wait(pauseWord, 0, 0, 20);
            if (!fs.existsSync(verifyRelease)) throw new Error("Ready visibility gate timed out");
          }
        }
        if (stage === "ready-open-race") {
          record("ready-open-race-started");
          const limit = Date.now() + 10000;
          while (!fs.existsSync(verifyRelease) && Date.now() < limit) Atomics.wait(pauseWord, 0, 0, 20);
          if (!fs.existsSync(verifyRelease)) throw new Error("Ready open gate timed out");
          record("ready-open-race-returned");
        }
      }
    }
    return fd;
  };
  fs.closeSync = function (fd) {
    readyFds.delete(fd);
    let rootLockClose = false;
    if (role === "sentinel" && fd === 4 && readyDirectorySynced && !rootClosed) {
      const descriptor = fs.fstatSync(fd, { bigint: true });
      const expected = fs.statSync(process.env.GROK_LINUX_SIM_STATE_DIR, { bigint: true });
      rootLockClose = descriptor.isDirectory() && descriptor.dev === expected.dev && descriptor.ino === expected.ino;
    }
    const result = close.call(this, fd);
    if (rootLockClose) {
      rootClosed = true; record("root-lock-closed");
      if (stage === "root-close-late") lateReturn(stage);
    }
    return result;
  };
  fs.writeFileSync = function (target, ...options) {
    const result = write.call(this, target, ...options);
    if (role === "bootstrap" && target === 4) {
      record("marker-write"); if (stage === "marker-write-late") lateReturn(stage);
    } else if (role === "sentinel" && typeof target === "number" && readyFds.has(target)) {
      readyWritten = true; record("ready-write"); if (stage === "ready-write-late") lateReturn(stage);
    }
    return result;
  };
  fs.linkSync = function (from, to, ...options) {
    const result = link.call(this, from, to, ...options);
    if (role === "bootstrap" && typeof to === "string" && path.basename(to) === "protocol.json") {
      linked = true; record("marker-link"); if (stage === "link-late") lateReturn(stage);
    }
    return result;
  };
  fs.fsyncSync = function (fd) {
    if (role === "bootstrap" && fd === 4) record("marker-fsync");
    if (role === "bootstrap" && linked && fs.fstatSync(fd).isDirectory()) record("marker-directory-fsync");
    if (role === "sentinel" && readyFds.has(fd)) record("ready-fsync");
    let readyDirectory = false;
    if (role === "sentinel" && readyWritten && !readyDirectorySynced) {
      const descriptor = fs.fstatSync(fd, { bigint: true }), barrier = fs.fstatSync(3, { bigint: true });
      readyDirectory = descriptor.isDirectory() && descriptor.dev === barrier.dev && descriptor.ino === barrier.ino;
    }
    const result = sync.call(this, fd);
    if (readyDirectory) { readyDirectorySynced = true; record("ready-directory-fsync"); if (stage === "ready-dir-late") lateReturn(stage); }
    return result;
  };
  childProcess.execFileSync = function (command, args, options) {
    if (role === "bootstrap" && command === "/usr/bin/flock") record("flock");
    return execute.call(this, command, args, options);
  };
  childProcess.spawnSync = function (command, args, options) {
    if (role === "bootstrap" && command === "/usr/bin/flock") record("flock");
    return invoke.call(this, command, args, options);
  };
  childProcess.spawn = function (command, args, options) {
    const sentinel = role === "bootstrap" && Array.isArray(args) && args[0]?.endsWith("linux-state-sentinel.mjs") && args[1] === "sentinel";
    if (sentinel) record("sentinel-spawn");
    const child = spawn.call(this, command, args, options);
    if (sentinel) {
      record(`sentinel-pid:${child.pid}`);
      if (stage === "spawn-overdue") lateReturn(stage);
      if (stage === "spawn-partial") {
        record(`${stage}-started:${process.hrtime.bigint()}`);
        delayUntil(process.hrtime.bigint() + 3000000000n);
        record(`${stage}-returned:${process.hrtime.bigint()}`);
      }
    }
    return child;
  };
  syncBuiltinESMExports();
}

if (verifyRole === "1") {
  if (!root || !visible || path.dirname(visible) !== root) throw new Error("Invalid verifier fixture path");
  const readdir = fs.readdirSync;
  fs.readdirSync = function (target, ...options) {
    const result = readdir.call(this, target, ...options);
    if (typeof target === "string" && /^\/proc\/\d+\/fd$/.test(target) && !fs.existsSync(visible)) {
      return result.filter(name => name !== "9");
    }
    return result;
  };
  syncBuiltinESMExports();
}
