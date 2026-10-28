import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// 未出荷の v3 中間版 snapshot を GROK_LINUX_V3_ROOT に明示して実行する。
// 未指定では skip し、旧 CLI 実行を検証済みとは扱わない。Mac では procfs・mount・
// flock・socket を模擬しており Linux の no-replace・fsync 意味論は実証しない。
const sourceRoot = process.env.GROK_LINUX_V3_ROOT;
const skip = process.platform !== "darwin" ? "macOS simulated Linux only" : !sourceRoot ? "GROK_LINUX_V3_ROOT is not supplied; old CLI was not validated" : false;
for (const stage of ["normal", "stop", "backup", "marker"]) {
  test(`simulated Linux v3 offline migration preserves records after ${stage}`, { skip, timeout: 90000 }, async t => {
    assert.ok(path.isAbsolute(sourceRoot));
    const sourcePlugin = path.join(fs.realpathSync(sourceRoot), "plugins", "grok");
    const sourceLock = fs.readFileSync(path.join(sourcePlugin, "scripts", "lib", "posix-state-lock.mjs"), "utf8");
    assert.match(sourceLock, /posix-linux-sentinel-v3/);
    assert.doesNotMatch(sourceLock, /posix-linux-worker-lease-v4/);
    const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
    const root = fs.realpathSync(makeTempDir("grok-v3-offline-migration-"));
    const data = path.join(root, "data"), workspace = path.join(root, "workspace"), registry = path.join(root, "processes");
    fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 }); fs.mkdirSync(registry, { mode: 0o700 });
    const copied = path.join(root, "v3-plugin");
    fs.cpSync(sourcePlugin, copied, { recursive: true, errorOnExist: true, force: false });
    process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
    const stateDir = resolveStateDir(workspace), oldCli = path.join(copied, "scripts", "grok-companion.mjs");
    const newCli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
    const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
    const transition = fileURLToPath(new URL("./fixtures/linux-v3-offline-transition.mjs", import.meta.url));
    const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim(),
      GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir };
    const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
    const run = (cli, operation) => spawnSync(process.execPath, [cli, "state-lock", operation, ...args], { env, encoding: "utf8", timeout: 15000 });
    let oldStarted = false, oldStopped = false, v4Started = false;
    t.after(() => {
      try {
        if (v4Started) {
          const result = run(newCli, "stop-sentinel");
          assert.equal(result.status, 0, result.stderr);
        } else if (oldStarted && !oldStopped && fs.existsSync(path.join(stateDir, "state.lock", "protocol.json"))) {
          const result = run(oldCli, "stop-sentinel");
          if (result.status !== 0) t.diagnostic(`Old sentinel exit not confirmed; retained ${root}: ${result.stderr}`);
        }
      } finally {
        for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        t.diagnostic(`Offline migration fixture retained: ${root}`);
      }
    });
    const oldHelp = spawnSync(process.execPath, [oldCli, "state-lock", "--help"], { env, encoding: "utf8", timeout: 15000 });
    assert.equal(oldHelp.status, 0, oldHelp.stderr); assert.match(oldHelp.stdout, /stop-sentinel/);
    const initial = run(oldCli, "migrate"); assert.equal(initial.status, 0, initial.stderr); oldStarted = true;
    const barrier = path.join(stateDir, "state.lock"), marker = path.join(barrier, "protocol.json");
    const oldMarker = fs.readFileSync(marker, "utf8"), oldEpoch = JSON.parse(oldMarker).epoch;
    assert.equal(JSON.parse(oldMarker).protocol, "posix-linux-sentinel-v3");
    const oldStat = fs.statSync(barrier, { bigint: true }), jobs = path.join(stateDir, "jobs");
    fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
    const job = { id: "old-unleased", status: "running", epoch: oldEpoch, jobClass: "task", createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z", pid: 123456, processStartKey: "11111111-1111-4111-8111-111111111111:42",
      grokPromptState: "starting", logFile: path.join(jobs, "old-unleased.log") };
    const stateFile = path.join(stateDir, "state.json"), detail = path.join(jobs, "old-unleased.json"), log = path.join(jobs, "old-unleased.log");
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs: [job], reviewGateSessions: [] }), { mode: 0o600 });
    fs.writeFileSync(detail, JSON.stringify(job), { mode: 0o600 }); fs.writeFileSync(log, "old log evidence", { mode: 0o600 });
    const originalState = fs.readFileSync(stateFile, "utf8"), originalDetail = fs.readFileSync(detail, "utf8");
    const runTransition = step => spawnSync(process.execPath, [transition, oldCli, newCli, workspace, stateDir, step], { env, encoding: "utf8", timeout: 45000 });
    const transitionResult = runTransition(stage);
    assert.equal(transitionResult.status, stage === "normal" ? 0 : 73, transitionResult.stderr);
    oldStopped = true;
    if (stage === "marker") {
      // marker 公開前の bootstrap 異常で派生した sentinel の自然終了を確認する。
      const sentinels = fs.readdirSync(registry).filter(name => name.endsWith(".json")).map(name => {
        const record = JSON.parse(fs.readFileSync(path.join(registry, name), "utf8"));
        return record.argv?.[1]?.endsWith("linux-state-sentinel.mjs") && record.argv?.[2] === "sentinel" ? Number(name.slice(0, -5)) : null;
      }).filter(Number.isSafeInteger);
      const deadline = Date.now() + 8000;
      let live = [];
      do {
        live = sentinels.filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } });
        if (live.length) await new Promise(resolve => setTimeout(resolve, 20));
      } while (live.length && Date.now() < deadline);
      assert.deepEqual(live, [], `partial sentinel exit is unconfirmed; retained ${root}`);
    }
    if (stage === "stop") {
      const denied = run(newCli, "migrate"); assert.notEqual(denied.status, 0);
      assert.equal(fs.readFileSync(marker, "utf8"), oldMarker);
      const resumed = runTransition("after-stop"); assert.equal(resumed.status, 0, resumed.stderr);
    } else if (stage === "backup") {
      assert.equal(fs.existsSync(barrier), false);
      const resumed = runTransition("after-backup"); assert.equal(resumed.status, 0, resumed.stderr);
    } else if (stage === "marker") {
      assert.equal(fs.existsSync(path.join(barrier, "protocol.json")), false);
      const before = fs.readdirSync(barrier).sort();
      const denied = run(newCli, "migrate"); assert.notEqual(denied.status, 0);
      assert.deepEqual(fs.readdirSync(barrier).sort(), before);
      const resumed = runTransition("after-marker"); assert.equal(resumed.status, 0, resumed.stderr);
    }
    v4Started = true;
    const retained = path.join(stateDir, "v3-barrier-backup", "state.lock");
    const retainedStat = fs.statSync(retained, { bigint: true });
    assert.equal(retainedStat.dev, oldStat.dev); assert.equal(retainedStat.ino, oldStat.ino);
    assert.equal(fs.readFileSync(path.join(retained, "protocol.json"), "utf8"), oldMarker);
    assert.equal(JSON.parse(fs.readFileSync(path.join(barrier, "protocol.json"), "utf8")).protocol, "posix-linux-worker-lease-v6");
    const statusArgs = [newCli, "status", "--cwd", workspace, "--json"];
    const beforeRecovery = spawnSync(process.execPath, statusArgs, { env, encoding: "utf8", timeout: 15000 });
    assert.notEqual(beforeRecovery.status, 0, "old epoch admission requires explicit recovery");
    assert.match(beforeRecovery.stderr, /offline recovery/i);
    assert.equal(fs.readFileSync(stateFile, "utf8"), originalState);
    assert.equal(fs.readFileSync(detail, "utf8"), originalDetail); assert.equal(fs.readFileSync(log, "utf8"), "old log evidence");
    const recovery = spawnSync(process.execPath, [newCli, "state-lock", "recover", ...args, "--all-old-processes-stopped"],
      { env, encoding: "utf8", timeout: 15000 });
    assert.equal(recovery.status, 0, recovery.stderr);
    const status = spawnSync(process.execPath, statusArgs, { env, encoding: "utf8", timeout: 15000 });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(fs.readFileSync(stateFile, "utf8"), originalState);
    assert.equal(fs.readFileSync(detail, "utf8"), originalDetail); assert.equal(fs.readFileSync(log, "utf8"), "old log evidence");
  });
}
