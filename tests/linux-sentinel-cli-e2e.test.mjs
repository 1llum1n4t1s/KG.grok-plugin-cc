import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { migrateStateLock, resolveStateDir, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { requireLinuxEpochRecovery, snapshotLegacyAdmission } from "../plugins/grok/scripts/lib/linux-epoch-recovery.mjs";

// 先行失敗条件: 確認欠落・異なる対象の停止、他 OS での受理、停止後の暗黙再利用。
test("state-lock stop-sentinel requires explicit offline scope", { skip: process.platform !== "linux" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sentinel-cli-"));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(workspace); fs.mkdirSync(data);
  const previous = { claude: process.env.CLAUDE_PLUGIN_DATA, plugin: process.env.PLUGIN_DATA };
  process.env.CLAUDE_PLUGIN_DATA = data; process.env.PLUGIN_DATA = data;
  const stateDir = resolveStateDir(workspace);
  let migrated = false, stopped = false;
  t.after(() => {
    try {
      if (!migrated) { t.diagnostic(`Retained unconfirmed sentinel fixture: ${root}`); return; }
      if (!stopped) assert.equal(shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir }).stopped, true);
    } finally {
      if (previous.claude === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous.claude;
      if (previous.plugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previous.plugin;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  migrated = true;
  // 同一 sentinel を別実行ファイルから検証し、argv[0] の偽装は拒否する。
  const markerFile = path.join(stateDir, "state.lock", "protocol.json");
  const markerBefore = fs.readFileSync(markerFile), markerStat = fs.lstatSync(markerFile, { bigint: true });
  const marker = JSON.parse(markerBefore), alternateNode = path.join(root, "alternate-node");
  fs.copyFileSync(process.execPath, alternateNode, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(alternateNode, 0o700);
  const originalExe = fs.statSync(process.execPath, { bigint: true });
  const alternateExe = fs.statSync(alternateNode, { bigint: true });
  assert.ok(originalExe.dev !== alternateExe.dev || originalExe.ino !== alternateExe.ino, "alternate Node must have a distinct file identity");
  const stateApi = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;
  const snapshotSource = `import { withStateSnapshot } from ${JSON.stringify(stateApi)};
    withStateSnapshot(${JSON.stringify(workspace)}, (_state, context) => console.log(JSON.stringify({epoch:context.epoch})));`;
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data };
  const alternate = spawnSync(alternateNode, ["--input-type=module", "-e", snapshotSource], {
    cwd: workspace, env, encoding: "utf8", timeout: 15000
  });
  assert.ifError(alternate.error);
  assert.equal(alternate.status, 0, alternate.stderr);
  assert.equal(JSON.parse(alternate.stdout.trim()).epoch, marker.epoch);
  const preload = path.join(root, "sentinel-cmdline-spoof.cjs"), observed = path.join(root, "spoof-observed");
  fs.writeFileSync(preload, `const fs = require('node:fs'), mod = require('node:module');
    const read = fs.readFileSync;
    fs.readFileSync = function(name, ...args) {
      const value = read.call(this, name, ...args);
      if (String(name) !== process.env.SENTINEL_TEST_CMDLINE) return value;
      const fields = value.toString('utf8').split('\\0');
      fields[0] = process.env.SENTINEL_TEST_FAKE_EXE;
      fs.writeFileSync(process.env.SENTINEL_TEST_OBSERVED, 'observed');
      return Buffer.from(fields.join('\\0'));
    };
    mod.syncBuiltinESMExports();`, { mode: 0o600 });
  const spoof = spawnSync(process.execPath, ["--require", preload, "--input-type=module", "-e", snapshotSource], {
    cwd: workspace, env: { ...env, SENTINEL_TEST_CMDLINE: `/proc/${marker.sentinel.pid}/cmdline`,
      SENTINEL_TEST_FAKE_EXE: alternateNode, SENTINEL_TEST_OBSERVED: observed }, encoding: "utf8", timeout: 15000
  });
  assert.ifError(spoof.error);
  assert.equal(fs.existsSync(observed), true, "sentinel cmdline spoof was not exercised");
  assert.notEqual(spoof.status, 0);
  assert.match(spoof.stderr, /sentinel.*(?:unavailable|invalid)/i);
  // 絶対 symlink も sentinel の root を基準に解決する。
  const alias = path.join(root, "node-absolute-alias"), aliasObserved = path.join(root, "alias-observed");
  fs.symlinkSync(process.execPath, alias);
  const aliasResult = spawnSync(process.execPath, ["--require", preload, "--input-type=module", "-e", snapshotSource], {
    cwd: workspace, env: { ...env, SENTINEL_TEST_CMDLINE: `/proc/${marker.sentinel.pid}/cmdline`,
      SENTINEL_TEST_FAKE_EXE: alias, SENTINEL_TEST_OBSERVED: aliasObserved }, encoding: "utf8", timeout: 15000
  });
  assert.ifError(aliasResult.error);
  assert.equal(fs.existsSync(aliasObserved), true, "absolute symlink argv was not exercised");
  assert.equal(aliasResult.status, 0, aliasResult.stderr);
  assert.equal(JSON.parse(aliasResult.stdout.trim()).epoch, marker.epoch);
  assert.deepEqual(fs.readFileSync(markerFile), markerBefore);
  const markerAfter = fs.lstatSync(markerFile, { bigint: true });
  assert.equal(markerAfter.dev, markerStat.dev);
  assert.equal(markerAfter.ino, markerStat.ino);
  withStateSnapshot(workspace, (_state, context) => assert.equal(context.epoch, marker.epoch));
  const script = path.resolve("plugins/grok/scripts/grok-companion.mjs");
  const run = args => spawnSync(process.execPath, [script, "state-lock", "stop-sentinel", ...args, "--cwd", workspace, "--json"], {
    cwd: workspace, env: { ...process.env, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data }, encoding: "utf8", timeout: 15000
  });
  for (const args of [
    ["--local-only", "--expected-state-dir", stateDir],
    ["--offline-confirmed", "--expected-state-dir", stateDir],
    ["--offline-confirmed", "--local-only", "--expected-state-dir", path.join(root, "wrong")]
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    withStateSnapshot(workspace, () => {});
  }
  const result = run(["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stopped, true);
  assert.equal(payload.stateDir, stateDir);
  stopped = true;
  assert.ok(fs.existsSync(path.join(stateDir, "state.lock")));
  assert.throws(() => withStateSnapshot(workspace, () => {}), /sentinel|recovery/i);
});

test("state-lock stop-sentinel rejects non-Linux platforms", { skip: process.platform === "linux" }, () => {
  const script = path.resolve("plugins/grok/scripts/grok-companion.mjs");
  const result = spawnSync(process.execPath, [script, "state-lock", "stop-sentinel", "--offline-confirmed", "--local-only",
    "--expected-state-dir", path.resolve(os.tmpdir(), "unused")], { encoding: "utf8", timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Linux/i);
});

// 先行失敗条件: 停止・再起動防止や単一 host の確認欠落、別対象の復旧、
// 旧記録の変更、破損した確認値の受理、失敗を成功として表示する。
test("state-lock recover records explicit offline recovery for the exact Linux state directory", { skip: process.platform !== "linux" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-recovery-cli-"));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(workspace); fs.mkdirSync(data);
  const previous = { claude: process.env.CLAUDE_PLUGIN_DATA, plugin: process.env.PLUGIN_DATA };
  process.env.CLAUDE_PLUGIN_DATA = data; process.env.PLUGIN_DATA = data;
  const stateDir = resolveStateDir(workspace);
  let migrated = false, childUnconfirmed = false;
  t.after(() => {
    try {
      if (!migrated || childUnconfirmed) { t.diagnostic(`Retained unconfirmed fixture: ${root}`); return; }
      assert.equal(shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir }).stopped, true);
    } finally {
      if (previous.claude === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous.claude;
      if (previous.plugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previous.plugin;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { epoch } = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  migrated = true;
  const old = path.join(stateDir, "broker.json");
  fs.writeFileSync(old, "legacy admission evidence");
  const inspect = fn => withStateSnapshot(workspace, (_state, context) => fn(context));
  const inventory = inspect(snapshotLegacyAdmission);
  assert.throws(() => inspect(requireLinuxEpochRecovery));
  const script = path.resolve("plugins/grok/scripts/grok-companion.mjs");
  const confirmed = ["--offline-confirmed", "--local-only", "--all-old-processes-stopped", "--expected-state-dir", stateDir];
  const run = args => {
    const result = spawnSync(process.execPath, [script, "state-lock", "recover", ...args, "--cwd", workspace, "--json"], {
      cwd: workspace, env: { ...process.env, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data }, encoding: "utf8", timeout: 15000
    });
    if (result.status === null) childUnconfirmed = true;
    return result;
  };
  const invalid = [
    ["--local-only", "--all-old-processes-stopped", "--expected-state-dir", stateDir],
    ["--offline-confirmed", "--all-old-processes-stopped", "--expected-state-dir", stateDir],
    ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir],
    ["--offline-confirmed", "--local-only", "--all-old-processes-stopped=false", "--expected-state-dir", stateDir],
    ["--offline-confirmed", "--local-only", "--all-old-processes-stopped=invalid", "--expected-state-dir", stateDir],
    ["--offline-confirmed", "--local-only", "--all-old-processes-stopped", "--expected-state-dir", path.join(root, "wrong")],
    ["--offline-confirmed", "--local-only", "--all-old-processes-stopped", "--expected-state-dir", "relative"]
  ];
  for (const args of invalid) {
    const result = run(args);
    assert.notEqual(result.status, 0, `must reject ${args.join(" ")}`);
    assert.throws(() => inspect(requireLinuxEpochRecovery));
    assert.deepEqual(inspect(snapshotLegacyAdmission), inventory);
    assert.equal(fs.readFileSync(old, "utf8"), "legacy admission evidence");
  }
  const result = run(confirmed);
  t.diagnostic(`confirmed recovery: status=${result.status}; stderr=${JSON.stringify(result.stderr)}`);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.stateDir, stateDir);
  assert.equal(payload.epoch, epoch);
  inspect(requireLinuxEpochRecovery);
  assert.deepEqual(inspect(snapshotLegacyAdmission), inventory);
  assert.equal(fs.readFileSync(old, "utf8"), "legacy admission evidence");
});

test("state-lock recover rejects non-Linux platforms", { skip: process.platform === "linux" }, () => {
  const script = path.resolve("plugins/grok/scripts/grok-companion.mjs");
  const result = spawnSync(process.execPath, [script, "state-lock", "recover", "--offline-confirmed", "--local-only",
    "--all-old-processes-stopped", "--expected-state-dir", path.resolve(os.tmpdir(), "unused")], { encoding: "utf8", timeout: 15000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Linux/i);
});

// 失敗条件: 対象不一致と判明する前に、別 state の jobs 等を作成する。
test("state-lock recover rejects an incorrect directory before touching the effective state", { skip: process.platform !== "linux" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-recovery-target-"));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(workspace); fs.mkdirSync(data);
  const previous = { claude: process.env.CLAUDE_PLUGIN_DATA, plugin: process.env.PLUGIN_DATA };
  process.env.CLAUDE_PLUGIN_DATA = data; process.env.PLUGIN_DATA = data;
  const stateDir = resolveStateDir(workspace);
  let migrated = false, childUnconfirmed = false;
  t.after(() => {
    try {
      if (!migrated || childUnconfirmed) { t.diagnostic(`Retained unconfirmed fixture: ${root}`); return; }
      assert.equal(shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir }).stopped, true);
    } finally {
      if (previous.claude === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous.claude;
      if (previous.plugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previous.plugin;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  migrated = true;
  // 名前だけでなく、既存記録の置換や上書きも検知する。
  const snapshot = () => {
    const entries = [];
    const visit = (file, relative) => {
      const stat = fs.lstatSync(file, { bigint: true });
      const entry = { relative, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid, nlink: stat.nlink };
      if (stat.isDirectory()) {
        entry.children = fs.readdirSync(file).sort();
        entries.push(entry);
        for (const name of entry.children) visit(path.join(file, name), path.join(relative, name));
      } else {
        if (stat.isFile()) entry.content = fs.readFileSync(file);
        else if (stat.isSymbolicLink()) entry.link = fs.readlinkSync(file);
        entries.push(entry);
      }
    };
    visit(stateDir, ".");
    return entries;
  };
  const before = snapshot();
  const script = path.resolve("plugins/grok/scripts/grok-companion.mjs");
  const result = spawnSync(process.execPath, [script, "state-lock", "recover", "--offline-confirmed", "--local-only",
    "--all-old-processes-stopped", "--expected-state-dir", path.join(root, "wrong"), "--cwd", workspace], {
    cwd: workspace, env: { ...process.env, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data }, encoding: "utf8", timeout: 15000
  });
  if (result.status === null) childUnconfirmed = true;
  assert.notEqual(result.status, null, "recovery CLI must exit");
  assert.notEqual(result.status, 0);
  assert.deepEqual(snapshot(), before, "incorrect target must not alter the effective state tree");
});
