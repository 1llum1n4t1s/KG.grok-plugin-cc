import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { ensureBrokerSession, reserveDirectAdmission, resolveBrokerStateDir } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";

// 失敗条件: pending/spawned 中の journal 消失・空化を初回と誤認し direct を認可する。
for (const fault of ["empty", "missing", "missing-after"]) {
  test(`unconfirmed broker rejects direct admission after journal ${fault}`, { skip: process.platform !== "darwin", timeout: 30000 }, async t => {
    const parent = fs.realpathSync.native(process.env.GROK_DIRECT_ADMISSION_TEST_ROOT || "/tmp");
    const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    assert.ok(path.isAbsolute(parent) && path.relative(repository, parent).startsWith(`..${path.sep}`));
    const root = fs.mkdtempSync(path.join(parent, "buc-"));
    t.diagnostic(`Fixture retained: ${root}`);
    const cwd = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
    for (const dir of [cwd, data, temp]) fs.mkdirSync(dir);
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
  if(m.method==='initialize') fs.writeFileSync(process.env.FAKE_INODE_INITIALIZE,'waiting');
});`, { mode: 0o755 });
    const initialize = path.join(root, "agent-initialize");
    const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "GROK_BIN", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "XAI_API_KEY", "GROK_COMPANION_ACP_ENDPOINT", "FAKE_INODE_STARTED", "FAKE_INODE_EXITED", "FAKE_INODE_INITIALIZE"];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_BIN: fake, HOME: root, USERPROFILE: root, TMPDIR: temp, TMP: temp, TEMP: temp, FAKE_INODE_STARTED: started, FAKE_INODE_EXITED: exited, FAKE_INODE_INITIALIZE: initialize });
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_COMPANION_ACP_ENDPOINT;
    const state = resolveStateDir(cwd);
    migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state });
    const dir = resolveBrokerStateDir(cwd), journal = path.join(dir, "broker-admission.jsonl"), saved = path.join(root, "saved-journal.jsonl");
    let child, closed, startup;
    try {
      startup = ensureBrokerSession(cwd, { timeoutMs: 12000, onBrokerSpawn(value) {
        child = value; child.ref();
        closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
      } }).then(session => ({ session }), error => ({ error: error.message }));
      const deadline = Date.now() + 7000;
      while (!fs.existsSync(initialize) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(fs.existsSync(initialize) && child, "fake agent did not reach blocked initialize");
      assert.equal(fs.existsSync(path.join(dir, "broker.json")), false);
      const bytes = fs.readFileSync(journal), events = bytes.toString().trim().split("\n").map(line => JSON.parse(line).event);
      assert.deepEqual(events, ["pending", "spawned"]);
      if (fault === "empty") { fs.writeFileSync(saved, bytes); fs.truncateSync(journal, 0); }
      else fs.renameSync(journal, saved);
      assert.deepEqual(fs.readFileSync(saved), bytes);
      assert.equal(child.exitCode, null);
      if (fault === "missing-after") {
        child.kill("SIGTERM");
        assert.ok(await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(null), 9000))]), "owned broker did not close");
        t.diagnostic(`Startup result: ${JSON.stringify(await startup)}`);
        assert.ok(fs.existsSync(path.join(dir, "broker.lock")), "journal disappearance must preserve the startup lock");
      }
      assert.throws(() => reserveDirectAdmission(cwd, { timeoutMs: 1500 }), /Broker admission journal/, `journal ${fault} must reject direct admission`);
      assert.deepEqual(fs.readFileSync(saved), bytes);
      if (fault !== "missing-after") assert.equal(child.exitCode, null);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (closed) {
        const result = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(null), 9000))]);
        t.diagnostic(`Owned broker close: ${JSON.stringify(result)}`);
        assert.ok(result, "owned broker did not close; fixture retained");
      }
      if (startup) t.diagnostic(`Startup result: ${JSON.stringify(await startup)}`);
      if (fs.existsSync(started) && !fs.existsSync(exited)) {
        const deadline = Date.now() + 9000;
        while (!fs.existsSync(exited) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(fs.existsSync(exited), "fake agent exit not confirmed; fixture retained");
      }
      for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    }
  });
}
