const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = cp.spawnSync;
let gated = false;
cp.spawnSync = function (command, args, options, ...rest) {
  const fd = options?.stdio?.[3];
  if (!gated && command === "/usr/bin/lockf" && Number.isInteger(fd)) {
    try {
      const bytes = Buffer.alloc(36);
      const stat = fs.fstatSync(fd, { bigint: true });
      const id = fs.readSync(fd, bytes, 0, 36, 0) === 36 ? bytes.toString("utf8") : "";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
        gated = true;
        const root = fs.realpathSync.native(process.env.GROK_TEST_STATE_DIR);
        const directory = path.join(root, "worker-leases");
        const dir = fs.lstatSync(directory, { bigint: true });
        const epoch = JSON.parse(fs.readFileSync(path.join(root, "state.lock", "protocol.json"), "utf8")).epoch;
        const lease = { id, path: path.join(directory, `${id}.lease`), dev: String(stat.dev), ino: String(stat.ino), stateGeneration: epoch,
          directoryDev: String(dir.dev), directoryIno: String(dir.ino) };
        fs.writeFileSync(process.env.GROK_TEST_LEASE_READY, JSON.stringify(lease));
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(process.env.GROK_TEST_LEASE_RELEASE) && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        if (!fs.existsSync(process.env.GROK_TEST_LEASE_RELEASE)) throw new Error("lease test gate timed out");
      }
    } catch (error) {
      if (gated) throw error;
    }
  }
  return original.call(this, command, args, options, ...rest);
};
syncBuiltinESMExports();
