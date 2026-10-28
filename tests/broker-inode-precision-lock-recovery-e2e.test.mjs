import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { finishDirectStart } from "../plugins/grok/scripts/lib/direct-start-admission.mjs";
import { ensureBrokerSession, reserveDirectAdmission, resolveBrokerStateDir } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";

// 失敗条件: pending 前の失敗で lock が残る、または確認済み journal と孤立 lock を誤拒否する。
for (const scenario of ["pre-pending-retry", "confirmed-orphan-lock"]) {
  test(`broker lock preserves ${scenario}`, { skip: process.platform !== "darwin", timeout: 30000 }, async t => {
    const parent = fs.realpathSync.native(process.env.GROK_DIRECT_ADMISSION_TEST_ROOT || "/tmp");
    const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    assert.ok(path.isAbsolute(parent) && path.relative(repository, parent).startsWith(`..${path.sep}`));
    const root = fs.mkdtempSync(path.join(parent, "blr-"));
    t.diagnostic(`Fixture retained: ${root}`);
    const cwd = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
    for (const dir of [cwd, data, temp]) fs.mkdirSync(dir);
    const fake = path.join(root, "fake-grok"), started = path.join(root, "agent-started"), exited = path.join(root, "agent-exited");
    fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
if(process.argv.includes('--version')||process.argv.includes('--help')) { console.log('fake 1'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_INODE_STARTED,'started');
process.on('exit',()=>fs.writeFileSync(process.env.FAKE_INODE_EXITED,'exited'));
setTimeout(()=>process.exit(0),10000).unref();
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
    const dir = resolveBrokerStateDir(cwd), journal = path.join(dir, "broker-admission.jsonl"), lock = path.join(dir, "broker.lock");
    let child, closed;
    try {
      if (scenario === "pre-pending-retry") {
        await assert.rejects(ensureBrokerSession(cwd, { timeoutMs: 6000, createBrokerEndpoint() { throw new Error("fixture endpoint failure"); } }), /fixture endpoint failure/);
        assert.equal(fs.existsSync(journal), false);
        assert.equal(fs.existsSync(lock), false, "pre-pending failure must release its lock");
      }
      const session = await ensureBrokerSession(cwd, { timeoutMs: 12000, onBrokerSpawn(value) {
        child = value; child.ref();
        closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
      } });
      assert.ok(session && child, "new or retried broker must start");
      const records = fs.readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(records.at(-1).event, "confirmed");
      if (scenario === "confirmed-orphan-lock") {
        const token = "orphaned-lock-fixture\n";
        fs.writeFileSync(lock, token, { flag: "wx" });
        const direct = reserveDirectAdmission(cwd, { timeoutMs: 6000 });
        assert.ok(direct, "confirmed journal permits direct fallback despite an orphan lock");
        assert.equal(finishDirectStart(cwd, direct, "never-started", { timeoutMs: 6000 }), true);
        assert.equal(fs.readFileSync(lock, "utf8"), token);
      }
      assert.equal(child.exitCode, null);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (closed) {
        const result = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(null), 10000))]);
        t.diagnostic(`Owned broker close: ${JSON.stringify(result)}`);
        assert.ok(result, "owned broker did not close; fixture retained");
      }
      if (fs.existsSync(started) && !fs.existsSync(exited)) {
        const deadline = Date.now() + 11000;
        while (!fs.existsSync(exited) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(fs.existsSync(exited), "fake agent exit not confirmed; fixture retained");
      }
      for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    }
  });
}
