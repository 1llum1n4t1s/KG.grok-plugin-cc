import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Windows専用の明示実行E2E: node --test tests/state-lock-repro.mjs
// 既存再現の目的（生存ownerの奪取、死亡ownerの回復、後継lockの消去）を維持する。
// Windows native backend用。POSIXの排他・回復はposix-state-lock-e2e.test.mjsで検証する。
// helperによる削除は行わない。fixtureはdiagnosticに出力し、検証後のPrunlet清掃に残す。
const windowsOnly = { skip: process.platform !== "win32" ? "Windows native state-lock E2E only" : false };
const stateModule = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;
const companion = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const repository = fileURLToPath(new URL("../", import.meta.url));

function fixture(t) {
  const requestedParent = process.env.GROK_STATE_LOCK_TEST_ROOT || os.tmpdir();
  assert.ok(path.isAbsolute(requestedParent), "E2E parent must be an absolute existing path");
  const parent = path.resolve(requestedParent);
  const relative = path.relative(repository, parent);
  assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "E2E parent must be outside the repository");
  for (let current = parent; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Fixture parent must not traverse a link: ${current}`);
    if (path.dirname(current) === current) break;
  }
  assert.equal(fs.realpathSync.native(parent).toLowerCase(), parent.toLowerCase(), "Fixture parent must be canonical");
  fs.accessSync(parent, fs.constants.W_OK);
  const root = fs.mkdtempSync(path.join(parent, "grok-state-lock-e2e-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  t.diagnostic(`Retained fixture (no automatic deletion): ${root}`);
  return { root, workspace, env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(root, "data"), TEMP: root, TMP: root } };
}

function sourceFor(workspace, body) {
  return `import fs from "node:fs"; import path from "node:path";
    import { updateState, loadState, withStateSnapshot, resolveStateDir, resolveNativeStateLockEndpoint, migrateStateLock, ensureStateDir } from ${JSON.stringify(stateModule)};
    const workspace = ${JSON.stringify(workspace)};
    ${body}`;
}

function run(f, body) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", sourceFor(f.workspace, body)], {
    env: f.env, encoding: "utf8", windowsHide: true, timeout: 12000
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runMigrationCli(f, expectedStateDir) {
  const result = spawnSync(process.execPath, [companion, "state-lock", "migrate", "--offline-confirmed", "--local-only",
    "--expected-state-dir", expectedStateDir, "--cwd", f.workspace, "--json"], {
    cwd: f.workspace, env: f.env, encoding: "utf8", windowsHide: true, timeout: 12000
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function migrate(f) {
  const expectedStateDir = run(f, `console.log(JSON.stringify(resolveStateDir(workspace)));`);
  assert.ok(path.isAbsolute(expectedStateDir));
  const cli = runMigrationCli(f, expectedStateDir);
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.protocol, "native-local-v2");
  assert.equal(result.localOnly, true);
  assert.equal(result.stateDir, expectedStateDir);
}

async function waitUntil(check) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "child did not reach its barrier");
    await delay(20);
  }
}

test("migration CLI refuses a different absolute expected directory without creating state artifacts", windowsOnly, t => {
  const f = fixture(t);
  const stateDir = run(f, `console.log(JSON.stringify(resolveStateDir(workspace)));`);
  const different = path.join(f.root, "different-state");
  assert.ok(path.isAbsolute(different));
  assert.notEqual(different, stateDir);
  const before = fs.readdirSync(f.root).sort();
  assert.equal(fs.existsSync(f.env.CLAUDE_PLUGIN_DATA), false);
  const result = runMigrationCli(f, different);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /expected state directory does not match/i);
  assert.equal(fs.existsSync(stateDir), false);
  assert.equal(fs.existsSync(different), false);
  assert.equal(fs.existsSync(f.env.CLAUDE_PLUGIN_DATA), false);
  assert.deepEqual(fs.readdirSync(f.root).sort(), before);
});

test("an old mtime cannot transfer a live migrated snapshot lock to a cancelling process", windowsOnly, async t => {
  const f = fixture(t);
  migrate(f);
  run(f, `updateState(workspace, state => { state.jobs = [{ id: "job", status: "running" }]; }); console.log("{}");`);
  const ready = path.join(f.root, "ready");
  const release = path.join(f.root, "release");
  const sent = path.join(f.root, "prompt-sent");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", sourceFor(f.workspace, `
    withStateSnapshot(workspace, state => {
      fs.writeFileSync(${JSON.stringify(ready)}, path.join(resolveStateDir(workspace), "state.lock"));
      const deadline = Date.now() + 25000;
      while (!fs.existsSync(${JSON.stringify(release)})) {
        if (Date.now() > deadline) throw new Error("barrier timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      if (state.jobs[0].status === "running") fs.writeFileSync(${JSON.stringify(sent)}, "sent");
    });
  `)], { env: f.env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  holder.stderr.on("data", data => { stderr += data; });
  const exited = new Promise((resolve, reject) => {
    holder.once("error", reject);
    holder.once("close", resolve);
  });
  try {
    await waitUntil(() => fs.existsSync(ready));
    const lock = fs.readFileSync(ready, "utf8");
    const marker = fs.readFileSync(path.join(lock, "protocol.json"), "utf8");
    const stateBefore = run(f, `console.log(JSON.stringify(loadState(workspace)));`);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);
    const cancellation = run(f, `
      // Host/volume照会を先に済ませ、短い予算が実際のmutex競合まで到達するようにする。
      ensureStateDir(workspace);
      let entered = false;
      try {
        updateState(workspace, state => { entered = true; state.jobs[0].status = "cancelled"; }, { timeoutMs: 2000 });
        console.log(JSON.stringify({ acquired: true, entered }));
      } catch (error) { console.log(JSON.stringify({ acquired: false, entered, message: error.message })); }
    `);
    assert.equal(cancellation.acquired, false, "cancel must wait for snapshot/enqueue");
    assert.equal(cancellation.entered, false);
    assert.match(cancellation.message, /native state lock acquisition failed/i);
    assert.equal(fs.readFileSync(path.join(lock, "protocol.json"), "utf8"), marker);
    assert.deepEqual(run(f, `console.log(JSON.stringify(loadState(workspace)));`), stateBefore);
  } finally {
    fs.writeFileSync(release, "go");
    assert.equal(await exited, 0, stderr);
  }
  assert.equal(fs.existsSync(sent), true);
  const result = run(f, `updateState(workspace, state => { state.jobs[0].status = "cancelled"; });
    console.log(JSON.stringify(loadState(workspace).jobs[0]));`);
  assert.equal(result.status, "cancelled");
});

test("a crashed migrated snapshot owner releases the native mutex without an age threshold", windowsOnly, t => {
  const f = fixture(t);
  migrate(f);
  const crashed = run(f, `
    updateState(workspace, state => { state.config.beforeCrash = true; });
    withStateSnapshot(workspace, () => {
      console.log(JSON.stringify({ lock: path.join(resolveStateDir(workspace), "state.lock") }));
      process.exit(0);
    });
  `);
  const marker = fs.readFileSync(path.join(crashed.lock, "protocol.json"), "utf8");
  assert.equal(fs.statSync(crashed.lock).isDirectory(), true);
  const recovered = run(f, `
    updateState(workspace, state => { state.config.afterCrash = true; }, { timeoutMs: 2000 });
    console.log(JSON.stringify(loadState(workspace).config));
  `);
  assert.equal(recovered.beforeCrash, true);
  assert.equal(recovered.afterCrash, true);
  assert.equal(fs.statSync(crashed.lock).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(crashed.lock, "protocol.json"), "utf8"), marker);
});

test("renaming the data parent preserves the held mutex for the same Windows directory identity", windowsOnly, async t => {
  const f = fixture(t);
  migrate(f);
  const originalDir = run(f, `updateState(workspace,state=>{state.jobs=[{id:'job',status:'running'}];});console.log(JSON.stringify(resolveStateDir(workspace)));`);
  const originalData = f.env.CLAUDE_PLUGIN_DATA;
  const movedData = path.join(f.root, "data-renamed");
  const ready = path.join(f.root, "rename-ready.json");
  const release = path.join(f.root, "rename-release");
  const sent = path.join(f.root, "rename-sent");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", sourceFor(f.workspace, `
    withStateSnapshot(workspace,state=>{
      const identity=fs.statSync(resolveStateDir(workspace),{bigint:true});
      fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({dev:String(identity.dev),ino:String(identity.ino),endpoint:resolveNativeStateLockEndpoint(resolveStateDir(workspace))}));
      const deadline=Date.now()+25000;
      while(!fs.existsSync(${JSON.stringify(release)})){
        if(Date.now()>deadline)throw Error('rename holder timed out');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
      }
      if(state.jobs[0].status==='running')fs.writeFileSync(${JSON.stringify(sent)},'sent');
    });
  `)], { env: f.env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  holder.stderr.on("data", data => { stderr += data; });
  const exited = new Promise((resolve, reject) => { holder.once("error", reject); holder.once("close", resolve); });
  let observed;
  let cancelled;
  try {
    await waitUntil(() => fs.existsSync(ready));
    observed = JSON.parse(fs.readFileSync(ready, "utf8"));
    assert.ok(path.isAbsolute(originalData) && path.isAbsolute(movedData));
    assert.equal(path.dirname(originalData), f.root);
    assert.equal(path.dirname(movedData), f.root);
    assert.equal(path.parse(originalData).root, path.parse(movedData).root);
    assert.equal(fs.lstatSync(originalData).isSymbolicLink(), false);
    assert.equal(fs.existsSync(movedData), false);
    fs.renameSync(originalData, movedData);
    const movedDir = path.join(movedData, path.relative(originalData, originalDir));
    const movedIdentity = fs.statSync(movedDir, { bigint: true });
    assert.equal(String(movedIdentity.dev), observed.dev);
    assert.equal(String(movedIdentity.ino), observed.ino);
    f.env.CLAUDE_PLUGIN_DATA = movedData;
    cancelled = run(f, `
      ensureStateDir(workspace);
      const endpoint=resolveNativeStateLockEndpoint(resolveStateDir(workspace));
      let entered=false,message;
      try{updateState(workspace,state=>{entered=true;state.jobs[0].status='cancelled';},{timeoutMs:2000});}
      catch(error){message=error.message;}
      console.log(JSON.stringify({endpoint,entered,message,status:loadState(workspace).jobs[0].status}));
    `);
    assert.equal(cancelled.endpoint, observed.endpoint);
    assert.equal(cancelled.entered, false);
    assert.match(cancelled.message, /native state lock acquisition failed/i);
    assert.equal(cancelled.status, "running");
    assert.equal(fs.existsSync(sent), false);
  } finally {
    fs.writeFileSync(release, "go");
    assert.equal(await exited, 0, stderr);
  }
  assert.equal(fs.readFileSync(sent, "utf8"), "sent");
  assert.equal(run(f, `updateState(workspace,state=>{state.jobs[0].status='cancelled';});console.log(JSON.stringify(loadState(workspace).jobs[0].status));`), "cancelled");
});

for (const legacy of [false, true]) {
  test(`unmigrated snapshot/update cannot erase a replacement owner's lock (legacy file: ${legacy})`, windowsOnly, t => {
    const f = fixture(t);
    const result = run(f, `
      const stateDir = resolveStateDir(workspace);
      fs.mkdirSync(stateDir, { recursive: true });
      const stateFile = path.join(stateDir, "state.json");
      const original = '{"version":1,"config":{"sentinel":true},"jobs":[]}';
      fs.writeFileSync(stateFile, original);
      const lock = path.join(stateDir, "state.lock");
      const replacement = JSON.stringify({ pid: process.pid, token: "replacement-owner" });
      if (${legacy}) fs.writeFileSync(lock, replacement);
      const before = fs.readdirSync(stateDir).sort();
      const failures = [];
      let entered = false;
      for (const api of [withStateSnapshot, updateState]) {
        try { api(workspace, () => { entered = true; fs.writeFileSync(lock, replacement); }); }
        catch (error) { failures.push(error.message); }
      }
      let migrationFailure;
      if (${legacy}) {
        try { migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true }); }
        catch (error) { migrationFailure = error.message; }
      }
      console.log(JSON.stringify({ entered, failures, migrationFailure, replacement,
        before, after: fs.readdirSync(stateDir).sort(), original, state: fs.readFileSync(stateFile, "utf8"),
        retained: fs.existsSync(lock), contents: fs.existsSync(lock) ? fs.readFileSync(lock, "utf8") : null }));
    `);
    assert.equal(result.entered, false);
    assert.equal(result.failures.length, 2);
    for (const message of result.failures) assert.match(message, /explicit.*migration/i);
    assert.equal(result.state, result.original);
    assert.deepEqual(result.after, result.before, "rejection must not create jobs or replace old lock");
    assert.equal(result.retained, legacy);
    assert.equal(result.contents, legacy ? result.replacement : null);
    if (legacy) assert.match(result.migrationFailure, /legacy.*untouched/i);
  });
}
