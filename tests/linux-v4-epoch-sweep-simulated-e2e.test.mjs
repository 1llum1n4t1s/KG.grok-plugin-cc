import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 実 CLI で前 v6 epoch の job を作り、旧 sentinel を停止・barrier 保全後、
// 新 epoch へ明示移行・recover して現 job を回収する。procfs/mount/flock は
// Mac 上の模擬値であり Linux kernel や電源断の durability は実証しない。
test("Linux CLI preserves a real prior v6 lease across offline migration and new epoch sweep", {
  skip: process.platform !== "darwin", timeout: 240000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-v4-epoch-sweep-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const previous = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const sweep = fileURLToPath(new URL("./fixtures/linux-lease-sweep-cli.mjs", import.meta.url));
  const agent = fileURLToPath(new URL("./fixtures/linux-settings-agent.mjs", import.meta.url));
  const wrapper = path.join(root, "fake-grok");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700, flag: "wx" });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_BIN: wrapper, XAI_API_KEY: "test-only",
    GROK_COMPANION_DISABLE_BROKER: "1", GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    SETTINGS_LOG: path.join(root, "settings.log"), SETTINGS_READY: path.join(root, "agent-ready"),
    SETTINGS_RELEASE: path.join(root, "agent-release"),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA; delete env.SETTINGS_GATE;
  const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  let sentinel = false, agentsConfirmed = true;
  t.after(() => {
    try {
      if (sentinel && agentsConfirmed) {
        const stop = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...args], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stop.status, 0, stop.stderr);
        removeTempFixture(root, { recursive: true, force: true });
      } else t.diagnostic(`Retained fixture because migration or process exit is unconfirmed: ${root}`);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
      if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    }
  });
  const run = (args, extra = {}, timeout = 30000) => spawnSync(process.execPath, args, { env: { ...env, ...extra }, encoding: "utf8", timeout });
  const migrate = () => {
    const result = run([command, "state-lock", "migrate", ...args]);
    assert.equal(result.status, 0, result.stderr); sentinel = true;
    const marker = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8"));
    assert.equal(marker.protocol, "posix-linux-worker-lease-v6");
    return marker.epoch;
  };
  const task = (label, exitFile) => {
    const stateFile = path.join(stateDir, "state.json");
    const before = new Set(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.map(item => item.id));
    agentsConfirmed = false;
    const result = run([command, "task", "--cwd", workspace, "--json", label], { SETTINGS_EXIT: exitFile });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(exitFile), `${label}: agent exit must be observed`);
    const jobs = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
    const job = jobs.find(item => item.status === "completed" && !before.has(item.id));
    assert.ok(job?.workerLease && job.grokDirectStopKind === "posix-group-empty", `${label}: group stop must be confirmed`);
    agentsConfirmed = true;
    return job;
  };
  const firstEpoch = migrate();
  const old = task("prior v6 task", path.join(root, "old-agent-exited"));
  assert.equal(old.epoch, firstEpoch);
  const oldDetail = path.join(stateDir, "jobs", `${old.id}.json`);
  const oldBinding = old.workerLease.path.replace(/\.lease$/, ".binding");
  const oldLedger = path.join(path.dirname(old.workerLease.path), "ledger.json");
  const evidence = [oldDetail, old.workerLease.path, oldBinding, oldLedger].map(file => [file, fs.readFileSync(file)]);
  const stop = run([command, "state-lock", "stop-sentinel", ...args]);
  assert.equal(stop.status, 0, stop.stderr); sentinel = false;
  const barrier = path.join(stateDir, "state.lock"), retained = path.join(stateDir, "state.lock.previous-v6");
  const before = fs.lstatSync(barrier, { bigint: true });
  assert.ok(before.isDirectory() && !before.isSymbolicLink());
  assert.equal(fs.existsSync(retained), false);
  fs.renameSync(barrier, retained);
  const retainedStat = fs.lstatSync(retained, { bigint: true });
  assert.equal(retainedStat.dev, before.dev); assert.equal(retainedStat.ino, before.ino);
  const nextEpoch = migrate();
  assert.notEqual(nextEpoch, firstEpoch);
  const recovered = run([command, "state-lock", "recover", ...args, "--all-old-processes-stopped"]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const current = task("new v6 task", path.join(root, "new-agent-exited"));
  assert.equal(current.epoch, nextEpoch);
  const swept = run([sweep, workspace], {}, 75000);
  assert.equal(swept.status, 0, swept.stderr);
  assert.equal(JSON.parse(swept.stdout).reclaimed, 1);
  for (const [file, contents] of evidence) assert.deepEqual(fs.readFileSync(file), contents, `old evidence changed: ${file}`);
  const jobs = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs;
  assert.deepEqual(jobs.find(job => job.id === old.id).workerLease, old.workerLease);
  assert.equal(jobs.find(job => job.id === current.id).workerLease, null);
  assert.ok(fs.existsSync(retained));
});
