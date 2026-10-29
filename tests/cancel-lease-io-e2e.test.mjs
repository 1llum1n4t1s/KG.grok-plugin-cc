import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixture, stopFixtureChild, until } from "./cancel-repair-fixture.mjs";
import { initGitRepo } from "./helpers.mjs";
import { loadState, readJobFile, resolveJobFile, migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

const companion = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const holdPreload = fileURLToPath(new URL("./cancel-lease-io-hold.cjs", import.meta.url));
const injectPreload = fileURLToPath(new URL("./cancel-lease-io-inject.cjs", import.meta.url));

test("a Git I/O failure during worker lease wait remains visible and preserves pending records", {
  skip: !["darwin", "linux"].includes(process.platform)
}, async (t) => {
  const f = await fixture(t);
  initGitRepo(f.cwd);
  const env = { ...f.env, GROK_COMPANION_SESSION_ID: "lease-io-test" };
  const stateDir = resolveStateDir(f.cwd);
  migrateStateLock(f.cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const ready = path.join(f.cwd, "lease-hold-ready");
  const release = path.join(f.cwd, "lease-hold-release");
  const marker = path.join(f.cwd, "lease-io-injected");
  const worker = spawn(process.execPath, [companion, "task", "--json", "hold before prompt"], {
    cwd: f.cwd, env: { ...env, CANCEL_LEASE_STATE_MUTEX: process.platform === "linux" ? stateDir : path.join(stateDir, "state.lock", "native.lock"),
      CANCEL_LEASE_HOLD_READY: ready, CANCEL_LEASE_HOLD_RELEASE: release,
      NODE_OPTIONS: [env.NODE_OPTIONS, `--require="${holdPreload}"`].filter(Boolean).join(" ") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  worker.stdout.resume();
  let stderr = "";
  worker.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16384); });
  const exited = new Promise(resolve => worker.on("exit", resolve));
  f.cleanup(async () => {
    fs.writeFileSync(release, "release");
    await stopFixtureChild(worker);
    await exited;
  });
  await until(() => {
    if (worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Worker exited before barrier: ${stderr}`);
    return fs.existsSync(ready);
  }, "worker holds lease outside state mutex", 30000);
  const cli = (args, childEnv = env) => spawnSync(process.execPath, [companion, ...args], {
    cwd: f.cwd, env: childEnv, encoding: "utf8", timeout: 15000
  });
  const status = cli(["status", "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const job = JSON.parse(status.stdout).running[0];
  assert.ok(job.workerLease?.path);
  const cancelled = cli(["cancel", "--json", job.id], { ...env, CANCEL_LEASE_PATH: job.workerLease.path,
    CANCEL_LEASE_IO_MARKER: marker, NODE_OPTIONS: [env.NODE_OPTIONS, `--require="${injectPreload}"`].filter(Boolean).join(" ") });
  assert.equal(cancelled.status, 1, cancelled.stderr);
  assert.ok(fs.existsSync(marker), "I/O failure must follow an observed held lease");
  assert.ok(Number(fs.readFileSync(marker, "utf8")) >= 1000, "injection must have ample remaining time");
  assert.match(cancelled.stderr, /injected Git I\/O failure/);
  assert.match(cancelled.stderr, /cancellation remains pending/i);
  assert.doesNotMatch(cancelled.stderr, /worker lease remains unconfirmed/i);
  for (const record of [loadState(f.cwd).jobs.find(current => current.id === job.id), readJobFile(resolveJobFile(f.cwd, job.id))]) {
    assert.equal(record.status, "cancelled");
    assert.equal(record.terminationPending, true);
    assert.equal(record.phase, "termination-pending");
    assert.notEqual(record.workerStopConfirmed, true);
    assert.equal(record.workerLease.id, job.workerLease.id);
    assert.equal(record.claimToken, job.claimToken);
    assert.equal(record.processStartKey, job.processStartKey);
  }
});
