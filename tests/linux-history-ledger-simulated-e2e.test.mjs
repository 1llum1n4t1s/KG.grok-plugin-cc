import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 誤削除条件: 別 job と同じ claim/lease、未確定 slot、欠落 lease、
// 偽造または失効済み mutex context を非参照と判定する。
// 実 Mac プロセスと模擬 procfs/mount/flock を使用し、Linux kernel の証明ではない。
test("history pruning verifies all ledger references under the actual v6 mutex", {
  skip: process.platform !== "darwin", timeout: 90000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-history-ledger-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const previous = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/linux-history-ledger-simulated.mjs", import.meta.url));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA;
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  let sentinel = false, childConfirmed = false;
  t.after(() => {
    try {
      if (sentinel && childConfirmed) {
        const stop = spawnSync(process.execPath, [cli, "state-lock", "stop-sentinel", ...args], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stop.status, 0, stop.stderr);
        removeTempFixture(root, { recursive: true, force: true });
      } else if (sentinel) t.diagnostic(`Retained fixture because child exit is unconfirmed: ${root}`);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
      if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    }
  });
  const migrated = spawnSync(process.execPath, [cli, "state-lock", "migrate", ...args], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migrated.status, 0, migrated.stderr); sentinel = true;
  const result = spawnSync(process.execPath, [fixture, workspace], { env, encoding: "utf8", timeout: 45000 });
  childConfirmed = result.status !== null || result.signal !== null;
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.stdout.trim(), "history ledger checks passed");
});
