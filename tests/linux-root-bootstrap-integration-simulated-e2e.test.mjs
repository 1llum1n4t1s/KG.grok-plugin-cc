import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// 失敗条件: root 前に native 取得、bootstrap の FD7 非継承、期限の再生成、
// 通常 reader/writer の root 非取得、同一 process 再入時の無制限待機。
// 実 macOS process / CLI で procfs と flock は模擬。Linux kernel の保証ではない。
test("Linux migration and writer pass the root lock into bootstrap", { skip: process.platform !== "darwin", timeout: 60000 }, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-root-bootstrap-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const previous = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), audit = path.join(root, "audit.jsonl");
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const observer = fileURLToPath(new URL("./fixtures/linux-root-bootstrap-audit.mjs", import.meta.url));
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const state = new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href;
  const env = { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_ROOT_BOOTSTRAP_AUDIT: audit,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)} --import ${JSON.stringify(observer)}`.trim() };
  delete env.PLUGIN_DATA;
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  const cli = action => spawnSync(process.execPath, [command, "state-lock", action, ...args], { env, encoding: "utf8", timeout: 30000 });
  let sentinel = false;
  t.after(() => {
    const stop = sentinel ? cli("stop-sentinel") : null;
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
    if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    // alias を追跡して削除しない。保全して手動清掃先を診断に残す。
    t.diagnostic(`Fixture retained: ${root}`);
    if (stop) assert.equal(stop.status, 0, `Sentinel stop failed: ${stop.stderr}`);
  });
  const migrated = cli("migrate"); assert.equal(migrated.status, 0, migrated.stderr); sentinel = true;
  const events = () => fs.readFileSync(audit, "utf8").trim().split("\n").map(JSON.parse);
  const records = events(), boot = records.find(e => e.kind === "bootstrap");
  assert.ok(boot, "bootstrap was not observed");
  const before = records.filter(e => e.pid === boot.pid && BigInt(e.at) <= BigInt(boot.at));
  const rootLock = before.find(e => e.kind === "root"), nativeLock = before.find(e => e.kind === "native");
  assert.ok(rootLock && nativeLock && BigInt(rootLock.at) < BigInt(nativeLock.at), "root must precede native lock");
  assert.deepEqual({ dev: boot.dev, ino: boot.ino }, { dev: rootLock.dev, ino: rootLock.ino }, "FD7 must refer to the locked root");
  assert.ok(boot.args.includes("--history-root-lock-fd=7"));
  const deadline = boot.args.find(arg => arg.startsWith("--history-deadline-ns="));
  assert.ok(deadline); const expiry = BigInt(deadline.split("=")[1]);
  assert.ok(expiry > BigInt(boot.at) && expiry <= BigInt(rootLock.at) + 7500000000n, "deadline must originate no later than root acquisition");
  const count = records.length;
  const script = `import {withStateSnapshot} from ${JSON.stringify(state)}; withStateSnapshot(${JSON.stringify(workspace)},()=>{});`;
  const read = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(read.status, 0, read.stderr);
  const writer = events().slice(count), r = writer.findIndex(e => e.kind === "root"), n = writer.findIndex(e => e.kind === "native");
  assert.ok(r >= 0 && n > r, "state snapshot must acquire root before native");
  // 祖先の symlink alias からも同じ state inode を開き、同じ root で排他する。
  const alias = path.join(root, "data-alias"); fs.symlinkSync(data, alias, "dir");
  const aliasRead = spawnSync(process.execPath, ["--input-type=module", "-e", script],
    { env: { ...env, CLAUDE_PLUGIN_DATA: alias }, encoding: "utf8", timeout: 30000 });
  assert.equal(aliasRead.status, 0, `ancestor alias must be accepted: ${aliasRead.stderr}`);
});
