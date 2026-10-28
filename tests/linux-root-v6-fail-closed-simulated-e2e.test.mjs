import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// macOS の process / filesystem を使い、Linux procfs・mount・flock は模擬。
// 未完成の protocol 境界で新規 marker が作られる、旧 marker が書き換わる、
// native lock callback が実行される場合は失敗。実 Linux kernel の検証ではない。
test("Linux state lock rejects new and v6 state until the offline boundary is complete", { skip: process.platform !== "darwin", timeout: 60000 }, t => {
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
  let safe = false, sentinel = false;
  t.after(() => {
    const stop = sentinel ? run([cli, "state-lock", "stop-sentinel", ...args.slice(3)]) : null;
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
    if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    if (safe) removeTempFixture(root, { recursive: true, force: true }); else t.diagnostic(`Fixture retained: ${root}`);
    if (stop) assert.equal(stop.status, 0, `Sentinel stop failed; fixture retained: ${stop.stderr}`);
  });
  const fresh = run(args);
  sentinel = fresh.status === 0;
  assert.notEqual(fresh.status, 0, "fresh migration must reject");
  assert.match(fresh.stderr, /offline|unavailable|disabled/i);
  assert.equal(fs.existsSync(stateDir), false, "fresh migration must not create state");
  fs.mkdirSync(path.join(stateDir, "state.lock"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(stateDir, "history-journal-v1"), { mode: 0o700 });
  const marker = path.join(stateDir, "state.lock", "protocol.json"), journal = path.join(stateDir, "history-journal-v1", "unverified");
  const markerBytes = Buffer.from('{"protocol":"posix-linux-worker-lease-v6","evidence":"preserve"}\n');
  const journalBytes = Buffer.from("unverified journal evidence\n");
  fs.writeFileSync(marker, markerBytes, { mode: 0o600 }); fs.writeFileSync(journal, journalBytes, { mode: 0o600 });
  const existing = run(args); assert.notEqual(existing.status, 0, "v6 migration must reject");
  assert.deepEqual(fs.readFileSync(marker), markerBytes); assert.deepEqual(fs.readFileSync(journal), journalBytes);
  assert.deepEqual(fs.readdirSync(path.join(stateDir, "state.lock")), ["protocol.json"]);
  const script = `import {withPosixStateLock} from ${JSON.stringify(module)};
    try {withPosixStateLock(${JSON.stringify(stateDir)}, {}, () => { console.log('CALLBACK'); }, {timeoutMs: 0}); process.exitCode=2;}
    catch (e) { console.error(e.message); }`;
  const writer = run(["--input-type=module", "-e", script]);
  assert.equal(writer.status, 0, writer.stderr); assert.equal(writer.stdout, "");
  assert.match(writer.stderr, /offline|unavailable|disabled/i);
  assert.deepEqual(fs.readFileSync(marker), markerBytes); assert.deepEqual(fs.readFileSync(journal), journalBytes);
  safe = true;
});
