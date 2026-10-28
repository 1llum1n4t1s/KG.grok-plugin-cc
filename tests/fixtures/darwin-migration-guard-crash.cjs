// test-only interruption: the real CLI has reached barrier creation, but no
// state.lock has been created by this call yet.
const fs = require("node:fs");
const original = fs.mkdirSync;
fs.mkdirSync = function (target, ...args) {
  if (target === process.env.GROK_TEST_BARRIER_PATH) process.exit(74);
  return original.call(this, target, ...args);
};
require("node:module").syncBuiltinESMExports();
