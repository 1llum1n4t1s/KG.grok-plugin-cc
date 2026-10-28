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
  const before = fs.readdirSync(stateDir).sort();
  assert.equal(fs.existsSync(path.join(stateDir, "jobs")), false);
  const script = path.resolve("plugins/grok/scripts/grok-companion.mjs");
  const result = spawnSync(process.execPath, [script, "state-lock", "recover", "--offline-confirmed", "--local-only",
    "--all-old-processes-stopped", "--expected-state-dir", path.join(root, "wrong"), "--cwd", workspace], {
    cwd: workspace, env: { ...process.env, CLAUDE_PLUGIN_DATA: data, PLUGIN_DATA: data }, encoding: "utf8", timeout: 15000
  });
  if (result.status === null) childUnconfirmed = true;
  assert.notEqual(result.status, 0);
  t.diagnostic(`state entries before=${JSON.stringify(before)} after=${JSON.stringify(fs.readdirSync(stateDir).sort())}`);
  assert.deepEqual(fs.readdirSync(stateDir).sort(), before);
});
