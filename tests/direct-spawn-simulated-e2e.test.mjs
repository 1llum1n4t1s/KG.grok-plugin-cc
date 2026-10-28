import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { makeTempDir, removeTempFixture } from './helpers.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
for (const variant of ['cancel-first', 'owner-replaced', 'admission-replaced', 'spawn-first', 'guard-async-before', 'guard-async-after', 'guard-double', 'guard-wrong-return', 'guard-undefined-return', 'guard-return-getter']) {
  test(`simulated Linux state: ${variant} around real direct child spawn`, { skip: process.platform !== 'darwin', timeout: 20000 }, async t => {
    const root = makeTempDir('grok-simulated-spawn-');
    const file = name => path.join(root, name);
    const owner = { status: variant === 'cancel-first' ? 'cancelled' : 'running', epoch: 'original-epoch',
      owner: variant === 'owner-replaced' ? 'replacement-owner' : 'original-owner' };
    const state = { epoch: 'original-epoch', indexed: { ...owner }, stored: { ...owner },
      admission: variant === 'admission-replaced' ? 'replacement-admission' : 'original-admission' };
    fs.writeFileSync(file('state.json'), JSON.stringify(state));
    if (variant !== 'spawn-first') {
      // An unfixed implementation must fail promptly instead of waiting at the gates.
      fs.writeFileSync(file('spawn-release'), 'release');
      fs.writeFileSync(file('handshake-release'), 'release');
    }
    const bin = file('fake-grok');
    const agent = fileURLToPath(new URL('./fixtures/direct-spawn-simulated-agent.mjs', import.meta.url));
    fs.writeFileSync(bin, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700 });
    const child = fork(new URL('./fixtures/direct-spawn-simulated-worker.mjs', import.meta.url), [], {
      env: { ...process.env, GROK_SIMULATED_ROOT: root, GROK_SIMULATED_BIN: bin, GROK_SIMULATED_VARIANT: variant }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once('close', resolve));
    const answer = once(child, 'message');
    t.after(async () => {
      fs.writeFileSync(file('spawn-release'), 'release');
      fs.writeFileSync(file('handshake-release'), 'release');
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      if (fs.existsSync(file('spawn-called'))) {
        const deadline = Date.now() + 3000;
        while (!fs.existsSync(file('agent-exited')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        if (!fs.existsSync(file('agent-exited'))) {
          t.diagnostic(`Retained fixture pending child exit confirmation: ${root}`);
          return;
        }
      }
      removeTempFixture(root, { recursive: true, force: true });
    });
    const waitFor = async (name) => {
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(file(name)) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(fs.existsSync(file(name)), `timed out waiting for ${name}: ${stderr}`);
    };
    if (variant === 'spawn-first') {
      await waitFor('spawn-reached');
      assert.equal(fs.readFileSync(file('spawn-reached'), 'utf8'), 'true', 'spawn must be entered under the owner mutex');
      assert.ok(fs.existsSync(file('owner-checked')) && fs.existsSync(file('admission-checked')));
      assert.throws(() => fs.mkdirSync(file('mutex')), { code: 'EEXIST' }, 'cancellation cannot acquire the simulated mutex before spawn');
      fs.writeFileSync(file('spawn-release'), 'release');
      await waitFor('handshake-waiting');
      assert.equal(fs.readFileSync(file('spawn-called'), 'utf8'), 'true');
      fs.mkdirSync(file('mutex'));
      state.indexed.status = state.stored.status = 'cancelled';
      fs.writeFileSync(file('state.json'), JSON.stringify(state));
      fs.rmdirSync(file('mutex'));
      assert.ok(!fs.existsSync(file('handshake-release')), 'cancellation acquired the mutex while handshake was pending');
      fs.writeFileSync(file('handshake-release'), 'release');
      assert.equal((await answer)[0].outcome, 'connected', stderr);
    } else {
      const [result] = await answer;
      assert.equal(result.outcome, 'rejected', JSON.stringify(result));
      if (['guard-async-after', 'guard-double', 'guard-wrong-return', 'guard-undefined-return'].includes(variant)) {
        assert.equal(fs.readFileSync(file('spawn-count'), 'utf8'), 'spawn\n', 'at most one owned agent may start');
        assert.equal(fs.readFileSync(file('agent-ready'), 'utf8'), 'exit handler installed');
        assert.equal(result.stopProof, 'posix-group-empty', 'the started agent is stopped before rejecting the invalid guard');
        assert.equal(fs.readFileSync(file('agent-exited'), 'utf8'), 'exited', 'the ready agent actually exited');
      } else {
        assert.equal(fs.existsSync(file('spawn-reached')), false, 'stale owner, cancelled owner, stale admission or deferred guard must not spawn');
        if (variant === 'guard-return-getter') assert.equal(fs.existsSync(file('admission-attempt')), false, 'effect cannot enter admission verification after the guard returns');
      }
    }
  });
}
