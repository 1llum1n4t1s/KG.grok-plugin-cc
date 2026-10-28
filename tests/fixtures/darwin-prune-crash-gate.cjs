// 実 CLI の unlink 境界で停止し、親が SIGKILL を送る。
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const unlink = fs.unlinkSync;
const rename = fs.renameSync;
const open = fs.openSync;
const close = fs.closeSync;
const sync = fs.fsyncSync;
const write = fs.writeFileSync;
const opened = new Map();
let stopped = false;

function pause(name) {
  if (!stopped && typeof name === "string" && path.resolve(name) === process.env.GROK_PRUNE_TEST_TARGET) {
    stopped = true;
    fs.writeFileSync(process.env.GROK_PRUNE_TEST_READY, "ready", { mode: 0o600 });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    throw new Error("prune crash gate timed out");
  }
}
fs.unlinkSync = function (name, ...args) {
  pause(name);
  return unlink.call(this, name, ...args);
};
fs.renameSync = function (from, to, ...args) {
  pause(from);
  return rename.call(this, from, to, ...args);
};
fs.openSync = function (name, ...args) {
  const fd = open.call(this, name, ...args);
  if (typeof name === "string") opened.set(fd, path.resolve(name));
  return fd;
};
fs.closeSync = function (fd) {
  try { return close.call(this, fd); } finally { opened.delete(fd); }
};
fs.fsyncSync = function (fd) {
  if (!stopped && process.env.GROK_PRUNE_TEST_ENOSPC === "1" && opened.get(fd) === process.env.GROK_PRUNE_TEST_TARGET) {
    stopped = true;
    fs.writeFileSync(process.env.GROK_PRUNE_TEST_READY, "enospc", { mode: 0o600 });
    const error = new Error("injected prepared index fsync failure");
    error.code = "ENOSPC";
    throw error;
  }
  return sync.call(this, fd);
};
fs.writeFileSync = function (file, data, ...args) {
  if (!stopped && process.env.GROK_PRUNE_TEST_PARTIAL === "1" && typeof file === "number"
      && opened.get(file) === process.env.GROK_PRUNE_TEST_TARGET) {
    stopped = true;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    write.call(this, file, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), ...args);
    write.call(this, process.env.GROK_PRUNE_TEST_READY, "partial", { mode: 0o600 });
    const error = new Error("injected partial marker write");
    error.code = "ENOSPC";
    throw error;
  }
  return write.call(this, file, data, ...args);
};
syncBuiltinESMExports();
