import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// macOS の process / filesystem を使い、Linux procfs・mount・flock は模擬。
// 実 Linux kernel の検証ではない。新規作成と不明な既存状態は別の fixture で確認する。
test("Linux state lock initializes a fresh v6 state", { skip: process.platform !== "darwin", timeout: 60000 }, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-v6-fresh-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const previous = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const env = { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA;
  const options = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  const run = action => spawnSync(process.execPath, [cli, "state-lock", action, ...options], { env, encoding: "utf8", timeout: 30000 });
  let sentinel = false, safe = false;
  t.after(() => {
    try {
      if (sentinel) {
        const stopped = run("stop-sentinel");
        assert.equal(stopped.error, undefined); assert.equal(stopped.signal, null); assert.equal(stopped.status, 0, stopped.stderr);
        safe = true;
      }
      if (safe) removeTempFixture(root, { recursive: true, force: true });
      else t.diagnostic(`Fresh fixture retained: ${root}`);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
      if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    }
  });
  assert.equal(fs.existsSync(stateDir), false);
  const fresh = run("migrate");
  sentinel = fresh.status === 0 && fresh.signal === null && !fresh.error;
  assert.equal(fresh.error, undefined); assert.equal(fresh.signal, null); assert.equal(fresh.status, 0, fresh.stderr);
  const marker = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8"));
  assert.equal(marker.protocol, "posix-linux-worker-lease-v6");
});

test("Linux state lock preserves unverified v6 marker and journal", { skip: process.platform !== "darwin", timeout: 60000 }, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-v6-gate-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const previous = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const module = new URL("../plugins/grok/scripts/lib/posix-state-lock.mjs", import.meta.url).href;
  const env = { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA;
  const args = [cli, "state-lock", "migrate", "--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  const run = argv => spawnSync(process.execPath, argv, { env, encoding: "utf8", timeout: 30000 });
  let safe = false;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
    if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    if (safe) removeTempFixture(root, { recursive: true, force: true }); else t.diagnostic(`Fixture retained: ${root}`);
  });
  fs.mkdirSync(path.join(stateDir, "state.lock"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(stateDir, "history-journal-v1"), { mode: 0o700 });
  const marker = path.join(stateDir, "state.lock", "protocol.json"), journal = path.join(stateDir, "history-journal-v1", "unverified");
  const markerBytes = Buffer.from('{"protocol":"posix-linux-worker-lease-v6","evidence":"preserve"}\n');
  const journalBytes = Buffer.from("unverified journal evidence\n");
  fs.writeFileSync(marker, markerBytes, { mode: 0o600 }); fs.writeFileSync(journal, journalBytes, { mode: 0o600 });
  const markerId = fs.statSync(marker, { bigint: true }), journalId = fs.statSync(journal, { bigint: true });
  const existing = run(args);
  assert.equal(existing.error, undefined); assert.equal(existing.signal, null);
  assert.ok(Number.isInteger(existing.status)); assert.notEqual(existing.status, 0, "v6 migration must reject");
  assert.deepEqual(fs.readFileSync(marker), markerBytes); assert.deepEqual(fs.readFileSync(journal), journalBytes);
  assert.equal(fs.statSync(marker, { bigint: true }).ino, markerId.ino);
  assert.equal(fs.statSync(journal, { bigint: true }).ino, journalId.ino);
  assert.deepEqual(fs.readdirSync(path.join(stateDir, "state.lock")), ["protocol.json"]);
  const script = `import {withPosixStateLock} from ${JSON.stringify(module)};
    try {withPosixStateLock(${JSON.stringify(stateDir)}, {}, () => { console.log('CALLBACK'); }, {timeoutMs: 0}); process.exitCode=2;}
    catch (e) { console.error(e.message); }`;
  const writer = run(["--input-type=module", "-e", script]);
  assert.equal(writer.error, undefined); assert.equal(writer.signal, null);
  assert.equal(writer.status, 0, writer.stderr); assert.equal(writer.stdout, "");
  assert.match(writer.stderr, /offline|unavailable|disabled/i);
  assert.deepEqual(fs.readFileSync(marker), markerBytes); assert.deepEqual(fs.readFileSync(journal), journalBytes);
  assert.equal(fs.statSync(marker, { bigint: true }).ino, markerId.ino);
  assert.equal(fs.statSync(journal, { bigint: true }).ino, journalId.ino);
  safe = true;
});
