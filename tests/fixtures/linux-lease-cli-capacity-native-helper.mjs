import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "../helpers.mjs";


// 実 Linux の /proc と flock を使う。各ケースは独立 root と sentinel を持つ。
export function runCapacity(t, injectDeadline) {
  const root = makeTempDir("grok-linux-cli-capacity-");
  const previous = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  let stateDir, command, env, evidence;
  let migrated = false, allStopped = true, verifiedDone = false;
  const groups = new Set();
  const progress = (stage, details = {}) => {
    const fd = fs.openSync(path.join(root, "capacity-progress.jsonl"), "a", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify({ stage, pid: process.pid, ...details })}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
  const same = (actual, expected) => actual.dev === expected.dev && actual.ino === expected.ino;
  const checkGroupStopped = pgid => {
    try { process.kill(-pgid, 0); }
    catch (error) { if (error?.code === "ESRCH") return; throw error; }
    throw new Error(`agent process group ${pgid} is still present`);
  };
  const checkEvidence = () => {
    for (const [name, saved] of evidence.paths) {
      const actual = fs.lstatSync(name, { bigint: true });
      assert.ok(!actual.isSymbolicLink() && same(actual, saved), `fixture identity changed: ${name}`);
    }
    assert.deepEqual(fs.readFileSync(evidence.markerPath), evidence.markerBytes, "sentinel marker changed");
    const marker = JSON.parse(evidence.markerBytes.toString("utf8"));
    assert.equal(marker.epoch, evidence.epoch); assert.deepEqual(marker.sentinel, evidence.sentinel);
  };
  t.after(() => {
    try {
      if (migrated && allStopped && evidence) {
        for (const group of groups) checkGroupStopped(group);
        checkEvidence();
        const stop = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", "--offline-confirmed", "--local-only",
          "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 15000 });
        assert.equal(stop.error, undefined); assert.equal(stop.signal, null); assert.equal(stop.status, 0, stop.stderr);
        checkEvidence();
        if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
        else t.diagnostic(`Retained failed native fixture: ${root}`);
      } else t.diagnostic(`Retained fixture because migration or worker/agent exit is unconfirmed: ${root}`);
    } catch (error) {
      t.diagnostic(`Native fixture cleanup failed; inspect ${root}: ${error?.message ?? error}`);
      try { progress("cleanup-failed", { message: String(error?.message ?? error) }); } catch { /* 診断不能でも元の失敗を維持する。 */ }
      throw error;
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
      if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    }
  });
  assert.equal(fs.realpathSync(root), root, "fixture root must be an absolute canonical path");
  progress("root-created", { root });
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  stateDir = resolveStateDir(workspace);
  command = fileURLToPath(new URL("../../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const deadlinePreload = fileURLToPath(new URL("./linux-lease-deadline-native-preload.mjs", import.meta.url));
  const spawnObserver = fileURLToPath(new URL("./linux-native-spawn-observer.mjs", import.meta.url));
  const sweep = fileURLToPath(new URL("./linux-lease-sweep-cli.mjs", import.meta.url));
  const agent = fileURLToPath(new URL("./linux-settings-agent.mjs", import.meta.url));
  const wrapper = path.join(root, "fake-grok");
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(wrapper, `#!/bin/sh\nrecord=yes; for arg do case "$arg" in --help|--version) record=no;; esac; done; if [ "$1" = agent ] && [ "$2" = stdio ] && [ "$record" = yes ]; then pgid=$(ps -o pgid= -p "$$" | tr -d '[:space:]'); [ -n "$pgid" ] || exit 125; printf '%s %s %s\\n' "$$" "$pgid" "$PPID" >> ${quote(path.join(root, "agent-spawns"))}; fi\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700, flag: "wx" });
  env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_BIN: wrapper, XAI_API_KEY: "test-only",
    GROK_COMPANION_DISABLE_BROKER: "1", SETTINGS_LOG: path.join(root, "settings.log"),
    SETTINGS_READY: path.join(root, "agent-ready"), SETTINGS_RELEASE: path.join(root, "agent-release") };
  delete env.NODE_OPTIONS;
  delete env.PLUGIN_DATA; delete env.SETTINGS_GATE;
  const migration = spawnSync(process.execPath, [command, "state-lock", "migrate", "--offline-confirmed", "--local-only",
    "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migration.error, undefined); assert.equal(migration.signal, null); assert.equal(migration.status, 0, migration.stderr); migrated = true;
  const markerPath = path.join(stateDir, "state.lock", "protocol.json"), markerBytes = fs.readFileSync(markerPath);
  const marker = JSON.parse(markerBytes.toString("utf8"));
  assert.equal(marker.protocol, "posix-linux-worker-lease-v6");
  assert.ok(marker.epoch && marker.sentinel?.pid && marker.sentinel?.generation && marker.sentinel?.nonce && marker.sentinel?.startTick);
  evidence = { paths: [root, stateDir, path.dirname(markerPath), markerPath].map(name => [name, fs.lstatSync(name, { bigint: true })]),
    markerPath, markerBytes, epoch: marker.epoch, sentinel: marker.sentinel };
  checkEvidence();
  progress("migration-complete", { epoch: marker.epoch, sentinel: marker.sentinel,
    identities: evidence.paths.map(([name, value]) => ({ name, dev: String(value.dev), ino: String(value.ino) })) });
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
      const detailFiles = new Map(prior.jobs.map(job => [job.id, fs.readFileSync(path.join(stateDir, "jobs", `${job.id}.json`), "utf8")]));
      const leaseFile = oldest.workerLease.path, bindingFile = leaseFile.replace(/\.lease$/, ".binding");
      const leaseBefore = fs.readFileSync(leaseFile), bindingBefore = fs.readFileSync(bindingFile);
      const leaseIdentity = fs.lstatSync(leaseFile, { bigint: true }), bindingIdentity = fs.lstatSync(bindingFile, { bigint: true });
      const marker = path.join(root, "sweep-deadline-injected");
      const spawnCount = fs.readFileSync(path.join(root, "agent-spawns"), "utf8").trim().split("\n").length;
      const preloadReady = path.join(root, "native-preload-ready");
      const observerReady = path.join(root, "spawn-observer-ready-failed"), attempts = path.join(root, "spawn-attempts-failed");
      allStopped = false;
      const injectedAt = performance.now();
      progress("deadline-attempt", { index: i });
      const failed = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", "capacity task 256"], {
        env: { ...env, SETTINGS_EXIT: exited, GROK_SWEEP_DELAY_MARKER: marker, GROK_NATIVE_PRELOAD_READY: preloadReady,
          GROK_NATIVE_SPAWN_OBSERVER_READY: observerReady, GROK_NATIVE_SPAWN_ATTEMPTS: attempts,
          NODE_OPTIONS: `--import ${JSON.stringify(spawnObserver)} --import ${JSON.stringify(deadlinePreload)}` }, encoding: "utf8", timeout: 30000
      });
      progress("deadline-returned", { pid: failed.pid, status: failed.status, signal: failed.signal, error: failed.error?.code ?? null });
      assert.equal(failed.error, undefined); assert.equal(failed.signal, null); assert.equal(failed.status, 1, "deadline must be a normal exit 1");
      assert.ok(performance.now() - injectedAt >= 5500, "deadline injection must elapse");
      assert.equal(Number(fs.readFileSync(preloadReady, "utf8")), failed.pid, "preload must run in the attempted CLI process");
      assert.equal(Number(fs.readFileSync(observerReady, "utf8")), failed.pid, "spawn observer must run in the attempted CLI process");
      assert.equal(fs.existsSync(attempts), false, "failed attempt must not attempt an agent spawn");
      assert.equal(fs.readFileSync(path.join(root, "agent-spawns"), "utf8").trim().split("\n").length, spawnCount, "failed attempt must not spawn an agent");
      assert.match(failed.stderr, /State update was committed, but a follow-up failed: Timed out acquiring Grok state lock/);
      assert.ok(fs.existsSync(marker), "the post-commit delay must be reached");
      assert.equal(fs.existsSync(exited), false, "no new agent may start on the failed attempt");
      assert.equal(fs.readFileSync(path.join(root, "settings.log"), "utf8").split("\n").filter(line => line === "session/prompt").length, promptCount);
      const after = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      assert.equal(after.jobs.length, 256, "the failed attempt must not register another job");
      const { jobs: priorJobs, ...priorMetadata } = prior, { jobs: afterJobs, ...afterMetadata } = after;
      assert.deepEqual(afterMetadata, priorMetadata, "non-job index metadata must be preserved");
      for (const job of priorJobs) {
        if (job.id === oldest.id) continue;
        assert.deepEqual(afterJobs.find(value => value.id === job.id), job, `unrelated index ${job.id} must be preserved`);
        assert.equal(fs.readFileSync(path.join(stateDir, "jobs", `${job.id}.json`), "utf8"), detailFiles.get(job.id), `unrelated detail ${job.id} must be preserved`);
      }
      const indexed = after.jobs.find(job => job.id === oldest.id);
      const detail = JSON.parse(fs.readFileSync(path.join(stateDir, "jobs", `${oldest.id}.json`), "utf8"));
      for (const record of [indexed, detail]) {
        assert.equal(record.workerLease, null);
        assert.equal(record.workerStopProof, "linux-lease-released");
        assert.equal(record.workerStopLeaseId, oldest.workerLease.id);
      }
      const proof = { workerStopConfirmed: true, workerStopProof: "linux-lease-released", workerStopLeaseId: oldest.workerLease.id,
        workerStopProcessStartKey: oldest.processStartKey ?? null };
      assert.deepEqual(indexed, { ...oldest, ...proof, workerLease: null });
      assert.deepEqual(detail, { ...JSON.parse(detailFiles.get(oldest.id)), ...proof, workerLease: null });
      assert.deepEqual(fs.readFileSync(leaseFile), leaseBefore); assert.deepEqual(fs.readFileSync(bindingFile), bindingBefore);
      assert.equal(fs.lstatSync(leaseFile, { bigint: true }).ino, leaseIdentity.ino);
      assert.equal(fs.lstatSync(bindingFile, { bigint: true }).ino, bindingIdentity.ino);
      const pending = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
      assert.equal(pending.slots[0].state, "reclaiming");
      assert.equal(pending.cursor, 1);
      assert.ok(fs.existsSync(oldest.workerLease.path));
      assert.ok(fs.existsSync(oldest.workerLease.path.replace(/\.lease$/, ".binding")));
      allStopped = true;
      progress("deadline-verified", { pid: failed.pid, cursor: pending.cursor });
    }
    allStopped = false;
    const observerReady = path.join(root, `spawn-observer-ready-${i}`), attempts = path.join(root, `spawn-attempts-${i}`);
    progress("task-attempt", { index: i });
    const task = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", `capacity task ${i}`],
      { env: { ...env, SETTINGS_EXIT: exited, GROK_NATIVE_SPAWN_OBSERVER_READY: observerReady, GROK_NATIVE_SPAWN_ATTEMPTS: attempts,
        NODE_OPTIONS: `--import ${JSON.stringify(spawnObserver)}` }, encoding: "utf8", timeout: 30000 });
    progress("task-returned", { index: i, pid: task.pid, status: task.status, signal: task.signal, error: task.error?.code ?? null });
    assert.equal(task.error, undefined); assert.equal(task.signal, null);
    assert.equal(task.status, 0, `task ${i + 1}: error=${task.error?.code ?? "none"}, signal=${task.signal}; ${task.stderr}\n${task.stdout}`);
    assert.ok(fs.existsSync(exited), `task ${i + 1}: direct agent exit must be observed`);
    assert.equal(Number(fs.readFileSync(observerReady, "utf8")), task.pid, "spawn observer must run in the task CLI");
    const events = fs.readFileSync(attempts, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.length, 2); assert.deepEqual(events[0], { event: "attempt", ownerPid: task.pid });
    assert.equal(events[1].event, "returned"); assert.equal(events[1].ownerPid, task.pid);
    const spawns = fs.readFileSync(path.join(root, "agent-spawns"), "utf8").trim().split("\n");
    assert.equal(spawns.length, i + 1);
    const [agentPid, agentGroup, agentParent] = spawns[i].split(" ").map(Number);
    assert.ok(Number.isSafeInteger(agentPid) && agentPid > 0 && agentGroup === agentPid);
    assert.equal(agentParent, task.pid); assert.equal(events[1].childPid, agentPid);
    const completed = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs.filter(job => job.status === "completed");
    assert.equal(completed.length, i + 1);
    assert.ok(completed.every(job => job.grokDirectStopKind === "posix-group-empty" && job.grokDirectStopConfirmedAt &&
      job.grokDirectGeneration && job.grokDirectGeneration === job.grokDirectStopGeneration &&
      Number.isSafeInteger(job.grokDirectOwnerPid) && job.grokDirectOwnerPid > 0 &&
      job.grokDirectOwnerStartKey && job.grokDirectOwnerStartKey === job.processStartKey),
      `task ${i + 1}: direct process-group stop must be confirmed`);
    const owners = completed.filter(job => job.grokDirectOwnerPid === task.pid);
    assert.equal(owners.length, 1, "the task CLI must own exactly one completed job");
    groups.add(agentGroup); checkGroupStopped(agentGroup);
    if (i === 255) {
      assert.equal(completed.filter(job => job.workerLease).length, 256);
      assert.equal(new Set(completed.map(job => job.workerLease.slot)).size, 256);
      const ledgerFile = path.join(stateDir, "worker-leases-v1", completed[0].epoch, "ledger.json");
      const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
      for (const job of completed) {
        const slot = ledger.slots[job.workerLease.slot];
        assert.equal(slot.state, "published"); assert.equal(slot.jobId, job.id); assert.equal(slot.lease.id, job.workerLease.id);
      }
    }
    allStopped = true;
    progress("task-verified", { index: i, ownerPid: task.pid, agentPid, agentGroup, generation: owners[0].grokDirectGeneration });
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
  assert.equal(fs.readFileSync(path.join(root, "agent-spawns"), "utf8").trim().split("\n").length, 257);
  assert.equal(fs.readFileSync(path.join(root, "settings.log"), "utf8").split("\n").filter(line => line === "session/prompt").length, 257);
  for (let i = 0; i < 257; i++) assert.ok(fs.existsSync(path.join(root, `agent-exit-${i}`)));
  verifiedDone = true;
}
