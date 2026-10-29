import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { copyTestDirectory, makeTempDir, removeTempFixture } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins/grok');
function execute(executable, args, env, cwd, input = '', children = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: 'pipe' });
    children.push(child);
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Child timed out')); }, 30000);
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${code}: ${stderr}`)); });
    child.stdin.end(input);
  });
}

for (const endingHost of ['claude', 'codex']) {
  test(`separate installations remain isolated when ${endingHost} exits`, async t => {
    const temp = makeTempDir('grok-coexist-');
    const children = [], owners = [], identities = [];
    let hosts;
    t.after(async () => {
      try {
        for (const owner of owners) owner.child.stdin.end('release\n');
        for (const owner of owners) {
          const result = await Promise.race([owner.closed, new Promise(resolve => { const timer = setTimeout(() => resolve(null), 10000); timer.unref(); })]);
          assert.ok(result && result.code === 0, 'owned worker did not exit normally');
        }
        assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null), 'fixture child exit is unconfirmed');
        if (process.platform === 'linux') {
          assert.equal(identities.length, 2, 'both state identities must be established');
          for (const [index, identity] of identities.entries()) {
            const host = hosts[index];
            const stateUrl = pathToFileURL(path.join(host.install, 'scripts/lib/state.mjs')).href;
            const lockUrl = pathToFileURL(path.join(host.install, 'scripts/lib/posix-state-lock.mjs')).href;
            assert.ok(identity.stateDir.startsWith(host.data + path.sep));
            const code = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
              import {resolveStateDir} from ${JSON.stringify(stateUrl)};
              import {shutdownPosixStateLockSentinel} from ${JSON.stringify(lockUrl)};
              const expected=${JSON.stringify(identity)}; const stateDir=resolveStateDir(process.cwd());
              assert.equal(stateDir,expected.stateDir,'host state directory changed');
              const protocol=JSON.parse(fs.readFileSync(path.join(stateDir,'state.lock','protocol.json'),'utf8'));
              assert.equal(protocol.epoch,expected.epoch,'host state epoch changed');
              const stopped=shutdownPosixStateLockSentinel(stateDir,{offlineConfirmed:true,expectedStateDir:expected.stateDir});
              assert.equal(stopped.stateDir,expected.stateDir); assert.equal(stopped.epoch,expected.epoch); assert.equal(stopped.stopped,true);
              console.log(JSON.stringify(stopped));`;
            const result = JSON.parse((await execute(process.execPath, ['--input-type=module', '-e', code], host.env, workspace, '', children)).stdout.trim());
            assert.equal(result.stateDir, identity.stateDir);
            assert.equal(result.epoch, identity.epoch);
            assert.equal(result.stopped, true);
          }
        }
        removeTempFixture(temp, { recursive: true, force: true });
      } catch (error) {
        t.diagnostic(`Fixture retained: ${temp}`);
        throw error;
      }
    });
    const workspace = path.join(temp, 'shared workspace');
    fs.mkdirSync(workspace);
    hosts = ['claude', 'codex'].map(name => {
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
        JSON.stringify({ cwd: workspace, session_id: 'same-session-id', hook_event_name: event }), children);
    };
    await Promise.all(hosts.map(host => runHook(host, 'SessionStart')));
    // 同じワークスペース・セッションID・ジョブIDでも、各インストールの保存先は独立する。
    const results = await Promise.all(hosts.map(host => {
      const moduleUrl = pathToFileURL(path.join(host.install, 'scripts/lib/state.mjs')).href;
      // 終了済み20件と停止証拠のない1件を、各ホストの個別ファイルにも保存する。
      const code = `import { migrateStateLock, updateState, resolveStateDir, writeJobFile } from ${JSON.stringify(moduleUrl)};
        if (['win32', 'linux', 'darwin'].includes(process.platform)) migrateStateLock(process.cwd(), {
          offlineConfirmed: true, localOnly: true, expectedStateDir: resolveStateDir(process.cwd())
        });
        let epoch; updateState(process.cwd(), (state, context) => { epoch=context.epoch; for(let i=0;i<21;i++) { const timestamp = new Date().toISOString(); const job = {createdAt:timestamp,updatedAt:timestamp,id:'job-'+i,sessionId:'same-session-id',status:i<20?'completed':'running',owner:${JSON.stringify(host.name)}}; state.jobs.unshift(job); writeJobFile(process.cwd(), job.id, job); } }); console.log(JSON.stringify({stateDir:resolveStateDir(process.cwd()),epoch}));`;
      return execute(process.execPath, ['--input-type=module', '-e', code], host.env, workspace, '', children);
    }));
    identities.push(...results.map(result => JSON.parse(result.stdout.trim())));
    const dirs = identities.map(identity => identity.stateDir);
    assert.notEqual(dirs[0], dirs[1]);
    if (process.platform === 'linux') assert.notEqual(identities[0].epoch, identities[1].epoch);
    hosts.forEach((host, i) => {
      assert.ok(dirs[i].startsWith(host.data + path.sep));
      const state = JSON.parse(fs.readFileSync(path.join(dirs[i], 'state.json'), 'utf8'));
      assert.equal(state.jobs.length, 21);
      assert.ok(state.jobs.every(job => job.owner === host.name));
    });
    if (process.platform === 'linux') {
      await Promise.all(hosts.map(async (host, index) => {
        const trackedUrl = pathToFileURL(path.join(host.install, 'scripts/lib/tracked-jobs.mjs')).href;
        const code = `import {runTrackedJob} from ${JSON.stringify(trackedUrl)};
          let entered=false;
          try { await runTrackedJob({id:'owned-job',workspaceRoot:process.cwd(),sessionId:'same-session-id',jobClass:'task',title:'Fixture',grokPromptState:'not-sent'},
            async owner => { entered=true; console.log(JSON.stringify({ready:true,pid:process.pid,epoch:owner.epoch,claimToken:owner.claimToken,leaseId:owner.workerLease.id}));
              await new Promise(resolve=>process.stdin.once('data',resolve)); return {exitStatus:'completed'}; }); }
          catch(error) { if (!entered || !/cancelled or became terminal/i.test(error.message)) { console.error(error.stack); process.exitCode=1; } }`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: workspace, env: host.env, stdio: ['pipe', 'pipe', 'pipe'] });
        children.push(child);
        child.stdin.on('error', () => {});
        const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
        const owner = { child, closed }; owners.push(owner);
        let stderr = '', stdout = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        const ready = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`worker readiness timed out: ${stderr}`)), 30000);
          child.stdout.on('data', chunk => {
            stdout += chunk;
            if (stdout.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(stdout.slice(0, stdout.indexOf('\n')))); } catch (error) { reject(error); } }
          });
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', () => { clearTimeout(timer); reject(new Error(`worker exited before readiness: ${stderr}`)); });
        });
        assert.equal(ready.pid, child.pid);
        assert.equal(ready.epoch, identities[index].epoch);
        assert.ok(ready.claimToken && ready.leaseId);
        owner.identity = ready;
      }));
    }
    if (process.platform === 'linux') {
      for (const [index, host] of hosts.entries()) {
        const stateUrl = pathToFileURL(path.join(host.install, 'scripts/lib/state.mjs')).href;
        const ledgerUrl = pathToFileURL(path.join(host.install, 'scripts/lib/linux-lease-ledger.mjs')).href;
        const code = `import {withStateSnapshot,readJobFile,resolveJobFile} from ${JSON.stringify(stateUrl)};
          import {verifyPublishedLinuxLeaseRecords} from ${JSON.stringify(ledgerUrl)};
          import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
          withStateSnapshot(process.cwd(), (state, context) => {
            const indexed=state.jobs.find(job=>job.id==='owned-job'), stored=readJobFile(resolveJobFile(process.cwd(),'owned-job'));
            verifyPublishedLinuxLeaseRecords({context,indexed,stored,lease:indexed.workerLease});
            const fd=fs.openSync(indexed.workerLease.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
            try { const stat=fs.fstatSync(fd,{bigint:true});
              if(String(stat.dev)!==indexed.workerLease.dev||String(stat.ino)!==indexed.workerLease.ino) throw Error('lease identity changed');
              const probe=spawnSync('/usr/bin/flock',['-x','-n','-E','200','3'],{stdio:['ignore','pipe','pipe',fd],timeout:2000});
              if(probe.error||probe.signal) throw Error('lease lock probe failed');
              console.log(JSON.stringify({epoch:context.epoch,indexed,stored,leaseStatus:probe.status}));
            } finally { fs.closeSync(fd); }
          });`;
        const probe = JSON.parse((await execute(process.execPath, ['--input-type=module','-e',code], host.env, workspace, '', children)).stdout.trim());
        assert.equal(probe.epoch, identities[index].epoch);
        assert.equal(probe.indexed.sessionId, 'same-session-id');
        assert.equal(probe.stored.sessionId, probe.indexed.sessionId);
        assert.equal(probe.indexed.status, 'running');
        assert.equal(probe.stored.status, probe.indexed.status);
        assert.equal(probe.leaseStatus, 200, 'worker must still own its lease');
        for (const key of ['id','epoch','claimToken','createdAt','startedAt','processStartKey','grokTransport','grokBrokerGeneration','grokDirectGeneration','grokDirectOwnerPid','grokDirectOwnerStartKey','terminationPending','grokPromptState','grokSessionId']) {
          assert.equal(probe.indexed[key], probe.stored[key], `job records disagree on ${key}`);
        }
        assert.deepEqual(probe.indexed.workerLease, probe.stored.workerLease);
      }
    }
    await Promise.all(hosts.map(host => runHook(host, 'Stop')));
    const endingIndex = hosts.findIndex(host => host.name === endingHost);
    const survivingIndex = 1 - endingIndex;
    const survivorFile = path.join(dirs[survivingIndex], 'state.json');
    const before = fs.readFileSync(survivorFile, 'utf8');
    // 他方のブローカー状態も終了処理で消えないことを確かめる。
    const brokerFile = path.join(dirs[survivingIndex], 'broker.json');
    fs.writeFileSync(brokerFile, JSON.stringify({ marker: 'survivor' }));
    const ended = await runHook(hosts[endingIndex], 'SessionEnd');
    if (ended.stderr) t.diagnostic(`SessionEnd stderr: ${ended.stderr}`);
    assert.equal(fs.readFileSync(survivorFile, 'utf8'), before);
    assert.equal(JSON.parse(fs.readFileSync(brokerFile, 'utf8')).marker, 'survivor');
    const remaining = JSON.parse(fs.readFileSync(path.join(dirs[endingIndex], 'state.json'), 'utf8')).jobs;
    if (process.platform === 'linux') {
      assert.equal(remaining.length, 22);
      for (let i = 0; i < 21; i++) {
        const record = remaining.find(job => job.id === `job-${i}`);
        assert.ok(record, `unverified job-${i} was removed`);
        assert.equal(record.status, i < 20 ? 'completed' : 'running');
        assert.equal(record.owner, endingHost);
        assert.equal(record.epoch, undefined);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs[endingIndex], 'jobs', `job-${i}.json`), 'utf8')), record);
      }
      const owned = remaining.find(job => job.id === 'owned-job');
      assert.ok(owned);
      assert.equal(owned.status, 'cancelled');
      assert.equal(owned.terminationPending, true);
      assert.equal(owned.workerStopConfirmed, false);
      assert.equal(owned.epoch, identities[endingIndex].epoch);
      const owner = owners.find(item => item.identity?.epoch === identities[endingIndex].epoch);
      assert.ok(owner);
      assert.equal(owned.pid, owner.identity.pid);
      assert.equal(owned.claimToken, owner.identity.claimToken);
      assert.equal(owned.workerLease.id, owner.identity.leaseId);
      const detail = JSON.parse(fs.readFileSync(path.join(dirs[endingIndex], 'jobs', 'owned-job.json'), 'utf8'));
      for (const key of ['id', 'status', 'terminationPending', 'workerStopConfirmed', 'epoch', 'pid', 'claimToken']) assert.equal(detail[key], owned[key]);
      assert.deepEqual(detail.workerLease, owned.workerLease);
    } else if (process.platform === 'darwin') {
      assert.equal(remaining.length, 21);
      for (let i = 0; i < 21; i++) {
        const record = remaining.find(job => job.id === `job-${i}`);
        assert.ok(record, `unverified job-${i} was removed`);
        assert.equal(record.status, i < 20 ? 'completed' : 'running');
        assert.equal(record.owner, endingHost);
        assert.equal(record.sessionId, 'same-session-id');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs[endingIndex], 'jobs', `job-${i}.json`), 'utf8')), record);
      }
    } else {
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].id, 'job-20');
      assert.equal(remaining[0].status, 'cancelled');
      assert.equal(remaining[0].terminationPending, true);
    }
  });
}
