const fs = require("node:fs");
const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = cp.spawn;
cp.spawn = function (command, ...args) {
  if (command === process.env.GROK_TEST_DIRECT_BIN) {
    fs.writeFileSync(process.env.GROK_TEST_SPAWN_READY, "ready");
    const fd = fs.openSync(process.env.GROK_TEST_SPAWN_FIFO, "r");
    try { fs.readSync(fd, Buffer.alloc(1), 0, 1, null); } finally { fs.closeSync(fd); }
    fs.writeFileSync(process.env.GROK_TEST_SPAWN_CALLED, "spawn called");
  }
  return original.call(this, command, ...args);
};
syncBuiltinESMExports();
