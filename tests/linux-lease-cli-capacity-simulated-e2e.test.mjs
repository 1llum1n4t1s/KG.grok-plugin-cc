import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 故障条件: 正常完了した 256 job が slot を占有し続け、257 件目の
// CLI task が起動できない。procfs/mount/flock は Mac 上の模擬値であり、
// Linux kernel と電源断時の durability を実証するものではない。
test("Linux CLI completes a 257th task after reclaiming completed leases", {
  skip: process.platform !== "darwin", timeout: 1800000
}, t => runCapacity(t, false));

// 故障条件: 回収中の index 確定後に期限切れとなり、既存 task の証拠と
// 新規 task の起動結果を混同する。cursor は回収対象を飛び越えている。
test("Linux CLI preserves and resumes a reclaim interrupted by its deadline", {
  skip: process.platform !== "darwin", timeout: 3600000
}, t => runCapacity(t, true));

function runCapacity(t, injectDeadline) {
  const root = fs.realpathSync(makeTempDir("grok-linux-cli-capacity-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const previous = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const deadlinePreload = fileURLToPath(new URL("./fixtures/linux-lease-deadline-preload.mjs", import.meta.url));
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
  let migrated = false, allStopped = false;
  t.after(() => {
    try {
      if (migrated && allStopped) {
        const stop = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", "--offline-confirmed", "--local-only",
          "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stop.status, 0, stop.stderr);
        removeTempFixture(root, { recursive: true, force: true });
      } else if (migrated) t.diagnostic(`Retained fixture because worker/agent exit is not confirmed: ${root}`);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
      if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    }
  });
  const migration = spawnSync(process.execPath, [command, "state-lock", "migrate", "--offline-confirmed", "--local-only",
    "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migration.status, 0, migration.stderr); migrated = true;
  const stateFile = path.join(stateDir, "state.json");
  for (let i = 0; i < 257; i++) {
    const exited = path.join(root, `agent-exit-${i}`);
    if (injectDeadline && i === 256) {
      const prior = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const promptCount = fs.readFileSync(path.join(root, "settings.log"), "utf8").split("\n").filter(line => line === "session/prompt").length;
      assert.equal(promptCount, 256);
      const oldest = prior.jobs.find(job => job.workerLease?.slot === 0);
      assert.ok(oldest, "slot 0 must belong to a completed task");
      const ledgerFile = path.join(stateDir, "worker-leases-v1", oldest.epoch, "ledger.json");
      const marker = path.join(root, "sweep-deadline-injected");
      const failed = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", "capacity task 256"], {
        env: { ...env, SETTINGS_EXIT: exited, GROK_SWEEP_DELAY_MARKER: marker,
          NODE_OPTIONS: `${env.NODE_OPTIONS} --import ${JSON.stringify(deadlinePreload)}` }, encoding: "utf8", timeout: 30000
      });
      assert.notEqual(failed.status, 0, "deadline must be reported to the caller");
      assert.match(failed.stderr, /State update was committed, but a follow-up failed: Timed out acquiring Grok state lock/);
      assert.ok(fs.existsSync(marker), "the post-commit delay must be reached");
      assert.equal(fs.existsSync(exited), false, "no new agent may start on the failed attempt");
      assert.equal(fs.readFileSync(path.join(root, "settings.log"), "utf8").split("\n").filter(line => line === "session/prompt").length, promptCount);
      const after = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.equal(after.jobs.length, 256, "the failed attempt must not register another job");
      const indexed = after.jobs.find(job => job.id === oldest.id);
      const detail = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${oldest.id}.json`), "utf8"));
      for (const record of [indexed, detail]) {
        assert.equal(record.workerLease, null);
        assert.equal(record.workerStopProof, "linux-lease-released");
        assert.equal(record.workerStopLeaseId, oldest.workerLease.id);
      }
      const pending = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
      assert.equal(pending.slots[0].state, "reclaiming");
      assert.equal(pending.cursor, 1);
      assert.ok(fs.existsSync(oldest.workerLease.path));
      assert.ok(fs.existsSync(oldest.workerLease.path.replace(/\.lease$/, ".binding")));
    }
    const task = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", `capacity task ${i}`],
      { env: { ...env, SETTINGS_EXIT: exited }, encoding: "utf8", timeout: 30000 });
    assert.equal(task.status, 0, `task ${i + 1}: ${task.stderr}\n${task.stdout}`);
    assert.ok(fs.existsSync(exited), `task ${i + 1}: direct agent exit must be observed`);
    const completed = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.filter(job => job.status === "completed");
    assert.equal(completed.length, i + 1);
    assert.ok(completed.every(job => job.grokDirectStopKind === "posix-group-empty" && job.grokDirectStopConfirmedAt),
      `task ${i + 1}: direct process-group stop must be confirmed`);
    if (i === 255) {
      assert.equal(completed.filter(job => job.workerLease).length, 256);
    }
  }
  if (injectDeadline) {
    const jobs = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
    const original = jobs.find(job => job.workerStopLeaseId && job.workerLease == null);
    assert.ok(original);
    const ledgerFile = path.join(stateDir, "worker-leases-v1", original.epoch, "ledger.json");
    let ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    assert.equal(ledger.slots[0].state, "reclaiming");
    // 小分けに一巡し、元 slot の後続再開を確認する。各呼出しは独立した mutex を使う。
    for (let i = 0; i < 17 && ledger.slots[0].state !== "free"; i++) {
      const result = spawnSync(process.execPath, [sweep, workspace, "16"], { env, encoding: "utf8", timeout: 75000 });
      assert.equal(result.status, 0, result.stderr);
      ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    }
    assert.equal(ledger.slots[0].state, "free", "the interrupted reclaim must finish after cursor rotation");
    assert.equal(fs.existsSync(path.join(root, "agent-exit-257")), false);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.length, 257);
    assert.equal(fs.readFileSync(path.join(root, "settings.log"), "utf8").split("\n").filter(line => line === "session/prompt").length, 257,
      "the 257th prompt must be sent exactly once");
  }
  allStopped = true;
  assert.ok(allStopped, "direct agent exit must be observed before teardown");
  const jobs = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
  assert.equal(jobs.filter(job => job.status === "completed").length, 257);
  assert.ok(jobs.some(job => job.workerLease == null && job.workerStopProof === "linux-lease-released"));
}
