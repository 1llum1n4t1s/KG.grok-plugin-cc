import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 故障条件: 完了した実 CLI の record／256 slot ledger を持つ状態で、
// 停止証拠・所有者・別 job を変えた post を固定回収変換と誤認する。
// Mac プロセス・模擬 procfs/mount/flock の試験であり Linux kernel は未検証。
test("Linux reclaim fixed transition checks complete CLI records and ledger", {
  skip: process.platform !== "darwin", timeout: 180000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-reclaim-transition-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const prior = process.env.CLAUDE_PLUGIN_DATA, priorPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/linux-reclaim-transition-simulated.mjs", import.meta.url));
  const agent = fileURLToPath(new URL("./fixtures/linux-settings-agent.mjs", import.meta.url));
  const wrapper = path.join(root, "fake-grok"), exited = path.join(root, "agent-exited");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700, flag: "wx" });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_BIN: wrapper, XAI_API_KEY: "test-only",
    GROK_COMPANION_DISABLE_BROKER: "1", GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    SETTINGS_LOG: path.join(root, "settings.log"), SETTINGS_READY: path.join(root, "agent-ready"),
    SETTINGS_RELEASE: path.join(root, "agent-release"), SETTINGS_EXIT: exited,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA; delete env.SETTINGS_GATE;
  let migrated = false, stopped = false, finished = false;
  t.after(() => {
    try {
      if (migrated && stopped && finished) {
        const stop = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", "--offline-confirmed", "--local-only",
          "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stop.status, 0, stop.stderr);
        removeTempFixture(root, { recursive: true, force: true });
      } else if (migrated) t.diagnostic(`Retained fixture: ${root}`);
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prior;
      if (priorPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = priorPlugin;
    }
  });
  const migrate = spawnSync(process.execPath, [command, "state-lock", "migrate", "--offline-confirmed", "--local-only",
    "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migrate.status, 0, migrate.stderr); migrated = true;
  const task = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", "complete record fixture"],
    { env, encoding: "utf8", timeout: 30000 });
  assert.equal(task.status, 0, task.stderr);
  assert.ok(fs.existsSync(exited));
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const completed = state.jobs.find(job => job.status === "completed");
  assert.ok(completed?.workerLease && completed.grokDirectStopKind === "posix-group-empty");
  stopped = true;
  const result = spawnSync(process.execPath, [fixture, stateDir, completed.id], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "complete transition verified");
  finished = true;
});
