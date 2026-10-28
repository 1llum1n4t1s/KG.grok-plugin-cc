// root directory FD の offline flock 取得直後を停止し、別 CLI と競合させる。
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const { GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
  GROK_HISTORY_OFFLINE_LOCK_READY: ready, GROK_HISTORY_OFFLINE_LOCK_RELEASE: release,
  GROK_HISTORY_OFFLINE_LOCK_CMD: selected = "recover-history", GROK_HISTORY_OFFLINE_REUSED: reused } = process.env;
if (ready && process.argv[1]?.endsWith("grok-companion.mjs") && process.argv[2] === "state-lock" && process.argv[3] === selected) {
  if (!["recover-history", "migrate"].includes(selected)) throw new Error("Invalid offline lock fixture command");
  if (!root || !stateDir || !release || path.dirname(ready) !== root || path.dirname(release) !== root) throw new Error("Invalid offline lock fixture");
  if (reused && path.dirname(reused) !== root) throw new Error("Invalid offline operation FD fixture");
  const execute = childProcess.execFileSync, invoke = childProcess.spawnSync, open = fs.openSync, close = fs.closeSync;
  const rootFds = new Set();
  fs.openSync = function (name, ...options) {
    const fd = open.call(this, name, ...options);
    if (name === stateDir) rootFds.add(fd);
    return fd;
  };
  fs.closeSync = function (fd) { rootFds.delete(fd); return close.call(this, fd); };
  let paused = false;
  const isRootLock = (command, options) => {
    if (paused || command !== "/usr/bin/flock" || !Array.isArray(options?.stdio) || !Number.isInteger(options.stdio[3])) return false;
    const fd = fs.fstatSync(options.stdio[3], { bigint: true }), named = fs.lstatSync(stateDir, { bigint: true });
    return fd.isDirectory() && fd.dev === named.dev && fd.ino === named.ino;
  };
  const pause = lockFd => {
    if (reused) {
      const operationFd = [...rootFds].reverse().find(fd => fd !== lockFd);
      if (operationFd === undefined) throw new Error("Offline operation descriptor was not available");
      fs.closeSync(operationFd);
      const reopened = fs.openSync(stateDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (reopened !== operationFd) throw new Error("Offline operation descriptor number was not reused");
      fs.writeFileSync(reused, "reused", { flag: "wx", mode: 0o600 });
    }
    paused = true; fs.writeFileSync(ready, "root-lock-held", { flag: "wx", mode: 0o600 });
    const deadline = Date.now() + 15000, lock = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(lock, 0, 0, 20);
    if (!fs.existsSync(release)) throw new Error("Offline root lock fixture timed out");
  };
  childProcess.execFileSync = function (command, args, options) {
    const rootLock = isRootLock(command, options), result = execute.call(this, command, args, options);
    if (rootLock) pause(options.stdio[3]);
    return result;
  };
  childProcess.spawnSync = function (command, args, options) {
    const rootLock = isRootLock(command, options), result = invoke.call(this, command, args, options);
    if (rootLock && result.status === 0) pause(options.stdio[3]);
    return result;
  };
  syncBuiltinESMExports();
}
