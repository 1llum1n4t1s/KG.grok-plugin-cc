// Linux CLI 模擬 preload の後に読み、対象 job の公開済み index または
// detail/log unlink の直後に worker を停止する。通常の record 更新では発火しない。
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const { GROK_HISTORY_CRASH_STAGE: stage, GROK_HISTORY_CRASH_JOB: job,
  GROK_HISTORY_CRASH_MARKER: marker, GROK_LINUX_SIM_ROOT: root,
  GROK_LINUX_SIM_STATE_DIR: stateDir } = process.env;
const script = process.argv[1] ?? "";
if (stage && ((script.endsWith("grok-companion.mjs") && process.argv[2] === "task") || script.endsWith("linux-lease-sweep-cli.mjs"))) {
  if (!["bootstrap", "prepared", "intent-temp", "intent-publish", "index", "index-replaced", "index-unknown", "index-modified", "detail", "log"].includes(stage) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(job ?? "") ||
      !marker || path.dirname(marker) !== root || !stateDir) throw new Error("Invalid history crash fixture parameters");
  const rename = fs.renameSync, unlink = fs.unlinkSync, open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync;
  const opened = new Map();
  const crash = () => { fs.writeFileSync(marker, stage, { flag: "wx", mode: 0o600 }); process.exit(87); };
  fs.openSync = function (target, ...options) {
    const fd = open.call(this, target, ...options);
    opened.set(fd, path.basename(String(target))); return fd;
  };
  fs.closeSync = function (fd) { opened.delete(fd); return close.call(this, fd); };
  fs.fsyncSync = function (fd) {
    const result = sync.call(this, fd), name = opened.get(fd);
    if ((stage === "bootstrap" && name === "bootstrap") || (stage === "prepared" && name === "index.prepared") ||
        (stage === "intent-temp" && name === "intent.tmp")) crash();
    return result;
  };
  fs.renameSync = function (from, to, ...options) {
    const result = rename.call(this, from, to, ...options);
    if (stage === "intent-publish" && path.basename(String(to)) === "intent.json") crash();
    if (["index", "index-replaced", "index-unknown", "index-modified"].includes(stage) && path.basename(String(to)) === "state.json") {
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
      if (!state.jobs.some(entry => entry.id === job)) crash();
    }
    return result;
  };
  fs.unlinkSync = function (target, ...options) {
    const result = unlink.call(this, target, ...options);
    if ((stage === "detail" && path.basename(String(target)) === `${job}.json`) ||
        (stage === "log" && path.basename(String(target)) === `${job}.log`)) crash();
    return result;
  };
  syncBuiltinESMExports();
}
