import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { reserveDirectAdmission } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { migrateStateLock, resolveStateDir, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { createLinuxEpochRecovery } from "../plugins/grok/scripts/lib/linux-epoch-recovery.mjs";

const posix = process.platform === "linux" || process.platform === "darwin";
const preloadSource = String.raw`
const fs = require('node:fs');
const original = fs.openSync;
let swapped = false;
fs.openSync = function(file, flags, ...args) {
  const target = process.env.ADMISSION_SWAP_TARGET;
  const mode = typeof flags === 'number' ? flags & 3 : -1;
  if (!swapped && target && String(file) === target && mode === Number(process.env.ADMISSION_SWAP_MODE)) {
    swapped = true;
    if (process.env.ADMISSION_SWAP_KIND === 'hardlink') fs.linkSync(target, process.env.ADMISSION_SWAP_ALIAS);
    else { fs.renameSync(target, process.env.ADMISSION_SWAP_SAVED); fs.renameSync(process.env.ADMISSION_SWAP_FIFO, target); }
    fs.writeFileSync(process.env.ADMISSION_SWAP_NOTICE, 'swapped');
  }
  return original.call(this, file, flags, ...args);
};
require('node:module').syncBuiltinESMExports();
`;

function fixture(t) {
  const parent = fs.realpathSync.native(process.env.GROK_DIRECT_ADMISSION_TEST_ROOT || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "grok-admission-fifo-"));
  const cwd = path.join(root, "workspace"), data = path.join(root, "data"), temp = path.join(root, "temp");
  for (const dir of [cwd, data, temp]) fs.mkdirSync(dir);
  const fake = path.join(root, "fake-grok"), log = path.join(root, "agent-started");
  fs.writeFileSync(fake, `#!${process.execPath}\n` + String.raw`
const fs=require('node:fs');
if(process.argv.includes('--version')||process.argv.includes('--help')) { console.log('fake 1'); process.exit(0); }
fs.writeFileSync(process.env.FAKE_AGENT_LOG,'started');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(m.method==='initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}}));
});
`, { mode: 0o755 });
  const keys = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA", "GROK_BIN", "FAKE_AGENT_LOG", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "GROK_COMPANION_ACP_ENDPOINT"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data, GROK_BIN: fake, FAKE_AGENT_LOG: log,
    HOME: root, USERPROFILE: root, TMPDIR: temp, TEMP: temp, TMP: temp });
  delete process.env.GROK_COMPANION_ACP_ENDPOINT;
  const state = resolveStateDir(cwd);
  migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state });
  const preload = path.join(root, "swap.cjs");
  fs.writeFileSync(preload, preloadSource);
  t.diagnostic(`Isolated fixture retained: ${root}`);
  t.after(() => {
    if (process.platform === "linux") shutdownPosixStateLockSentinel(state, { offlineConfirmed: true, expectedStateDir: state });
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  });
  const epoch = process.platform === "linux" ? JSON.parse(fs.readFileSync(path.join(state, "state.lock", "protocol.json"), "utf8")).epoch : null;
  const markerDir = process.platform === "linux" ? path.join(state, "direct-start-v2", epoch) : path.join(state, "direct-start-v1");
  return { root, cwd, state, preload, markerDir, fake, log };
}

