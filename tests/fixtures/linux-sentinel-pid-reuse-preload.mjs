// Linux procfs の FD 固定と同一 tick PID 再利用を模擬する。実カーネルの証明ではない。
import fs from "node:fs";
import childProcess from "node:child_process";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const scenario = process.env.GROK_SENTINEL_REUSE_SCENARIO;
if (scenario && process.argv[1]?.endsWith("grok-companion.mjs") && process.argv[2] === "state-lock"
    && process.argv[3] === "stop-sentinel") {
  const root = process.env.GROK_LINUX_SIM_ROOT;
  const marker = JSON.parse(fs.readFileSync(path.join(process.env.GROK_LINUX_SIM_STATE_DIR, "state.lock", "protocol.json"), "utf8"));
  const pid = marker.sentinel.pid;
  const startTick = marker.sentinel.startTick;
  const statPath = `/proc/${pid}/stat`;
  const audit = path.join(root, "sentinel-fd-audit");
  const realOpen = fs.openSync, realClose = fs.closeSync, realReadFile = fs.readFileSync, realRead = fs.readSync;
  const realExec = childProcess.execFileSync;
  const held = new Set();
  let acknowledged = false;
  let truncated = false;
  const log = line => fs.appendFileSync(audit, `${line}\n`);
  const fail = code => { throw Object.assign(new Error(`fixture ${code}`), { code }); };
  const stat = () => `${pid} (fixture) S ${Array(18).fill("1").join(" ")} ${startTick}\n`;
  const pinnedStat = () => {
    if (acknowledged && scenario === "read-denied") fail("EACCES");
    if (acknowledged && scenario === "malformed") {
      if (truncated) fail("ESRCH");
      truncated = true;
      log("truncated-stat");
      return stat().trimEnd();
    }
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") fail("ESRCH"); throw error; }
    return stat();
  };
  fs.openSync = function (target, ...args) {
    if (target !== statPath) return realOpen.call(this, target, ...args);
    log("open");
    if (scenario === "open-denied") fail("EACCES");
    const fd = realOpen.call(this, path.join(root, "processes", `${pid}.json`), "r");
    held.add(fd);
    return fd;
  };
  fs.closeSync = function (fd) {
    if (held.delete(fd)) log("close");
    return realClose.call(this, fd);
  };
  fs.readFileSync = function (target, options) {
    if (held.has(target)) { log("read-fd"); const value = pinnedStat(); return typeof options === "string" || options?.encoding ? value : Buffer.from(value); }
    if (target === statPath && acknowledged) { log("read-reused-path"); return typeof options === "string" || options?.encoding ? stat() : Buffer.from(stat()); }
    return realReadFile.call(this, target, options);
  };
  fs.readSync = function (fd, buffer, offset, length, position) {
    if (!held.has(fd)) return realRead.call(this, fd, buffer, offset, length, position);
    log("read-fd");
    const data = Buffer.from(pinnedStat());
    const n = Math.min(length, Math.max(0, data.length - (position ?? 0)));
    data.copy(buffer, offset, position ?? 0, (position ?? 0) + n);
    return n;
  };
  childProcess.execFileSync = function (command, args, options) {
    if (Array.isArray(args) && args[0]?.endsWith("linux-state-sentinel.mjs") && args[1] === "stop") {
      log("stop");
      if (scenario === "stop-fail") fail("EIO");
      const result = realExec.call(this, command, args, options);
      acknowledged = true;
      log("ack");
      return result;
    }
    return realExec.call(this, command, args, options);
  };
  syncBuiltinESMExports();
}
