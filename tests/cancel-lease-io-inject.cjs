const fs = require("node:fs");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");

const spawnSync = childProcess.spawnSync;
let observedHeldLease = false;
childProcess.spawnSync = function(command, args, options) {
  if (observedHeldLease && command === "git") {
    fs.writeFileSync(process.env.CANCEL_LEASE_IO_MARKER, String(options?.timeout ?? "missing"));
    return { status: null, signal: null, stdout: "", stderr: "",
      error: Object.assign(new Error("injected Git I/O failure"), { code: "EIO" }) };
  }
  const result = spawnSync.apply(this, arguments);
  if ((command === "/usr/bin/lockf" || command === "/usr/bin/flock") &&
      typeof options?.stdio?.[3] === "number" && result.status !== 0 && !result.error) {
    const actual = fs.fstatSync(options.stdio[3], { bigint: true });
    const expected = fs.statSync(process.env.CANCEL_LEASE_PATH, { bigint: true });
    if (actual.dev === expected.dev && actual.ino === expected.ino) observedHeldLease = true;
  }
  return result;
};
syncBuiltinESMExports();
