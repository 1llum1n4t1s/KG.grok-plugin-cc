import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { ensureBrokerSession, resolveBrokerStateDir } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";

// 失敗条件: 非同期確認が丸めで別 inode を同一視、または link 増加を見逃す。
for (const fault of ["inode", "hardlink"]) {
  test(`broker confirmation rejects changed journal ${fault}`, { skip: process.platform !== "darwin", timeout: 30000 }, async t => {
    const parent = fs.realpathSync.native(process.env.GROK_DIRECT_ADMISSION_TEST_ROOT || "/tmp");
    const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
    assert.ok(path.isAbsolute(parent) && path.relative(repository, parent).startsWith(`..${path.sep}`));
    const root = fs.mkdtempSync(path.join(parent, "bco-"));
    t.diagnostic(`Fixture retained: ${root}`);
    const cwd = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
    for (const dir of [cwd, data, temp]) fs.mkdirSync(dir);
    const fake = path.join(root, "fake-grok"), started = path.join(root, "agent-started"), exited = path.join(root, "agent-exited"), forwarded = path.join(root, "agent-request");
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
  if(m.method==='session/new') { fs.writeFileSync(process.env.FAKE_INODE_FORWARDED,'forwarded'); console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:'fixture'}})); }
});`, { mode: 0o755 });
    const preload = path.join(root, "inject.cjs"), injected = path.join(root, "injected");
    fs.writeFileSync(preload, String.raw`
const fs=require('node:fs'), target=process.env.FAKE_INODE_JOURNAL, mode=process.env.FAKE_INODE_FAULT;
const lstat=fs.promises.lstat.bind(fs.promises), open=fs.promises.open.bind(fs.promises);
let injected=false;
fs.promises.lstat=async function(file,options) {
  const result=await lstat(file,options);
  if(file===target && mode==='inode') result.ino=options?.bigint ? 9007199254740992n : Number(9007199254740992n);
  return result;
};
fs.promises.open=async function(file,...args) {
  if(file===target && mode==='hardlink' && !injected) { injected=true; fs.linkSync(file,process.env.FAKE_INODE_LINK); }
  const handle=await open(file,...args);
  if(file===target && mode==='inode') {
    const stat=handle.stat.bind(handle);
    handle.stat=async function(options) { const result=await stat(options); fs.writeFileSync(process.env.FAKE_INODE_INJECTED,'injected'); result.ino=options?.bigint ? 9007199254740993n : Number(9007199254740993n); return result; };
  }
  return handle;
};`);
    const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "GROK_BIN", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "XAI_API_KEY", "GROK_COMPANION_ACP_ENDPOINT", "FAKE_INODE_STARTED", "FAKE_INODE_EXITED", "FAKE_INODE_FORWARDED"];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_BIN: fake, HOME: root, USERPROFILE: root, TMPDIR: temp, TMP: temp, TEMP: temp, FAKE_INODE_STARTED: started, FAKE_INODE_EXITED: exited, FAKE_INODE_FORWARDED: forwarded });
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_COMPANION_ACP_ENDPOINT;
    const state = resolveStateDir(cwd);
    migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state });
    const journal = path.join(resolveBrokerStateDir(cwd), "broker-admission.jsonl"), link = path.join(root, "journal-hardlink.jsonl");
    let child, closed;
    try {
      const env = { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}`, FAKE_INODE_JOURNAL: journal, FAKE_INODE_FAULT: fault, FAKE_INODE_LINK: link, FAKE_INODE_INJECTED: injected };
      const session = await ensureBrokerSession(cwd, { env, timeoutMs: 12000, onBrokerSpawn(value) {
        child = value; child.ref();
        closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
      } });
      assert.ok(session && child, "fixture broker did not start");
      const response = await new Promise((resolve, reject) => {
        const socket = net.createConnection(session.endpoint.slice(5));
        let buffer = "";
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("broker response timed out")); }, 3000);
        socket.once("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd, mcpServers: [] } })}\n`));
        socket.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) { clearTimeout(timer); socket.destroy(); resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n")))); } });
        socket.once("error", error => { clearTimeout(timer); reject(error); });
      });
      if (fault === "hardlink") assert.ok(fs.existsSync(link), "hardlink injection did not run");
      else assert.ok(fs.existsSync(injected), "inode injection did not run");
      assert.equal(response.error?.code, -32002, JSON.stringify(response));
      assert.equal(fs.existsSync(forwarded), false);
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
