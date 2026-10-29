import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fork, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 故障条件: 256 個の稼働中 lease を回収する、満杯を拒否しない、
// 終了済み reservation を回収できず次の予約を永久に拒否する。
// 実 Mac プロセスと模擬 procfs/mount/flock は Linux kernel の実証ではない。
test("Linux capacity is restored only after an owner releases a reserved lease", {
  skip: process.platform !== "darwin", timeout: 360000
}, async t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-lease-capacity-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const previous = process.env.CLAUDE_PLUGIN_DATA, previousPlugin = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/linux-lease-capacity-worker.mjs", import.meta.url));
  const sweep = fileURLToPath(new URL("./fixtures/linux-lease-sweep-cli.mjs", import.meta.url));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA;
  let holder, closed, holderError, migrated = false, passed = false;
  const awaitClose = async timeout => {
    let timer;
    try {
      return await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`capacity holder did not close within ${timeout}ms`)), timeout);
      })]);
    } finally { clearTimeout(timer); }
  };
  const nextMessage = () => new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); holder.off("message", onMessage); holder.off("close", onClose); holder.off("error", onError); };
    const onMessage = message => { cleanup(); resolve(message); };
    const onClose = () => { cleanup(); reject(new Error("capacity holder exited before its message")); };
    const onError = error => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("capacity holder message timed out")); }, 180000);
    holder.once("message", onMessage); holder.once("close", onClose); holder.once("error", onError);
  });
  const sendMessage = message => new Promise((resolve, reject) => {
    if (holderError) return reject(holderError);
    if (!holder.connected || holder.exitCode !== null || holder.signalCode !== null) return reject(new Error("capacity holder IPC is closed"));
    holder.send(message, error => error ? reject(error) : resolve());
  });
  t.after(async () => {
    try {
      if (holder && holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
      if (closed) {
        try { await awaitClose(5000); }
        catch (error) {
          t.diagnostic(`Retained fixture; holder PID ${holder.pid} termination unconfirmed: ${root}; ${error.message}`);
          if (holder.connected) holder.disconnect();
          holder.unref();
          throw error;
        }
      }
      if (migrated) {
        const stopped = spawnSync(process.execPath, [command, "state-lock", "stop-sentinel", "--offline-confirmed", "--local-only",
          "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 15000 });
        if (stopped.status !== 0) t.diagnostic(`Retained fixture; sentinel termination unconfirmed: ${root}`);
        assert.equal(stopped.status, 0, stopped.stderr);
      }
      if (passed && migrated) removeTempFixture(root, { recursive: true, force: true });
      else t.diagnostic(`Retained unsuccessful fixture: ${root}`);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous;
      if (previousPlugin === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = previousPlugin;
    }
  });
  const migration = spawnSync(process.execPath, [command, "state-lock", "migrate", "--offline-confirmed", "--local-only",
    "--expected-state-dir", stateDir, "--cwd", workspace], { env, encoding: "utf8", timeout: 20000 });
  assert.equal(migration.status, 0, migration.stderr); migrated = true;
  const crashed = spawnSync(process.execPath, [fixture, workspace, "crash-empty"], { env, encoding: "utf8", timeout: 15000 });
  assert.equal(crashed.status, 76, crashed.stderr);
  const epochsDir = path.join(stateDir, "worker-leases-v1");
  const epochs = fs.readdirSync(epochsDir);
  assert.equal(epochs.length, 1);
  const ledgerFile = path.join(epochsDir, epochs[0], "ledger.json");
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  const initial = ledger();
  assert.equal(initial.epoch, epochs[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).epoch, initial.epoch);
  assert.equal(initial.cursor, 1);
  assert.equal(initial.slots[0].state, "reserved");
  assert.equal(initial.slots[0].jobId, "empty-crash");
  assert.ok(initial.slots.slice(1).every(slot => slot.state === "free"));
  assert.equal(fs.readdirSync(path.dirname(ledgerFile)).filter(name => name.endsWith(".lease") || name.endsWith(".binding")).length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs, []);
  assert.deepEqual(fs.readdirSync(path.join(stateDir, "jobs")), []);
  // 注入対象だけを先に訪問する。復旧は crash 後の cursor から自然に一周する。
  initial.cursor = 0;
  fs.writeFileSync(ledgerFile, `${JSON.stringify(initial)}\n`);
  const reclaimPreload = fileURLToPath(new URL("./fixtures/linux-lease-empty-reclaim-crash-preload.mjs", import.meta.url));
  const interrupted = spawnSync(process.execPath, [sweep, workspace, "1"], { encoding: "utf8", timeout: 75000,
    env: { ...env, GROK_EMPTY_RECLAIM_CRASH: "1", NODE_OPTIONS: `${env.NODE_OPTIONS} --import ${JSON.stringify(reclaimPreload)}` } });
  assert.equal(interrupted.status, 77, `${interrupted.stderr}\n${interrupted.stdout}`);
  const afterCrash = ledger();
  assert.equal(afterCrash.cursor, 1);
  assert.equal(afterCrash.slots[0].state, "reclaiming");
  assert.equal(afterCrash.slots[0].reclaimKind, "empty");
  assert.equal(afterCrash.slots[0].jobId, initial.slots[0].jobId);
  assert.equal(afterCrash.slots[0].claimToken, initial.slots[0].claimToken);
  assert.deepEqual(afterCrash.slots.slice(1), initial.slots.slice(1));
  const sweepFullCircle = () => {
    let examined = 0, reclaimed = 0;
    for (let i = 0; i < 16; i++) {
      const before = ledger().cursor;
      const result = spawnSync(process.execPath, [sweep, workspace, "16"], { env, encoding: "utf8", timeout: 75000 });
      assert.equal(result.status, 0, result.stderr);
      const batch = JSON.parse(result.stdout);
      assert.equal(batch.examined, 16);
      assert.equal(ledger().cursor, (before + 16) % 256);
      examined += batch.examined; reclaimed += batch.reclaimed;
    }
    assert.equal(examined, 256);
    return reclaimed;
  };
  assert.equal(sweepFullCircle(), 1, "a durable reservation with no lease or records must be reclaimable");
  holder = fork(fixture, [workspace, "hold"], { env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  holder.on("error", error => { holderError = error; });
  closed = new Promise(resolve => holder.once("close", (code, signal) => resolve({ code, signal })));
  const held = await nextMessage();
  assert.equal(held.type, "held"); assert.equal(held.leases.length, 256);
  const heldLedger = ledger();
  const liveSlots = held.leases.slice(1).map(lease => ({ slot: lease.slot, entry: heldLedger.slots[lease.slot] }));
  const liveEvidence = held.leases.slice(1).flatMap(lease => [lease.path, lease.path.replace(/\.lease$/, ".binding")]).map(file => ({
    file, stat: fs.lstatSync(file, { bigint: true }), bytes: fs.readFileSync(file)
  }));
  const reserve = () => {
    const result = spawnSync(process.execPath, [fixture, workspace, "reserve"], { env, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(reserve(), { ok: false, code: "GROK_LINUX_LEASE_CAPACITY" });
  const [released] = await Promise.all([nextMessage(), sendMessage("release-one")]);
  assert.equal(released.type, "released");
  assert.equal(sweepFullCircle(), 1);
  const sweptLedger = ledger();
  for (const { slot, entry } of liveSlots) assert.deepEqual(sweptLedger.slots[slot], entry);
  for (const { file, stat, bytes } of liveEvidence) {
    const current = fs.lstatSync(file, { bigint: true });
    assert.equal(current.dev, stat.dev); assert.equal(current.ino, stat.ino);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
  assert.equal(reserve().ok, true);
  await sendMessage("finish");
  assert.deepEqual(await awaitClose(15000), { code: 0, signal: null });
  if (holderError) throw holderError;
  passed = true;
});
