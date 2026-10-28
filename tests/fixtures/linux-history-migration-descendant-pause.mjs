// migration の書込み子孫を fsync 直後で停止し、親死亡後の root lock 継承を試す。
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const { GROK_LINUX_SIM_ROOT: root, GROK_HISTORY_DESCENDANT_STAGE: stage,
  GROK_HISTORY_DESCENDANT_READY: ready, GROK_HISTORY_DESCENDANT_RELEASE: release,
  GROK_HISTORY_DESCENDANT_COMMITTED: committed } = process.env;
const script = process.argv[1] ?? "", role = process.argv[2];
if (stage && script.endsWith("linux-state-sentinel.mjs") && ["bootstrap", "sentinel"].includes(role)) {
  if (!["bootstrap-marker", "sentinel-ready"].includes(stage) || !root || !ready || !release || !committed ||
      path.dirname(ready) !== root || path.dirname(release) !== root || path.dirname(committed) !== root) throw new Error("Invalid migration descendant fixture");
  const open = fs.openSync, close = fs.closeSync, sync = fs.fsyncSync, opened = new Map();
  let paused = false;
  fs.openSync = function (name, ...options) {
    const fd = open.call(this, name, ...options); opened.set(fd, path.basename(String(name))); return fd;
  };
  fs.closeSync = function (fd) { opened.delete(fd); return close.call(this, fd); };
  fs.fsyncSync = function (fd) {
    const result = sync.call(this, fd);
    if (role === "sentinel" && fs.fstatSync(fd).isDirectory() && fs.existsSync(ready) && !fs.existsSync(committed)) {
      fs.writeFileSync(committed, "ready-directory-synced", { flag: "wx", mode: 0o600 });
    }
    if (!paused && ((stage === "bootstrap-marker" && role === "bootstrap" && fd === 4) ||
        (stage === "sentinel-ready" && role === "sentinel" && opened.get(fd) === "sentinel-ready.json"))) {
      paused = true; fs.writeFileSync(ready, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      const deadline = Date.now() + 20000, lock = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(lock, 0, 0, 20);
      if (!fs.existsSync(release)) throw new Error("Migration descendant fixture timed out");
    }
    return result;
  };
  syncBuiltinESMExports();
}
