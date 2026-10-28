import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 実 Mac process と実ファイルを使用し、procfs/mount/flock は模擬する。
// これは Linux kernel や電源断時 durability の実証ではない。
  test("Linux history resumes across journal crash boundaries", {
    skip: process.platform !== "darwin", timeout: 1800000
  }, t => {
    const root = fs.realpathSync(makeTempDir("grok-linux-history-crash-"));
    const data = path.join(root, "data"), workspace = path.join(root, "workspace");
    for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
    const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
    process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
    const stateDir = resolveStateDir(workspace), stateFile = path.join(stateDir, "state.json"), jobsDir = path.join(stateDir, "jobs");
    const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
    const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
    const fault = fileURLToPath(new URL("./fixtures/linux-history-prune-crash-preload.mjs", import.meta.url));
    const bootPreload = fileURLToPath(new URL("./fixtures/linux-history-boot-preload.mjs", import.meta.url));
    const sweep = fileURLToPath(new URL("./fixtures/linux-lease-sweep-cli.mjs", import.meta.url));
    const agent = fileURLToPath(new URL("./fixtures/linux-settings-agent.mjs", import.meta.url));
    const wrapper = path.join(root, "fake-grok"), quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700, flag: "wx" });
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_BIN: wrapper, XAI_API_KEY: "test-only",
      GROK_COMPANION_DISABLE_BROKER: "1", GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
      SETTINGS_LOG: path.join(root, "settings.log"), SETTINGS_READY: path.join(root, "agent-ready"),
      SETTINGS_RELEASE: path.join(root, "agent-release"),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)} --import ${JSON.stringify(fault)} --import ${JSON.stringify(bootPreload)}`.trim() };
    delete env.PLUGIN_DATA; delete env.SETTINGS_GATE;
    delete env.GROK_HISTORY_CRASH_STAGE; delete env.GROK_HISTORY_CRASH_JOB; delete env.GROK_HISTORY_CRASH_MARKER;
    delete env.GROK_HISTORY_SIM_BOOT;
    const lockArgs = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
    let migrated = false, allStopped = true, verifiedDone = false;
    t.after(() => {
      try {
        if (migrated && allStopped) {
          const stop = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", ...lockArgs], { env, encoding: "utf8", timeout: 15000 });
          assert.equal(stop.status, 0, stop.stderr);
          if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
          else t.diagnostic(`Retained failed history crash fixture: ${root}`);
        } else if (migrated) t.diagnostic(`Retained fixture because agent exit is unconfirmed: ${root}`);
        else if (!verifiedDone) t.diagnostic(`Retained offline history fixture: ${root}`);
      } finally {
        for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
    });
    const run = (script, args, extra = {}, timeout = 75000) =>
      spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout });
    const migration = run(command, ["state-lock", "migrate", ...lockArgs], {}, 20000);
    assert.equal(migration.status, 0, migration.stderr); migrated = true;
    function task(i, extra = {}) {
      const exited = path.join(root, `agent-exit-${i}`), spawned = path.join(root, `agent-spawn-${i}`);
      allStopped = false;
      const result = run(command, ["task", "--cwd", workspace, "--json", `history crash task ${i}`],
        { ...extra, SETTINGS_EXIT: exited, GROK_LINUX_SIM_SPAWN_MARKER: spawned }, 30000);
      // 終了 marker のない agent の生存は推測せず、fixture と sentinel を保全する。
      if (!fs.existsSync(spawned) || fs.existsSync(exited)) allStopped = true;
      if (result.status === 0) assert.ok(fs.existsSync(exited), `task ${i}: direct agent exit must be observed`);
      return result;
    }
    function reclaim(extra = {}, maxEntries = 256) {
      allStopped = false;
      const result = run(sweep, [workspace, String(maxEntries)], extra);
      if (result.status === 0 || result.status === 87) allStopped = true;
      return result;
    }
    for (let i = 0; i < 58; i++) {
      const result = task(i); assert.equal(result.status, 0, result.stderr);
    }
    const initialSweep = reclaim(); assert.equal(initialSweep.status, 0, initialSweep.stderr);
    assert.equal(JSON.parse(initialSweep.stdout).reclaimed, 58);
    const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const initial = state().jobs.filter(job => job.status === "completed" && job.workerLease == null &&
      job.workerStopConfirmed === true && job.workerStopProof === "linux-lease-released")
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    assert.equal(initial.length, 58);
    const protectedJob = initial.at(-1), protectedDetail = path.join(jobsDir, `${protectedJob.id}.json`);
    const protectedBytes = fs.readFileSync(protectedDetail);
    for (const stage of ["bootstrap", "prepared", "intent-temp", "intent-publish", "index", "index-replaced", "index-unknown", "index-modified", "detail", "log"]) {
    const eligible = state().jobs.filter(job => job.status === "completed" && job.workerLease == null &&
      job.workerStopConfirmed === true && job.workerStopProof === "linux-lease-released")
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    assert.ok(eligible.length > 50, `${stage}: the threshold must be exceeded before injection`);
    const target = eligible[0];
    const detail = path.join(jobsDir, `${target.id}.json`), log = target.logFile;
    assert.equal(log, path.join(jobsDir, `${target.id}.log`));
    assert.ok(fs.existsSync(detail) && fs.existsSync(log));
    const originalDetail = fs.readFileSync(detail), originalLog = fs.readFileSync(log);
    const marker = path.join(root, `crash-marker-${stage}`);
    const crashEnv = { GROK_HISTORY_CRASH_STAGE: stage, GROK_HISTORY_CRASH_JOB: target.id, GROK_HISTORY_CRASH_MARKER: marker };
    // admission 前の独立 transaction を利用者 CLI から起動する。
    const crashed = task(`crash-${stage}`, crashEnv);
    assert.equal(crashed.status, 87, `injection did not reach ${stage}: ${crashed.stderr}`);
    assert.equal(fs.readFileSync(marker, "utf8"), stage);
    const preIndex = ["bootstrap", "prepared", "intent-temp", "intent-publish"].includes(stage);
    assert.equal(state().jobs.some(job => job.id === target.id), preIndex, "index publication must precede artifact deletion");
    assert.equal(fs.existsSync(detail), preIndex || ["index", "index-replaced", "index-unknown", "index-modified"].includes(stage));
    assert.equal(fs.existsSync(log), preIndex || stage !== "log");
    assert.deepEqual(fs.readFileSync(protectedDetail), protectedBytes);
    assert.ok(allStopped, "agent termination must be confirmed before reentry");
    if (stage === "index-replaced") {
      const saved = path.join(root, "preserved-original-detail"), original = fs.readFileSync(detail);
      fs.renameSync(detail, saved);
      fs.writeFileSync(detail, original, { mode: 0o600, flag: "wx" });
      const result = reclaim({}, 1);
      assert.notEqual(result.status, 0, "replacement inode must fail closed");
      assert.match(result.stderr, /file evidence changed/i);
      assert.deepEqual(fs.readFileSync(saved), original);
      assert.deepEqual(fs.readFileSync(detail), original);
      assert.ok(fs.existsSync(log), "unverified log must remain untouched");
      assert.deepEqual(fs.readFileSync(protectedDetail), protectedBytes);
      // 改ざんされた名前と元 inode を別々に保全し、元 inode の復旧後に再入する。
      assert.equal(result.error, undefined, result.error?.message); allStopped = true;
      fs.renameSync(detail, path.join(root, "preserved-replacement-detail"));
      fs.renameSync(saved, detail);
    }
    if (stage === "index-unknown") {
      const unknown = path.join(stateDir, "history-journal-v1", target.epoch, "unexpected-entry");
      fs.writeFileSync(unknown, "unknown evidence", { mode: 0o600, flag: "wx" });
      const result = reclaim({}, 1);
      assert.notEqual(result.status, 0, "unknown journal entry must fail closed");
      assert.match(result.stderr, /journal contains an unknown entry/i);
      assert.equal(fs.readFileSync(unknown, "utf8"), "unknown evidence");
      assert.deepEqual(fs.readFileSync(detail), originalDetail);
      assert.deepEqual(fs.readFileSync(log), originalLog);
      assert.equal(result.error, undefined, result.error?.message); allStopped = true;
      fs.renameSync(unknown, path.join(root, "preserved-unknown-entry"));
    }
    if (stage === "index-modified") {
      const before = fs.statSync(detail, { bigint: true });
      const changed = `${JSON.stringify({ ...JSON.parse(originalDetail.toString("utf8")), fixtureTamper: true }, null, 2)}\n`;
      fs.writeFileSync(detail, changed);
      assert.equal(fs.statSync(detail, { bigint: true }).ino, before.ino, "the replacement must retain the inode");
      const result = reclaim({}, 1);
      assert.notEqual(result.status, 0, "changed content must fail closed");
      assert.match(result.stderr, /file evidence changed/i);
      assert.equal(fs.readFileSync(detail, "utf8"), changed);
      assert.deepEqual(fs.readFileSync(log), originalLog);
      assert.equal(result.error, undefined, result.error?.message); allStopped = true;
      fs.writeFileSync(detail, originalDetail);
    }
    const resumed = reclaim({}, 1); assert.equal(resumed.status, 0, resumed.stderr);
    const status = run(command, ["status", "--cwd", workspace, "--all", "--json"], {}, 30000);
    assert.equal(status.status, 0, status.stderr);
    if (["bootstrap", "prepared", "intent-temp"].includes(stage)) {
      assert.ok(state().jobs.some(job => job.id === target.id), "unpublished intent must leave the original index intact");
      assert.ok(fs.existsSync(detail) && fs.existsSync(log), "unpublished intent must leave both artifacts intact");
      assert.deepEqual(fs.readFileSync(detail), originalDetail);
      assert.deepEqual(fs.readFileSync(log), originalLog);
    } else {
      assert.ok(!state().jobs.some(job => job.id === target.id));
      assert.ok(!fs.existsSync(detail) && !fs.existsSync(log), "reentry must finish the verified deletion");
    }
    assert.ok(state().jobs.some(job => job.id === protectedJob.id));
    assert.deepEqual(fs.readFileSync(protectedDetail), protectedBytes);
    }

    // 模擬 reboot: active intent が残った状態で全旧 worker と sentinel を止め、
    // 旧 boot の marker・ledger・journal を保全したまま専用 offline CLI を試す。
    const remaining = state().jobs.filter(job => job.status === "completed" && job.workerLease == null &&
      job.workerStopConfirmed === true && job.workerStopProof === "linux-lease-released")
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    assert.ok(remaining.length > 50, "offline crash requires an eligible old job");
    const oldTarget = remaining[0], oldDetail = path.join(jobsDir, `${oldTarget.id}.json`), oldLog = oldTarget.logFile;
    const oldMarker = path.join(root, "old-boot-crash-marker");
    const oldCrash = task("old-boot-crash", { GROK_HISTORY_CRASH_STAGE: "index", GROK_HISTORY_CRASH_JOB: oldTarget.id,
      GROK_HISTORY_CRASH_MARKER: oldMarker });
    assert.equal(oldCrash.status, 87, oldCrash.stderr);
    assert.equal(fs.readFileSync(oldMarker, "utf8"), "index");
    assert.ok(!state().jobs.some(job => job.id === oldTarget.id));
    const oldDetailBytes = fs.readFileSync(oldDetail), oldLogBytes = fs.readFileSync(oldLog);
    const indexBytes = fs.readFileSync(stateFile), barrier = path.join(stateDir, "state.lock");
    const barrierId = fs.statSync(barrier, { bigint: true });
    const markerBytes = fs.readFileSync(path.join(barrier, "protocol.json")), marker = JSON.parse(markerBytes);
    const oldEpoch = marker.epoch, ledger = path.join(stateDir, "worker-leases-v1", oldEpoch, "ledger.json");
    const ledgerBytes = fs.readFileSync(ledger), journal = path.join(stateDir, "history-journal-v1", oldEpoch);
    const journalId = fs.statSync(journal, { bigint: true });
    const intentPath = path.join(journal, "intent.json"), intentBytes = fs.readFileSync(intentPath);
    const stop = run(command, ["state-lock", "stop-sentinel", ...lockArgs], {}, 15000);
    assert.equal(stop.status, 0, stop.stderr); migrated = false;
    env.GROK_HISTORY_SIM_BOOT = "33333333-3333-4333-8333-333333333333";
    const oldRun = task("old-boot-probe");
    assert.notEqual(oldRun.status, 0, "old runtime must reject the simulated new boot");
    const blockedMigration = run(command, ["state-lock", "migrate", ...lockArgs], {}, 20000);
    assert.notEqual(blockedMigration.status, 0, "the old marker must not start a new epoch");
    assert.deepEqual(fs.readFileSync(stateFile), indexBytes);
    const oldBarrier = path.join(stateDir, `state.lock.history-${oldEpoch}`);
    fs.renameSync(barrier, oldBarrier);
    assert.equal(fs.statSync(oldBarrier, { bigint: true }).dev, barrierId.dev);
    assert.equal(fs.statSync(oldBarrier, { bigint: true }).ino, barrierId.ino);
    const blockedNewEpoch = run(command, ["state-lock", "migrate", ...lockArgs], {}, 30000);
    assert.notEqual(blockedNewEpoch.status, 0, "nonempty old journal must reject a new epoch");
    assert.ok(!fs.existsSync(barrier), "refused migration must not leave a partial new barrier");
    assert.deepEqual(fs.readFileSync(path.join(oldBarrier, "protocol.json")), markerBytes);
    assert.deepEqual(fs.readFileSync(ledger), ledgerBytes);
    const offlineArgs = ["state-lock", "recover-history", "--offline-confirmed", "--local-only", "--all-old-processes-stopped",
      "--expected-state-dir", stateDir, "--old-epoch", oldEpoch, "--old-barrier", oldBarrier, "--cwd", workspace];
    const unchangedBeforeRecovery = () => {
      assert.deepEqual(fs.readFileSync(stateFile), indexBytes);
      assert.deepEqual(fs.readFileSync(path.join(oldBarrier, "protocol.json")), markerBytes);
      assert.deepEqual(fs.readFileSync(ledger), ledgerBytes);
      assert.deepEqual(fs.readFileSync(intentPath), intentBytes);
      assert.equal(fs.statSync(journal, { bigint: true }).dev, journalId.dev);
      assert.equal(fs.statSync(journal, { bigint: true }).ino, journalId.ino);
    };
    for (const flag of ["--offline-confirmed", "--local-only", "--all-old-processes-stopped"]) {
      const withoutFlag = run(command, offlineArgs.filter(value => value !== flag), {}, 30000);
      assert.notEqual(withoutFlag.status, 0, `${flag} must be required`);
      unchangedBeforeRecovery();
    }
    const wrongEpoch = offlineArgs.map(value => value === oldEpoch ? "44444444-4444-4444-8444-444444444444" : value);
    const rejectedEpoch = run(command, wrongEpoch, {}, 30000);
    assert.notEqual(rejectedEpoch.status, 0, "an incorrect old epoch must be refused");
    unchangedBeforeRecovery();
    const unknown = path.join(journal, "unknown-offline-evidence");
    fs.writeFileSync(unknown, "preserve unknown", { mode: 0o600, flag: "wx" });
    const rejectedUnknown = run(command, offlineArgs, {}, 30000);
    assert.notEqual(rejectedUnknown.status, 0, "unknown old journal content must be refused");
    assert.equal(fs.readFileSync(unknown, "utf8"), "preserve unknown");
    assert.deepEqual(fs.readFileSync(oldDetail), oldDetailBytes);
    assert.deepEqual(fs.readFileSync(oldLog), oldLogBytes);
    unchangedBeforeRecovery();
    fs.renameSync(unknown, path.join(root, "preserved-offline-unknown"));
    const original = path.join(root, "preserved-offline-detail");
    fs.renameSync(oldDetail, original);
    fs.writeFileSync(oldDetail, oldDetailBytes, { flag: "wx", mode: 0o600 });
    const rejectedReplacement = run(command, offlineArgs, {}, 30000);
    assert.notEqual(rejectedReplacement.status, 0, "a replaced old detail inode must be refused");
    assert.deepEqual(fs.readFileSync(original), oldDetailBytes);
    assert.deepEqual(fs.readFileSync(oldDetail), oldDetailBytes);
    assert.deepEqual(fs.readFileSync(oldLog), oldLogBytes);
    unchangedBeforeRecovery();
    fs.renameSync(oldDetail, path.join(root, "preserved-offline-replacement"));
    fs.renameSync(original, oldDetail);
    const recovered = run(command, offlineArgs, {}, 120000);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.deepEqual(fs.readFileSync(path.join(oldBarrier, "protocol.json")), markerBytes);
    assert.deepEqual(fs.readFileSync(ledger), ledgerBytes);
    assert.equal(fs.statSync(journal, { bigint: true }).dev, journalId.dev);
    assert.equal(fs.statSync(journal, { bigint: true }).ino, journalId.ino);
    assert.ok(!fs.existsSync(oldDetail) && !fs.existsSync(oldLog), "confirmed old intent must finish safely");
    assert.deepEqual(fs.readFileSync(protectedDetail), protectedBytes);
    assert.deepEqual(fs.readFileSync(stateFile), indexBytes);
    const newMigration = run(command, ["state-lock", "migrate", ...lockArgs], {}, 30000);
    assert.equal(newMigration.status, 0, newMigration.stderr); migrated = true;
    const nextEpoch = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).epoch;
    assert.notEqual(nextEpoch, oldEpoch);
    assert.deepEqual(fs.readFileSync(path.join(oldBarrier, "protocol.json")), markerBytes);
    verifiedDone = true;
  });
