const fs = require("node:fs"), cp = require("node:child_process");
const open = fs.openSync, close = fs.closeSync, exec = cp.execFileSync;
const lockFds = new Set(), marker = process.env.GROK_TEST_MUTEX_MARKER;
fs.openSync = function (target, ...args) {
  const fd = open.call(this, target, ...args);
  if (typeof target === "string" && target.endsWith("/state.lock/native.lock")) lockFds.add(fd);
  return fd;
};
fs.closeSync = function (fd) {
  if (lockFds.delete(fd)) fs.writeFileSync(marker, "released\n");
  return close.call(this, fd);
};
cp.execFileSync = function (command, args, options) {
  const result = exec.apply(this, arguments);
  if (command === "/usr/bin/lockf" && lockFds.has(options?.stdio?.[3])) fs.writeFileSync(marker, "held\n");
  return result;
};
require("node:module").syncBuiltinESMExports();
