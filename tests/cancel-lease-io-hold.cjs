const fs = require("node:fs");
const net = require("node:net");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const append = fs.appendFileSync;
const writeFile = fs.writeFileSync;
const listen = net.Server.prototype.listen;
const execFileSync = childProcess.execFileSync;
const stateMutex = process.env.CANCEL_LEASE_STATE_MUTEX;
let armed = false;
let locks = 0;
function hold() {
  fs.writeFileSync(process.env.CANCEL_LEASE_HOLD_READY, "ready");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !fs.existsSync(process.env.CANCEL_LEASE_HOLD_RELEASE)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
fs.appendFileSync = function(target, content, ...args) {
  const result = append.call(this, target, content, ...args);
  if (String(content).includes("Session ready (session-1).")) armed = true;
  return result;
};
// Darwin の検証済み log は pathname の append ではなく、検証後 FD に書く。
fs.writeFileSync = function(target, content, ...args) {
  const result = writeFile.call(this, target, content, ...args);
  if (typeof target === "number" && String(content).includes("Session ready (session-1).")) armed = true;
  return result;
};
net.Server.prototype.listen = function(...args) {
  if (armed && args[0] && typeof args[0] === "object" && args[0].path === stateMutex && ++locks === 2) hold();
  return listen.apply(this, args);
};
childProcess.execFileSync = function(command, args, options) {
  let target = false;
  if (armed && ((command === "/usr/bin/lockf" && JSON.stringify(args) === '["-s","-t","0","3"]') ||
      (command === "/usr/bin/flock" && JSON.stringify(args) === '["-x","-n","3"]')) &&
      typeof options?.stdio?.[3] === "number") {
    const actual = fs.fstatSync(options.stdio[3], { bigint: true });
    const expected = fs.statSync(stateMutex, { bigint: true });
    target = actual.dev === expected.dev && actual.ino === expected.ino;
  }
  if (target && locks === 1) hold();
  const result = execFileSync.apply(this, arguments);
  if (target) locks++;
  return result;
};
syncBuiltinESMExports();