async function runWorker(f, source, env, timeoutMs = 15000) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd: f.cwd, env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(f.preload)}`, ...env }, stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}

const lifecycle = new URL("../plugins/grok/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
const admission = new URL("../plugins/grok/scripts/lib/direct-start-admission.mjs", import.meta.url).href;

for (const phase of ["read", "append"]) {
  test(`direct marker ${phase} rejects a FIFO swapped after lstat before open`, { skip: !posix, timeout: 30000 }, async t => {
    const f = fixture(t), fifo = path.join(f.root, "replacement.fifo"), saved = path.join(f.root, "preserved-marker"), notice = path.join(f.root, "swap-notice");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
    let target = "";
    if (phase === "read") {
      const token = reserveDirectAdmission(f.cwd);
      target = path.join(f.markerDir, `${token.generation}.jsonl`);
    }
    const source = phase === "read" ? `import {ensureBrokerSession} from ${JSON.stringify(lifecycle)};
      try { await ensureBrokerSession(process.cwd(), {timeoutMs:7500}); console.log('ACCEPTED'); }
      catch(e) { console.log('REJECTED '+e.message); }` : `import {reserveDirectAdmission} from ${JSON.stringify(lifecycle)};
      import {finishDirectStart} from ${JSON.stringify(admission)}; import path from 'node:path';
      try { const token=reserveDirectAdmission(process.cwd()); process.env.ADMISSION_SWAP_TARGET=path.join(process.env.ADMISSION_MARKER_DIR,token.generation+'.jsonl');
        finishDirectStart(process.cwd(),token,'never-started'); console.log('ACCEPTED'); }
      catch(e) { console.log('REJECTED '+e.message); }`;
    const result = await runWorker(f, source, { ADMISSION_SWAP_TARGET: target, ADMISSION_MARKER_DIR: f.markerDir,
      ADMISSION_SWAP_MODE: phase === "read" ? "0" : "1", ADMISSION_SWAP_FIFO: fifo, ADMISSION_SWAP_SAVED: saved,
      ADMISSION_SWAP_NOTICE: notice, ADMISSION_SWAP_KIND: "fifo" });
    assert.equal(fs.existsSync(notice), true, `the lstat/open swap did not run: ${result.stdout} ${result.stderr}`);
    assert.equal(result.timedOut, false, `synchronous ${phase} open exceeded its deadline`);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /REJECTED /);
    assert.match(fs.readFileSync(saved, "utf8"), /"event":"pending"/);
    assert.equal(fs.readFileSync(saved, "utf8").includes('"event":"released"'), false);
    assert.equal(fs.existsSync(f.log), false, "no agent may start from an unconfirmed reservation");
  });
}

test("direct marker hardlink added between lstat and append open cannot receive a release", { skip: !posix, timeout: 30000 }, async t => {
  const f = fixture(t), alias = path.join(f.root, "marker-alias"), notice = path.join(f.root, "link-notice");
  const source = `import {reserveDirectAdmission} from ${JSON.stringify(lifecycle)};
    import {finishDirectStart} from ${JSON.stringify(admission)}; import path from 'node:path';
    try { const token=reserveDirectAdmission(process.cwd()); process.env.ADMISSION_SWAP_TARGET=path.join(process.env.ADMISSION_MARKER_DIR,token.generation+'.jsonl');
      finishDirectStart(process.cwd(),token,'never-started'); console.log('ACCEPTED'); }
    catch(e) { console.log('REJECTED '+e.message); }`;
  const result = await runWorker(f, source, { ADMISSION_SWAP_TARGET: "", ADMISSION_MARKER_DIR: f.markerDir,
    ADMISSION_SWAP_MODE: "1", ADMISSION_SWAP_KIND: "hardlink", ADMISSION_SWAP_ALIAS: alias, ADMISSION_SWAP_NOTICE: notice });
  assert.equal(fs.existsSync(notice), true, `the lstat/open hardlink race did not run: ${result.stdout} ${result.stderr}`);
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0, result.stderr);
  const content = fs.readFileSync(alias, "utf8");
  assert.match(content, /"event":"pending"/);
  assert.doesNotMatch(content, /"event":"released"|"event":"confirmed"/, "the shared inode must not be modified");
  assert.match(result.stdout, /REJECTED /);
});

test("explicit recovery refuses an old admission directory on another device", { skip: process.platform !== "linux", timeout: 45000 }, async t => {
  const f = fixture(t), mountpoint = path.join(f.state, "broker-v2");
  fs.mkdirSync(mountpoint);
  const mounted = spawnSync("mount", ["-t", "tmpfs", "-o", "size=1m", "tmpfs", mountpoint], { encoding: "utf8" });
  if (mounted.status !== 0) { t.skip(`fixture tmpfs mount unavailable: ${(mounted.stderr || mounted.error?.message || "unknown").trim()}`); return; }
  let client;
  try {
    assert.notEqual(fs.statSync(f.state, { bigint: true }).dev, fs.statSync(mountpoint, { bigint: true }).dev);
    fs.writeFileSync(path.join(mountpoint, "broker-admission.jsonl"), '{"event":"pending"}\n');
    let failure;
    try {
      withStateSnapshot(f.cwd, (_state, context) => createLinuxEpochRecovery(context, {
        offlineConfirmed: true, localOnly: true, allOldProcessesStopped: true, expectedStateDir: f.state
      }), { strictWorkspace: true, timeoutMs: 15000 });
      client = await GrokAcpClient.connect(f.cwd, { disableBroker: true, grokBin: f.fake });
    } catch (error) { failure = error; }
    assert.ok(failure, "a different-device submount must not be authorized");
    assert.match(failure.message, /device|mount|filesystem/i);
    assert.equal(fs.existsSync(f.log), false, "the agent must not start from an invalid inventory");
  } finally {
    if (client) await client.close();
    const unmounted = spawnSync("umount", [mountpoint], { encoding: "utf8" });
    assert.equal(unmounted.status, 0, `fixture mount remains at ${mountpoint}: ${unmounted.stderr || unmounted.error?.message}`);
  }
});
