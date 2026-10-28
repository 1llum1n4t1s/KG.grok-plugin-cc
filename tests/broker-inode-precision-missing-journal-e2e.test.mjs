import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { ensureBrokerSession, reserveDirectAdmission, resolveBrokerStateDir } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";

// 失敗条件: settled の後に journal が退避され、空の journal と direct 起動が許される。
test("removed journal cannot become an empty admission after settlement", { skip: process.platform !== "darwin", timeout: 45000 }, async t => {
  const parent = fs.realpathSync.native(process.env.GROK_DIRECT_ADMISSION_TEST_ROOT || "/tmp");
  const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  assert.ok(path.isAbsolute(parent) && path.relative(repository, parent).startsWith(`..${path.sep}`));
  const root = fs.mkdtempSync(path.join(parent, "bmj-"));
  t.diagnostic(`Fixture retained: ${root}`);
  const cwd = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
  for (const directory of [cwd, data, temp]) fs.mkdirSync(directory);
  const fake = path.join(root, "fake-grok"), started = path.join(root, "agent-started"), exited = path.join(root, "agent-exited");
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
if(process.argv.includes('--version')||process.argv.includes('--help')) { console.log('fake 1'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_INODE_STARTED,'started');
process.on('exit',()=>fs.writeFileSync(process.env.FAKE_INODE_EXITED,'exited'));
setTimeout(()=>process.exit(0),12000).unref();
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
  const journal = path.join(resolveBrokerStateDir(cwd), "broker-admission.jsonl"), saved = path.join(root, "saved-journal.jsonl");
  const originalOpen = fs.openSync, originalWrite = fs.writeSync, originalClose = fs.closeSync;
  const journalFds = new Set();
  let settled = false, injected = false, child, closed, savedBytes;
  fs.openSync = function (file, flags, ...args) {
    if (file === journal && settled && !injected && typeof flags === "number" && (flags & fs.constants.O_WRONLY)) {
      injected = true;
      fs.renameSync(journal, saved);
      savedBytes = fs.readFileSync(saved);
    }
    const fd = originalOpen.call(this, file, flags, ...args);
    if (file === journal) journalFds.add(fd);
    return fd;
  };
  fs.writeSync = function (fd, buffer, ...args) {
    const result = originalWrite.call(this, fd, buffer, ...args);
    if (journalFds.has(fd) && Buffer.isBuffer(buffer) && buffer.toString().includes('"event":"settled"')) settled = true;
    return result;
  };
  fs.closeSync = function (fd, ...args) { journalFds.delete(fd); return originalClose.call(this, fd, ...args); };
  try {
    await assert.rejects(ensureBrokerSession(cwd, { timeoutMs: 12000, onBrokerSpawn(value) {
      child = value; child.ref();
      closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    } }));
    assert.ok(injected && child, "fixture did not reach the post-settlement journal append");
    assert.match(savedBytes.toString(), /"event":"settled"/);
    assert.deepEqual(fs.readFileSync(saved), savedBytes);
    const recreated = fs.existsSync(journal);
    let absentError;
    if (!recreated) {
      try { reserveDirectAdmission(cwd, { timeoutMs: 6000 }); } catch (error) { absentError = error; }
      fs.writeFileSync(journal, "", { flag: "wx" });
    }
    let emptyError;
    try { reserveDirectAdmission(cwd, { timeoutMs: 6000 }); } catch (error) { emptyError = error; }
    assert.match(emptyError?.message ?? "", /Broker admission journal/, "empty journal must reject direct admission");
    assert.equal(recreated, false, "missing journal must not be recreated empty");
    assert.match(absentError?.message ?? "", /Broker admission journal/, "missing journal must reject direct admission");
    assert.equal(fs.readFileSync(journal).length, 0);
    assert.deepEqual(fs.readFileSync(saved), savedBytes);
    assert.equal(child.exitCode, null, "unconfirmed ready owner must be preserved");
  } finally {
    fs.openSync = originalOpen; fs.writeSync = originalWrite; fs.closeSync = originalClose;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (closed) {
      const result = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(null), 10000))]);
      t.diagnostic(`Owned broker close: ${JSON.stringify(result)}`);
      assert.ok(result, "owned broker did not close; fixture retained");
    }
    if (fs.existsSync(started) && !fs.existsSync(exited)) {
      const deadline = Date.now() + 13000;
      while (!fs.existsSync(exited) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(fs.existsSync(exited), "fake agent exit not confirmed; fixture retained");
    }
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
});
