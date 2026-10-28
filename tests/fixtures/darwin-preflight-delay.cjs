const fs = require("node:fs");
const open = fs.openSync;
let delayed = false;
fs.openSync = function (target, ...args) {
  if (!delayed && target === process.env.GROK_TEST_DELAY_BROKER_FILE) {
    delayed = true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
  }
  return open.call(this, target, ...args);
};
require("node:module").syncBuiltinESMExports();
