import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { migrateStateLock, resolveStateDir } from '../plugins/grok/scripts/lib/state.mjs';
import { makeTempDir, removeTempFixture } from './helpers.mjs';

test('real tracked worker preserves an unconfirmed direct generation', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const root = makeTempDir('grok-direct-generation-');
  const previous = [ 'CLAUDE_PLUGIN_DATA', 'PLUGIN_DATA' ].map(name => [name, process.env[name]]);
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, 'data');
  delete process.env.PLUGIN_DATA;
  const workers = [];
  const failures = [];
  t.after(async () => {
    for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(workers.map(worker => worker.closed));
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    removeTempFixture(root, { recursive: true, force: true });
  });
  for (const variant of ['unconfirmed', 'stored-proof-missing', 'index-proof-missing', 'generation-mismatch', 'proof-mismatch',
    'owner-without-generation', 'stop-without-generation', 'owner-pid-null', 'owner-pid-empty', 'owner-pid-different',
    'owner-start-null', 'owner-start-empty', 'owner-start-different', 'confirmed']) {
    const workspace = path.join(root, variant);
    fs.mkdirSync(workspace);
    migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(workspace) });
    const child = fork(new URL('./fixtures/direct-generation-real-worker.mjs', import.meta.url), [workspace, variant], {
      env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    workers.push({ child, closed });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker timed out: ${variant}: ${stderr}`)), 8000);
      child.once('message', value => { clearTimeout(timer); resolve(value); });
      child.once('close', (code, signal) => { clearTimeout(timer); reject(new Error(`worker exited without report: ${variant}: ${code}/${signal}: ${stderr}`)); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.equal(result.type, 'result', JSON.stringify(result));
    const { report } = result;
    assert.equal(report.workerPid, child.pid);
    const missingGeneration = variant === 'owner-without-generation' || variant === 'stop-without-generation';
    assert.equal(report.before.indexed.grokDirectGeneration, missingGeneration ? null : report.original);
    if (variant !== 'confirmed') {
      if (report.second !== null) failures.push(`${variant}: replacement generation was registered`);
      if (report.failure?.turnStopUnconfirmed !== true) failures.push(`${variant}: stop-unconfirmed error was not preserved`);
      try { assert.deepEqual(report.after, report.before); }
      catch { failures.push(`${variant}: job records changed`); }
    } else {
      assert.equal(report.failure, undefined, JSON.stringify(report.failure));
      assert.ok(report.second && report.second !== report.original);
      for (const record of [report.after.indexed, report.after.stored]) {
        assert.equal(record.grokDirectGeneration, report.second);
        assert.equal(record.grokDirectStopGeneration, null);
        assert.equal(record.grokDirectStopKind, null);
      }
    }
    assert.equal((await closed).code, 0, stderr);
  }
  assert.deepEqual(failures, [], 'all inconsistent direct generations must be rejected without changing either record');
});
