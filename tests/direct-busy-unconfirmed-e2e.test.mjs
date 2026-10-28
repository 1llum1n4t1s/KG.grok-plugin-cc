import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir, removeTempFixture } from './helpers.mjs';
import { loadState, migrateStateLock, resolveStateDir } from '../plugins/grok/scripts/lib/state.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
test('direct busy error cannot replace an agent whose stop is unconfirmed', { skip: process.platform !== 'darwin', timeout: 40000 }, async t => {
  const root = makeTempDir('grok-direct-busy-');
  const workspace = path.join(root, 'workspace'), data = path.join(root, 'data');
  fs.mkdirSync(workspace); fs.mkdirSync(data);
  const previousData = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const bin = path.join(root, 'fake-grok');
  const agent = fileURLToPath(new URL('./fixtures/direct-busy-unconfirmed-agent.mjs', import.meta.url));
  const signalGuard = fileURLToPath(new URL('./fixtures/direct-busy-unconfirmed-signal.cjs', import.meta.url));
  fs.writeFileSync(bin, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700 });
  const command = fileURLToPath(new URL('../plugins/grok/scripts/grok-companion.mjs', import.meta.url));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_BIN: bin, XAI_API_KEY: 'test-only',
    GROK_COMPANION_DISABLE_BROKER: '1', GROK_BUSY_TEST_ROOT: root, GROK_BUSY_TEST_BIN: bin,
    GROK_BUSY_TEST_STATE: path.join(stateDir, 'state.json'), NODE_OPTIONS: `--require=${signalGuard}` };
  const child = spawn(process.execPath, [command, 'task', '--cwd', workspace, '--json', 'test'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const file = name => path.join(root, name);
  const waitFor = async (predicate, label, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), `timed out waiting for ${label}: ${stderr}`);
  };
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    // Never signal an agent by PID. Wait for every started fixture to self-terminate.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const started = fs.readdirSync(root).filter(name => /^agent-\d+-started$/.test(name));
      if (started.every(name => fs.existsSync(file(name.replace('-started', '-exited'))))) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const started = fs.readdirSync(root).filter(name => /^agent-\d+-started$/.test(name));
    if (previousData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previousData;
    if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    if (started.some(name => !fs.existsSync(file(name.replace('-started', '-exited'))))) {
      t.diagnostic(`Retained fixture pending agent self-exit confirmation: ${root}`);
      return;
    }
    removeTempFixture(root, { recursive: true, force: true });
  });
  await waitFor(() => fs.existsSync(file('agent-1-started')), 'first agent');
  const original = JSON.parse(fs.readFileSync(file('agent-1-started'), 'utf8'));
  const result = await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('CLI did not finish before the agent self-exit deadline')), 8000))]);
  assert.notEqual(result.code, 0, `${stdout}\n${stderr}`);
  assert.equal(fs.existsSync(file('agent-1-exited')), false, 'the first agent must still be alive at this observation');
  const jobs = loadState(workspace).jobs;
  const job = jobs.find(item => item.id === original.jobId);
  assert.ok(job, JSON.stringify(jobs));
  assert.equal(fs.existsSync(file('agent-2-started')), false, 'an unconfirmed direct agent must not be restarted');
  assert.equal(job.grokDirectGeneration, original.generation, 'the unconfirmed generation must not be overwritten');
  assert.equal(job.terminationPending, true, 'unconfirmed stop must remain visible in the job');
  assert.equal(job.grokPromptState, 'pending', 'the unconfirmed error must survive the failed initialization');
});
