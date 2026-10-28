import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { register, syncBuiltinESMExports } from 'node:module';

const root = process.env.GROK_SIMULATED_ROOT;
const file = name => path.join(root, name);
register(new URL('./direct-spawn-simulated-loader.mjs', import.meta.url), import.meta.url);
const originalSpawn = cp.spawn;
cp.spawn = function (...args) {
  let waitForReady = false;
  if (args[0] === process.env.GROK_SIMULATED_BIN) {
    fs.writeFileSync(file('spawn-reached'), String(fs.existsSync(file('mutex'))));
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(file('spawn-release')) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (!fs.existsSync(file('spawn-release'))) throw new Error('spawn gate timed out');
    fs.writeFileSync(file('spawn-called'), String(fs.existsSync(file('mutex'))));
    fs.appendFileSync(file('spawn-count'), 'spawn\n');
    waitForReady = ['guard-async-after', 'guard-double', 'guard-wrong-return', 'guard-undefined-return'].includes(process.env.GROK_SIMULATED_VARIANT);
  }
  const child = originalSpawn.apply(this, args);
  if (waitForReady) {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(file('agent-ready')) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return child;
};
syncBuiltinESMExports();
const { GrokAcpClient } = await import('../../plugins/grok/scripts/lib/acp.mjs');

// This fixture explicitly models the Linux owner records and its mutex. It does not
// claim to test Linux state locks, mount identities, or namespace behaviour.
function guardOwnerEffect(effect) {
  fs.mkdirSync(file('mutex'));
  try {
    const state = JSON.parse(fs.readFileSync(file('state.json'), 'utf8'));
    if (![state.indexed, state.stored].every(job => job.status === 'running' && job.epoch === 'original-epoch' && job.owner === 'original-owner')) {
      throw new Error('simulated owner changed or cancelled');
    }
    const context = { epoch: state.epoch, check() { if (!fs.existsSync(file('mutex'))) throw new Error('simulated mutex lost'); } };
    fs.writeFileSync(file('owner-checked'), 'checked');
    return effect(state, context);
  } finally { fs.rmdirSync(file('mutex')); }
}

const variant = process.env.GROK_SIMULATED_VARIANT;
function suppliedGuard(effect) {
  if (variant === 'guard-async-before') return Promise.resolve().then(() => guardOwnerEffect(effect));
  if (variant === 'guard-async-after') return Promise.resolve(guardOwnerEffect(effect));
  if (variant === 'guard-double') return guardOwnerEffect((state, context) => {
    const result = effect(state, context);
    try { effect(state, context); } catch { /* 二度目を握りつぶしても拒否しなければならない。 */ }
    return result;
  });
  if (variant === 'guard-wrong-return') { guardOwnerEffect(effect); return {}; }
  if (variant === 'guard-undefined-return') { guardOwnerEffect(effect); return undefined; }
  if (variant === 'guard-return-getter') {
    let invoke;
    guardOwnerEffect((state, context) => { invoke = () => effect(state, context); });
    return { get then() { invoke(); return undefined; } };
  }
  return guardOwnerEffect(effect);
}
let stopProof;
try {
  const client = await GrokAcpClient.connect(root, { disableBroker: true, grokBin: process.env.GROK_SIMULATED_BIN,
    env: process.env, guardOwnerEffect: suppliedGuard,
    directAgentStarting: () => ({ finish: async proof => { stopProof = proof; return true; } }) });
  await client.close();
  process.send({ outcome: 'connected' }, () => process.disconnect());
} catch (error) {
  process.send({ outcome: 'rejected', message: error.message, stopProof }, () => process.disconnect());
}
