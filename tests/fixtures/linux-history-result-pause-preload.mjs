// result の index 読取り直後を停止し、別 CLI の history 整理と競合させる。
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const { GROK_HISTORY_RESULT_TARGET: target, GROK_HISTORY_RESULT_READY: ready,
  GROK_HISTORY_RESULT_RELEASE: release, GROK_LINUX_SIM_ROOT: root } = process.env;
if (target && process.argv[1]?.endsWith("grok-companion.mjs") && process.argv[2] === "result") {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(target) || !ready || !release ||
      path.dirname(ready) !== root || path.dirname(release) !== root) throw new Error("Invalid result race fixture parameters");
  const open = fs.openSync, close = fs.closeSync, read = fs.readFileSync, opened = new Map();
  let paused = false;
  fs.openSync = function (name, ...options) {
    const fd = open.call(this, name, ...options); opened.set(fd, path.basename(String(name))); return fd;
  };
  fs.closeSync = function (fd) { opened.delete(fd); return close.call(this, fd); };
  fs.readFileSync = function (file, ...options) {
    const data = read.call(this, file, ...options);
    if (!paused && typeof file === "number" && opened.get(file) === "state.json") {
      let index;
      try { index = JSON.parse(typeof data === "string" ? data : data.toString("utf8")); } catch { return data; }
      if (index?.jobs?.some(job => job?.id === target)) {
        paused = true; fs.writeFileSync(ready, "index-read", { flag: "wx", mode: 0o600 });
        const deadline = Date.now() + 15000, lock = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(lock, 0, 0, 20);
        if (!fs.existsSync(release)) throw new Error("Result race fixture timed out");
      }
    }
    return data;
  };
  syncBuiltinESMExports();
}
