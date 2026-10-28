import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// この E2E は専用の POSIX fixture だけを扱い、Windows では作成前に skip する。
const parent = process.env.GROK_SOCKET_TEST_ROOT;
const enabled = process.platform === "darwin" && !!parent;
const runner = fileURLToPath(new URL("./fixtures/broker-socket-path-e2e.mjs", import.meta.url));

test("Darwin broker socket byte boundary, cleanup and fail-closed startup", { skip: !enabled, timeout: 120000 }, (t) => {
  const canonical = fs.realpathSync.native(parent);
  assert.equal(canonical, path.resolve(parent));
  assert.ok(fs.lstatSync(canonical).isDirectory());
  const root = fs.mkdtempSync(path.join(canonical, "sock-"));
  let passed = false;
  t.after(() => { if (passed) fs.rmSync(root, { recursive: true, force: true }); else t.diagnostic(`Retained fixture: ${root}`); });
  const fake = path.join(root, "fake-grok.cjs");
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
if(process.argv.includes('--version')||process.argv.includes('--help')) { console.log('fake 1'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_AGENT_LOG,'started');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{list:true}}}}));
 if(m.method==='session/list') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessions:[]}}));
});
`, { mode: 0o755 });
  for (const [length, unicode, mode, expected] of [
    [104, false, "normal", "broker.sock"], [104, true, "normal", "broker.sock"], [105, false, "normal", "b"],
    [105, false, "legacy", "broker.sock"],
    [105, true, "normal", "b"], [105, false, "unknown", "b"],
    [105, false, "link", "b"], [115, true, "too-long", ""]
  ]) {
    const suffix = "/gkc-000000/broker.sock";
    const seed = unicode ? "あ" : "";
    const pad = length - Buffer.byteLength(root + "/" + seed + suffix);
    assert.ok(pad >= 0, "fixture root is too long for the requested boundary");
    const temp = path.join(root, seed + "x".repeat(pad));
    fs.mkdirSync(temp, { recursive: true });
    const cwd = fs.mkdtempSync(path.join(root, "workspace-"));
    const data = fs.mkdtempSync(path.join(root, "data-"));
    const log = path.join(root, `agent-${length}-${unicode}-${mode}`);
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_BIN: fake, FAKE_AGENT_LOG: log,
      HOME: root, USERPROFILE: root, TMPDIR: temp, TMP: temp, TEMP: temp };
    delete env.XAI_API_KEY; delete env.GROK_COMPANION_ACP_ENDPOINT; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, [runner, cwd, data, expected, mode], { env, encoding: "utf8", timeout: 25000 });
    assert.equal(result.status, 0, `${length}/${unicode}/${mode}: ${result.stderr}\n${result.stdout}`);
    assert.equal(JSON.parse(result.stdout.trim()).ok, true);
    assert.equal(fs.existsSync(log), mode !== "too-long" && mode !== "legacy");
    assert.deepEqual(fs.readdirSync(temp), []);
  }
  passed = true;
});
