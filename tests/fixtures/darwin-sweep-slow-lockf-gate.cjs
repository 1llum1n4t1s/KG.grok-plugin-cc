const fs = require("node:fs");
const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const spawn = cp.spawnSync;
cp.spawnSync = function (command, args, options, ...rest) {
  if (command === "/usr/bin/lockf") {
    fs.writeFileSync(process.env.GROK_SWEEP_SLOW_READY, JSON.stringify({ timeout: options?.timeout }), { mode: 0o600 });
    return spawn.call(this, process.execPath, ["-e", "setTimeout(() => {}, 10000)"], options, ...rest);
  }
  return spawn.call(this, command, args, options, ...rest);
};
syncBuiltinESMExports();
