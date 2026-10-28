import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { cleanupIdleBrokerSession, ensureBrokerSession, resolveBrokerStateDir } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";

// 失敗条件: 大きな inode の丸めで spawned の記録が拒否され、pending が残る。
test("broker startup preserves a journal inode beyond Number precision", { skip: process.platform !== "darwin", timeout: 30000 }, async t => {
  const parent = fs.realpathSync.native(process.env.GROK_DIRECT_ADMISSION_TEST_ROOT || "/tmp");
  const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  assert.ok(path.isAbsolute(parent) && path.relative(repository, parent).startsWith(`..${path.sep}`));
  const root = fs.mkdtempSync(path.join(parent, "bri-"));
  t.diagnostic(`Fixture retained: ${root}`);
  const cwd = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
  for (const directory of [cwd, data, temp]) fs.mkdirSync(directory);
  const fake = path.join(root, "fake-grok");
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
if(process.argv.includes('--version')||process.argv.includes('--help')) { console.log('fake 1'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_INODE_STARTED, 'started');
process.on('exit',()=>fs.writeFileSync(process.env.FAKE_INODE_EXITED, 'exited'));
setTimeout(()=>process.exit(0), 8000).unref();
process.stdin.on('end',()=>process.exit(0));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:true}}}}));
  if(m.method==='session/list') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessions:[]}}));
});`, { mode: 0o755 });
  const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "GROK_BIN", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "XAI_API_KEY", "GROK_COMPANION_ACP_ENDPOINT", "FAKE_INODE_STARTED", "FAKE_INODE_EXITED"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const started = path.join(root, "agent-started"), exited = path.join(root, "agent-exited");
  Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_BIN: fake, HOME: root, USERPROFILE: root, TMPDIR: temp, TMP: temp, TEMP: temp, FAKE_INODE_STARTED: started, FAKE_INODE_EXITED: exited });
  delete process.env.XAI_API_KEY;
  delete process.env.GROK_COMPANION_ACP_ENDPOINT;
  const state = resolveStateDir(cwd);
  migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state });
  const journal = path.join(resolveBrokerStateDir(cwd), "broker-admission.jsonl");
  const actualInode = 9007199254740993n;
  assert.notEqual(BigInt(Number(actualInode)), actualInode);
  const original = { lstatSync: fs.lstatSync, fstatSync: fs.fstatSync, openSync: fs.openSync, closeSync: fs.closeSync };
  const descriptors = new Set();
  let numberReads = 0, bigintReads = 0, session, brokerClosed;
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (command, args, options) {
    const child = originalSpawn.call(this, command, args, options);
    if (options?.cwd === cwd && args?.[1] === "serve") {
      child.ref();
      brokerClosed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    }
    return child;
  };
  syncBuiltinESMExports();
  const replaceInode = (stat, options) => {
    if (options?.bigint) { bigintReads++; stat.ino = actualInode; }
    else { numberReads++; stat.ino = Number(actualInode); }
    return stat;
  };
  fs.openSync = function (file, ...args) {
    const fd = original.openSync.call(this, file, ...args);
    if (file === journal) descriptors.add(fd);
    return fd;
  };
  fs.closeSync = function (fd, ...args) { descriptors.delete(fd); return original.closeSync.call(this, fd, ...args); };
  fs.lstatSync = function (file, options) {
    const stat = original.lstatSync.call(this, file, options);
    return file === journal ? replaceInode(stat, options) : stat;
  };
  fs.fstatSync = function (fd, options) {
    const stat = original.fstatSync.call(this, fd, options);
    return descriptors.has(fd) ? replaceInode(stat, options) : stat;
  };
  try {
    session = await ensureBrokerSession(cwd, { timeoutMs: 12000 });
    assert.ok(session, "broker startup should succeed with a large journal inode");
    const events = fs.readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line).event);
    assert.deepEqual(events, ["pending", "spawned", "settled", "confirmed"]);
    assert.ok(bigintReads > 0, "fixture must exercise bigint journal stats");
    assert.equal(await cleanupIdleBrokerSession(cwd, session, { timeoutMs: 6000 }), true);
    session = null;
  } finally {
    if (session) {
      try { await cleanupIdleBrokerSession(cwd, session, { timeoutMs: 6000 }); }
      catch (error) { t.diagnostic(`Broker cleanup failed: ${error.message}`); }
    }
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    Object.assign(fs, original);
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    t.diagnostic(`Journal stats: Number=${numberReads}, BigInt=${bigintReads}`);
    if (brokerClosed) {
      const closed = await Promise.race([brokerClosed, new Promise(resolve => setTimeout(() => resolve(null), 10000))]);
      t.diagnostic(`Owned broker close: ${JSON.stringify(closed)}`);
      assert.ok(closed, "owned broker did not close; fixture retained");
    }
    if (fs.existsSync(started) && !fs.existsSync(exited)) {
      const deadline = Date.now() + 9000;
      while (!fs.existsSync(exited) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(fs.existsSync(exited), "fake agent exit not confirmed; fixture retained");
    }
  }
});
