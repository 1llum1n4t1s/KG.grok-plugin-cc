import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { ensureBrokerSession, resolveBrokerStateDir } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";

// 失敗条件: lstat 後に hardlink が増えた session を既存 broker として受理する。
test("broker rejects a session hardlinked between lstat and open", { skip: process.platform !== "linux", timeout: 30000 }, async t => {
  const parent = fs.realpathSync.native(process.env.GROK_DIRECT_ADMISSION_TEST_ROOT || os.tmpdir());
  const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  assert.ok(path.isAbsolute(parent) && path.relative(repository, parent).startsWith(`..${path.sep}`));
  const root = fs.mkdtempSync(path.join(parent, "bhl-"));
  t.diagnostic(`Fixture retained: ${root}`);
  const cwd = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
  for (const directory of [cwd, data, temp]) fs.mkdirSync(directory);
  const fake = path.join(root, "fake-grok"), started = path.join(root, "agent-started"), exited = path.join(root, "agent-exited");
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
if(process.argv.includes('--version')||process.argv.includes('--help')) { console.log('fake 1'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_INODE_STARTED,'started');
process.on('exit',()=>fs.writeFileSync(process.env.FAKE_INODE_EXITED,'exited'));
setTimeout(()=>process.exit(0),8000).unref();
process.stdin.on('end',()=>process.exit(0));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:true}}}}));
  if(m.method==='session/list') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessions:[]}}));
});`, { mode: 0o755 });
  const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "GROK_BIN", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "XAI_API_KEY", "GROK_COMPANION_ACP_ENDPOINT", "FAKE_INODE_STARTED", "FAKE_INODE_EXITED"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_BIN: fake, HOME: root, USERPROFILE: root, TMPDIR: temp, TMP: temp, TEMP: temp, FAKE_INODE_STARTED: started, FAKE_INODE_EXITED: exited });
  delete process.env.XAI_API_KEY;
  delete process.env.GROK_COMPANION_ACP_ENDPOINT;
  const state = resolveStateDir(cwd);
  migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state });
  const sessionFile = path.join(resolveBrokerStateDir(cwd), "broker.json"), link = path.join(root, "broker-hardlink.json");
  let child, closed, injected = false;
  const originalOpen = fs.openSync;
  try {
    const session = await ensureBrokerSession(cwd, { timeoutMs: 12000, onBrokerSpawn(value) {
      child = value; child.ref();
      closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    } });
    assert.ok(session && child, "fixture broker did not start");
    const before = fs.readFileSync(sessionFile);
    fs.openSync = function (file, ...args) {
      if (file === sessionFile && !injected) {
        injected = true;
        fs.linkSync(sessionFile, link);
      }
      return originalOpen.call(this, file, ...args);
    };
    await assert.rejects(ensureBrokerSession(cwd, { timeoutMs: 6000 }), /saved broker session is invalid/);
    assert.ok(injected, "fixture did not add the hardlink during the read");
    assert.equal(fs.lstatSync(sessionFile).nlink, 2);
    assert.deepEqual(fs.readFileSync(sessionFile), before);
    assert.deepEqual(fs.readFileSync(link), before);
  } finally {
    fs.openSync = originalOpen;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (closed) {
      const result = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(null), 9000))]);
      t.diagnostic(`Owned broker close: ${JSON.stringify(result)}`);
      assert.ok(result, "owned broker did not close; fixture retained");
    }
    if (fs.existsSync(started) && !fs.existsSync(exited)) {
      const deadline = Date.now() + 9000;
      while (!fs.existsSync(exited) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(fs.existsSync(exited), "fake agent exit not confirmed; fixture retained");
    }
    const stopped = shutdownPosixStateLockSentinel(state, { offlineConfirmed: true, expectedStateDir: state });
    assert.equal(stopped.stopped, true);
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
});
