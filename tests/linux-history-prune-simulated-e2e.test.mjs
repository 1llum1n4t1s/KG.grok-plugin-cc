import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// Mac上の実CLIとファイルを使い、Linuxのprocfs・mount・flockは模擬する。
// 履歴pruneは未統合なので、通常の利用者操作で履歴が保持されることを確認する。
test("Linux CLI preserves more than 50 historical jobs while pruning is disabled", {
  skip: process.platform !== "darwin", timeout: 120000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-history-preserve-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace), stateFile = path.join(stateDir, "state.json"), jobsDir = path.join(stateDir, "jobs");
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const agent = fileURLToPath(new URL("./fixtures/linux-settings-agent.mjs", import.meta.url));
  const wrapper = path.join(root, "fake-grok"), quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700, flag: "wx" });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_BIN: wrapper, XAI_API_KEY: "test-only",
    GROK_COMPANION_DISABLE_BROKER: "1", GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    SETTINGS_LOG: path.join(root, "settings.log"), SETTINGS_READY: path.join(root, "agent-ready"),
    SETTINGS_RELEASE: path.join(root, "agent-release"),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA; delete env.SETTINGS_GATE;
  const lockArgs = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
  const run = (args, extra = {}) => spawnSync(process.execPath, [command, ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
  let migrated = false, allStopped = true, verifiedDone = false;
  t.after(() => {
    try {
      if (migrated && allStopped) {
        const stop = run(["state-lock", "stop-sentinel", ...lockArgs]);
        assert.equal(stop.status, 0, stop.stderr);
        if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
        else t.diagnostic(`Retained history fixture: ${root}`);
      } else t.diagnostic(`Retained fixture because owner termination is unconfirmed: ${root}`);
    } finally {
      for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  const migration = run(["state-lock", "migrate", ...lockArgs]);
  assert.equal(migration.status, 0, migration.stderr); migrated = true;
  const task = label => {
    const exited = path.join(root, `agent-exit-${label}`), spawned = path.join(root, `agent-spawn-${label}`);
    allStopped = false;
    const result = run(["task", "--cwd", workspace, "--json", `history task ${label}`],
      { SETTINGS_EXIT: exited, GROK_LINUX_SIM_SPAWN_MARKER: spawned, GROK_COMPANION_SESSION_ID: "history-session" });
    if (!fs.existsSync(spawned) || fs.existsSync(exited)) allStopped = true;
    assert.equal(result.status, 0, `task ${label}: ${result.stderr}\n${result.stdout}`);
    assert.equal(fs.existsSync(exited), true, "the direct agent exit must be observed");
  };
  task("seed");
  const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const index = state(), original = index.jobs.find(job => job.status === "completed");
  assert.ok(original, "a real completed task must exist");
  const originalDetail = JSON.parse(fs.readFileSync(path.join(jobsDir, `${original.id}.json`), "utf8"));
  const expected = [];
  // 50回のtask実行の代わりに、停止済み所有者のいない合成履歴を注入する。
  // これらはprune資格が検証済みという意味ではない。
  for (let i = 0; i < 52; i++) {
    const id = `history-fixture-${String(i).padStart(3, "0")}`, logFile = path.join(jobsDir, `${id}.log`);
    const job = { ...original, id, logFile, workerLease: null, createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" };
    const detail = Buffer.from(JSON.stringify({ ...originalDetail, ...job }));
    const log = Buffer.from(`preserved history ${i}\n`);
    fs.writeFileSync(path.join(jobsDir, `${id}.json`), detail, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(logFile, log, { mode: 0o600, flag: "wx" });
    index.jobs.push(job); expected.push({ job, detail, log });
  }
  fs.writeFileSync(stateFile, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  const status = run(["status", "--cwd", workspace, "--json", "--all"]);
  assert.equal(status.status, 0, status.stderr);
  const report = JSON.parse(status.stdout);
  const visible = [report.latestFinished, ...report.recent, ...report.running].filter(Boolean);
  for (const { job } of expected) assert.ok(visible.some(item => item.id === job.id), `${job.id} must be visible`);
  task("after");
  const after = state();
  for (const { job, detail, log } of expected) {
    assert.deepEqual(after.jobs.find(item => item.id === job.id), job);
    assert.deepEqual(fs.readFileSync(path.join(jobsDir, `${job.id}.json`)), detail);
    assert.deepEqual(fs.readFileSync(job.logFile), log);
  }
  const stateBeforeUnsupported = fs.readFileSync(stateFile);
  const assertAbsent = file => {
    try { fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    assert.fail(`Unexpected entry must not be overwritten: ${file}`);
  };
  const unsupported = run(["state-lock", "prune-history", ...lockArgs]);
  assert.equal(unsupported.error, undefined); assert.equal(unsupported.signal, null); assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /Invalid state-lock arguments\/options/);
  assert.deepEqual(fs.readFileSync(stateFile), stateBeforeUnsupported);
  for (const { job, detail, log } of expected) {
    assert.deepEqual(fs.readFileSync(path.join(jobsDir, `${job.id}.json`)), detail);
    assert.deepEqual(fs.readFileSync(job.logFile), log);
  }
  // indexには残る実taskのdetailだけを退避し、不整合を成功や通常の未登録と扱わない。
  const detailPath = path.join(jobsDir, `${original.id}.json`), heldDetail = path.join(root, "held-result-detail");
  const detailIdentity = fs.statSync(detailPath, { bigint: true }), detailBytes = fs.readFileSync(detailPath);
  const indexBeforeMissing = fs.readFileSync(stateFile);
  assert.ok(state().jobs.some(job => job.id === original.id));
  fs.renameSync(detailPath, heldDetail);
  try {
    const result = run(["result", "--cwd", workspace, "--json", original.id]);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null); assert.equal(result.status, 1, "an indexed job with missing detail must fail");
    assert.match(result.stderr, /is indexed but its result detail is missing/);
    assert.doesNotMatch(`${result.stderr}\n${result.stdout}`, /No finished job found/i);
    assert.deepEqual(fs.readFileSync(stateFile), indexBeforeMissing);
  } finally {
    const heldIdentity = fs.statSync(heldDetail, { bigint: true });
    assert.equal(heldIdentity.dev, detailIdentity.dev); assert.equal(heldIdentity.ino, detailIdentity.ino);
    assertAbsent(detailPath);
    fs.renameSync(heldDetail, detailPath);
  }
  assert.deepEqual(fs.readFileSync(detailPath), detailBytes);
  assert.deepEqual(fs.readFileSync(stateFile), indexBeforeMissing);
  const restored = run(["result", "--cwd", workspace, "--json", original.id]);
  assert.equal(restored.error, undefined); assert.equal(restored.signal, null); assert.equal(restored.status, 0, restored.stderr);
  const restoredPayload = JSON.parse(restored.stdout);
  assert.equal(restoredPayload.job.id, original.id);
  assert.deepEqual(restoredPayload.storedJob, originalDetail);
  // 別 ID の detail が結果として表示されないことを確認する。
  const wrongDetail = Buffer.from(JSON.stringify({ ...originalDetail, id: "different-job" }));
  const heldWrong = path.join(root, "held-wrong-detail");
  fs.renameSync(detailPath, heldDetail);
  try {
    fs.writeFileSync(detailPath, wrongDetail, { mode: 0o600, flag: "wx" });
    const wrongIdentity = fs.statSync(detailPath, { bigint: true });
    try {
      const wrongResult = run(["result", "--cwd", workspace, "--json", original.id]);
      assert.deepEqual(fs.readFileSync(stateFile), indexBeforeMissing);
      assert.deepEqual(fs.readFileSync(detailPath), wrongDetail);
      assert.equal(wrongResult.error, undefined); assert.equal(wrongResult.signal, null); assert.equal(wrongResult.status, 1, wrongResult.stdout);
      assert.match(wrongResult.stderr, /has an inconsistent result detail identity/);
      assert.doesNotMatch(`${wrongResult.stderr}\n${wrongResult.stdout}`, /No finished job found/i);
    } finally {
      const current = fs.statSync(detailPath, { bigint: true });
      assert.equal(current.dev, wrongIdentity.dev); assert.equal(current.ino, wrongIdentity.ino);
      assert.deepEqual(fs.readFileSync(detailPath), wrongDetail);
      assertAbsent(heldWrong); fs.renameSync(detailPath, heldWrong);
    }
  } finally {
    const heldIdentity = fs.statSync(heldDetail, { bigint: true });
    assert.equal(heldIdentity.dev, detailIdentity.dev); assert.equal(heldIdentity.ino, detailIdentity.ino);
    assertAbsent(detailPath);
    fs.renameSync(heldDetail, detailPath);
  }
  assert.deepEqual(fs.readFileSync(detailPath), detailBytes);
  assert.deepEqual(fs.readFileSync(stateFile), indexBeforeMissing);
  const restoredAgain = run(["result", "--cwd", workspace, "--json", original.id]);
  assert.equal(restoredAgain.error, undefined); assert.equal(restoredAgain.signal, null); assert.equal(restoredAgain.status, 0, restoredAgain.stderr);
  assert.deepEqual(JSON.parse(restoredAgain.stdout).storedJob, originalDetail);
  verifiedDone = true;
});
