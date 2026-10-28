const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const write = fs.writeFileSync;
const realpath = fs.realpathSync.native;
const stateDir = process.env.GROK_TEST_DIAGNOSTIC_STATE;
let armed = false, injected = false;
fs.writeFileSync = function (target, value, ...options) {
  if (!armed && (typeof value === "string" || Buffer.isBuffer(value))) {
    try {
      const parsed = JSON.parse(String(value));
      if (parsed?.id === "stale-session-job" && parsed.status === "cancelled" && parsed.terminationPending === true) armed = true;
    } catch { /* 他のファイルは対象外。 */ }
  }
  return write.call(this, target, value, ...options);
};
fs.realpathSync.native = function (target, ...options) {
  if (armed && !injected && target === stateDir) {
    injected = true;
    throw Object.assign(new Error("fixture delayed candidate read failed"), { code: "EIO" });
  }
  return realpath.call(this, target, ...options);
};
syncBuiltinESMExports();
