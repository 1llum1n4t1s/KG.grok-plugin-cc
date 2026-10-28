// 同 dev/ino の名前付き root が別 mount へ変わった観測だけを模擬する。
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const { GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_HISTORY_MOUNT_SWITCH: marker } = process.env;
if (marker) {
  if (!root || !stateDir || !marker.startsWith(`${root}/`)) throw new Error("Invalid offline mount fixture");
  const open = fs.openSync, close = fs.closeSync, read = fs.readFileSync, changed = new Set();
  fs.openSync = function (name, ...options) {
    const fd = open.call(this, name, ...options);
    if (name === stateDir && fs.existsSync(marker)) changed.add(fd);
    return fd;
  };
  fs.closeSync = function (fd) { changed.delete(fd); return close.call(this, fd); };
  fs.readFileSync = function (name, options) {
    const match = typeof name === "string" && /^\/proc\/self\/fdinfo\/(\d+)$/.exec(name);
    if (match && changed.has(Number(match[1]))) {
      const text = "mnt_id:\t987654\n", encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? text : Buffer.from(text);
    }
    return read.call(this, name, options);
  };
  syncBuiltinESMExports();
}
