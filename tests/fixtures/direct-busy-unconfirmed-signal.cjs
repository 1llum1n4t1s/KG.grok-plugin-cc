// Keep the real spawned ChildProcess as the signal authority in this fixture.
// Signal 0 is only an existence check and is forwarded unchanged.
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const realSpawn = cp.spawn;
const realKill = process.kill;
const ownedAgents = new Map();
cp.spawn = function (...args) {
  const child = realSpawn.apply(this, args);
  if (args[0] === process.env.GROK_BUSY_TEST_BIN && child.pid) ownedAgents.set(child.pid, child);
  return child;
};
process.kill = function (pid, signal) {
  if (signal === 0) return realKill.call(this, pid, signal);
  if (pid < 0 && signal === 'SIGTERM') {
    const child = ownedAgents.get(-pid);
    if (!child) throw new Error('fixture refused signal without an owned child');
    return child.kill('SIGTERM');
  }
  throw new Error('fixture refused numeric PID signal');
};
syncBuiltinESMExports();
