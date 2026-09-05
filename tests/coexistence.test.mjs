import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { copyTestDirectory, makeTempDir } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins/grok');
function execute(executable, args, env, cwd, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: 'pipe' });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Child timed out')); }, 15000);
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${code}: ${stderr}`)); });
    child.stdin.end(input);
  });
}

for (const endingHost of ['claude', 'codex']) {
  test(`separate installations remain isolated when ${endingHost} exits`, async () => {
    const temp = makeTempDir('grok-coexist-');
    const workspace = path.join(temp, 'shared workspace');
    fs.mkdirSync(workspace);
    const hosts = ['claude', 'codex'].map(name => {
      const install = path.join(temp, name, 'installed plugin');
      const data = path.join(temp, name, 'plugin data');
      copyTestDirectory(root, install);
      const env = { ...process.env };
      for (const key of ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'PLUGIN_ROOT', 'PLUGIN_DATA', 'CLAUDE_ENV_FILE', 'GROK_COMPANION_SESSION_ID', 'CODEX_THREAD_ID', 'GROK_COMPANION_ACP_ENDPOINT', 'GROK_COMPANION_APP_SERVER_PID_FILE', 'GROK_COMPANION_APP_SERVER_LOG_FILE']) delete env[key];
      env[name === 'claude' ? 'CLAUDE_PLUGIN_ROOT' : 'PLUGIN_ROOT'] = install;
      env[name === 'claude' ? 'CLAUDE_PLUGIN_DATA' : 'PLUGIN_DATA'] = data;
      const manifest = JSON.parse(fs.readFileSync(path.join(install, 'hooks/hooks.json'), 'utf8'));
      return { name, install, data, env, manifest };
    });
    const runHook = (host, event) => {
      const command = host.manifest.hooks[event][0].hooks[0].command;
      return execute(process.platform === 'win32' ? 'pwsh' : '/bin/sh', process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command], host.env, workspace,
        JSON.stringify({ cwd: workspace, session_id: 'same-session-id', hook_event_name: event }));
    };
    await Promise.all(hosts.map(host => runHook(host, 'SessionStart')));
    // 同じワークスペース・セッションID・ジョブIDでも、各インストールの保存先は独立する。
    const results = await Promise.all(hosts.map(host => {
      const moduleUrl = pathToFileURL(path.join(host.install, 'scripts/lib/state.mjs')).href;
      const code = `import { upsertJob, resolveStateDir } from ${JSON.stringify(moduleUrl)}; for(let i=0;i<20;i++) upsertJob(process.cwd(),{id:'job-'+i,sessionId:'same-session-id',status:'running',owner:${JSON.stringify(host.name)}}); console.log(resolveStateDir(process.cwd()));`;
      return execute(process.execPath, ['--input-type=module', '-e', code], host.env, workspace);
    }));
    const dirs = results.map(result => result.stdout.trim());
    assert.notEqual(dirs[0], dirs[1]);
    hosts.forEach((host, i) => {
      assert.ok(dirs[i].startsWith(host.data + path.sep));
      const state = JSON.parse(fs.readFileSync(path.join(dirs[i], 'state.json'), 'utf8'));
      assert.equal(state.jobs.length, 20);
      assert.ok(state.jobs.every(job => job.owner === host.name));
    });
    await Promise.all(hosts.map(host => runHook(host, 'Stop')));
    const endingIndex = hosts.findIndex(host => host.name === endingHost);
    const survivingIndex = 1 - endingIndex;
    const survivorFile = path.join(dirs[survivingIndex], 'state.json');
    const before = fs.readFileSync(survivorFile, 'utf8');
    // 他方のブローカー状態も終了処理で消えないことを確かめる。
    const brokerFile = path.join(dirs[survivingIndex], 'broker.json');
    fs.writeFileSync(brokerFile, JSON.stringify({ marker: 'survivor' }));
    await runHook(hosts[endingIndex], 'SessionEnd');
    assert.equal(fs.readFileSync(survivorFile, 'utf8'), before);
    assert.equal(JSON.parse(fs.readFileSync(brokerFile, 'utf8')).marker, 'survivor');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dirs[endingIndex], 'state.json'), 'utf8')).jobs.length, 0);
  });
}
