import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { ensureBrokerSession, resolveBrokerStateDir } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";

// 失敗条件: ready owner が残るのに不正 session を不在と誤認して新 broker を起動する。
for (const fault of ["json", "hardlink", "null", "false", "zero", "incomplete"]) {
  test(`ready broker rejects ${fault} session without replacing owner`, { skip: process.platform !== "darwin", timeout: 40000 }, async t => {
    const parent = fs.realpathSync.native(process.env.GROK_DIRECT_ADMISSION_TEST_ROOT || "/tmp");
    const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    assert.ok(path.isAbsolute(parent) && path.relative(repository, parent).startsWith(`..${path.sep}`));
    const root = fs.mkdtempSync(path.join(parent, "bcs-"));
    t.diagnostic(`Fixture retained: ${root}`);
    const cwd = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
    for (const dir of [cwd, data, temp]) fs.mkdirSync(dir);
    const fake = path.join(root, "fake-grok"), started = path.join(root, "agents-started"), exited = path.join(root, "agents-exited");
    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
if(process.argv.includes('--version')||process.argv.includes('--help')) { console.log('fake 1'); process.exit(0); }
fs.appendFileSync(process.env.FAKE_INODE_STARTED,process.pid+'\n');
process.on('exit',()=>fs.appendFileSync(process.env.FAKE_INODE_EXITED,process.pid+'\n'));
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
    const sessionFile = path.join(resolveBrokerStateDir(cwd), "broker.json"), preserved = path.join(root, "saved-session.json");
    const children = [];
    const observe = child => {
      child.ref();
      children.push({ child, closed: new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal }))) });
    };
    try {
      const first = await ensureBrokerSession(cwd, { timeoutMs: 12000, onBrokerSpawn: observe });
      assert.ok(first && children.length === 1, "fixture broker did not start");
      const original = fs.readFileSync(sessionFile);
      fs.writeFileSync(preserved, original, { flag: "wx" });
      const malformed = { json: "{invalid\n", null: "null\n", false: "false\n", zero: "0\n", incomplete: '{"generation":"fixture"}\n' };
      if (fault === "hardlink") fs.linkSync(sessionFile, path.join(root, "session-hardlink.json"));
      else fs.writeFileSync(sessionFile, malformed[fault]);
      let error;
      try { await ensureBrokerSession(cwd, { timeoutMs: 12000, onBrokerSpawn: observe }); }
      catch (caught) { error = caught; }
      assert.match(error?.message ?? "", /saved broker session is invalid/, "invalid session must fail closed");
      assert.equal(children.length, 1, "invalid session must not spawn another broker");
      assert.equal(children[0].child.exitCode, null, "existing broker owner must remain alive");
      assert.deepEqual(fs.readFileSync(preserved), original);
      if (fault !== "hardlink") assert.equal(fs.readFileSync(sessionFile, "utf8"), malformed[fault]);
      else {
        assert.equal(fs.lstatSync(sessionFile).nlink, 2);
        assert.deepEqual(fs.readFileSync(sessionFile), original);
      }
    } finally {
      for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      for (const { closed } of children) {
        const result = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(null), 10000))]);
        t.diagnostic(`Owned broker close: ${JSON.stringify(result)}`);
        assert.ok(result, "owned broker did not close; fixture retained");
      }
      const lines = file => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).sort() : [];
      const deadline = Date.now() + 13000;
      while (JSON.stringify(lines(started)) !== JSON.stringify(lines(exited)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(lines(exited), lines(started), "fake agent exits not confirmed; fixture retained");
      for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    }
  });
}
