import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 故障条件: 片側記録・異なる claim/epoch を公開、偽 owner を受理、
// 予約済み job ID を重複予約、予約した job の保護を失う。
// Mac の実プロセスとファイルを用い、procfs・mount・flock は模擬する。
// Linux カーネルの mount namespace と電源断時の耐久性は検証しない。
test("Linux lease ledger reserves and publishes only matching durable records", {
  skip: process.platform !== "darwin", timeout: 30000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-ledger-"));
  t.after(() => removeTempFixture(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/linux-lease-ledger-simulated.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", preload, fixture], {
    encoding: "utf8", timeout: 25000,
    env: { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir }
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.stdout.trim(), "ledger scenarios passed");
});

test("a process crash after durable reservation keeps the job protected", {
  skip: process.platform !== "darwin", timeout: 30000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-ledger-crash-"));
  t.after(() => removeTempFixture(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/linux-lease-ledger-simulated.mjs", import.meta.url));
  const env = { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    GROK_LEDGER_TEST_EPOCH: "11111111-1111-4111-8111-111111111111" };
  const crash = spawnSync(process.execPath, ["--import", preload, fixture], {
    encoding: "utf8", timeout: 12000, env: { ...env, GROK_LEDGER_TEST_MODE: "crash-reserved" }
  });
  assert.equal(crash.status, 71, `${crash.stderr}\n${crash.stdout}`);
  const verify = spawnSync(process.execPath, ["--import", preload, fixture], {
    encoding: "utf8", timeout: 12000, env: { ...env, GROK_LEDGER_TEST_MODE: "verify-crash-reserved" }
  });
  assert.equal(verify.status, 0, `${verify.stderr}\n${verify.stdout}`);
  assert.equal(verify.stdout.trim(), "crash preserved");
});

test("a crash during ledger publication does not confirm a partial publication", {
  skip: process.platform !== "darwin", timeout: 30000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-ledger-publish-crash-"));
  t.after(() => removeTempFixture(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/linux-lease-ledger-simulated.mjs", import.meta.url));
  const env = { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    GROK_LEDGER_TEST_EPOCH: "11111111-1111-4111-8111-111111111111" };
  const crash = spawnSync(process.execPath, ["--import", preload, fixture], {
    encoding: "utf8", timeout: 12000, env: { ...env, GROK_LEDGER_TEST_MODE: "crash-published" }
  });
  assert.equal(crash.status, 72, `${crash.stderr}\n${crash.stdout}`);
  const verify = spawnSync(process.execPath, ["--import", preload, fixture], {
    encoding: "utf8", timeout: 12000, env: { ...env, GROK_LEDGER_TEST_MODE: "verify-crash-published" }
  });
  assert.equal(verify.status, 0, `${verify.stderr}\n${verify.stdout}`);
  assert.equal(verify.stdout.trim(), "publication crash preserved");
});

test("a crash after binding and lease creation retains an unconfirmed reservation", {
  skip: process.platform !== "darwin", timeout: 30000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-ledger-bound-crash-"));
  t.after(() => removeTempFixture(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/linux-lease-ledger-simulated.mjs", import.meta.url));
  const env = { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    GROK_LEDGER_TEST_EPOCH: "11111111-1111-4111-8111-111111111111" };
  const crash = spawnSync(process.execPath, ["--import", preload, fixture], {
    encoding: "utf8", timeout: 12000, env: { ...env, GROK_LEDGER_TEST_MODE: "crash-bound" }
  });
  assert.equal(crash.status, 74, `${crash.stderr}\n${crash.stdout}`);
  const verify = spawnSync(process.execPath, ["--import", preload, fixture], {
    encoding: "utf8", timeout: 12000, env: { ...env, GROK_LEDGER_TEST_MODE: "verify-crash-bound" }
  });
  assert.equal(verify.status, 0, `${verify.stderr}\n${verify.stdout}`);
  assert.equal(verify.stdout.trim(), "bound crash preserved");
});

test("a crash after a complete reservation retains its owner evidence", {
  skip: process.platform !== "darwin", timeout: 30000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-ledger-reserved-crash-"));
  t.after(() => removeTempFixture(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/linux-lease-ledger-simulated.mjs", import.meta.url));
  const env = { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    GROK_LEDGER_TEST_EPOCH: "11111111-1111-4111-8111-111111111111" };
  const crash = spawnSync(process.execPath, ["--import", preload, fixture], {
    encoding: "utf8", timeout: 12000, env: { ...env, GROK_LEDGER_TEST_MODE: "crash-reserved-complete" }
  });
  assert.equal(crash.status, 75, `${crash.stderr}\n${crash.stdout}`);
  const verify = spawnSync(process.execPath, ["--import", preload, fixture], {
    encoding: "utf8", timeout: 12000, env: { ...env, GROK_LEDGER_TEST_MODE: "verify-crash-reserved-complete" }
  });
  assert.equal(verify.status, 0, `${verify.stderr}\n${verify.stdout}`);
  assert.equal(verify.stdout.trim(), "completed reservation preserved");
});

for (const mode of ["index-capacity", "index-bytes-capacity", "jobs-capacity", "jobs-temp-budget", "bytes-capacity", "control-capacity", "staging-capacity"]) {
  test(`history capacity ${mode} rejects before ledger or lease mutation`, {
    skip: process.platform !== "darwin", timeout: 40000
  }, t => {
    const root = fs.realpathSync(makeTempDir(`grok-linux-ledger-${mode}-`));
    t.after(() => removeTempFixture(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
    const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir, { mode: 0o700 });
    const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
    const fixture = fileURLToPath(new URL("./fixtures/linux-lease-ledger-simulated.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", preload, fixture], {
      encoding: "utf8", timeout: 25000,
      env: { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_LEDGER_TEST_MODE: mode }
    });
    assert.equal(result.status, 0, `${mode}: ${result.stderr}\n${result.stdout}`);
    assert.equal(result.stdout.trim(), "capacity rejected without side effects");
  });
}

test("existing detail and log files are not counted twice against outstanding slots", {
  skip: process.platform !== "darwin", timeout: 180000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-ledger-occupied-capacity-"));
  t.after(() => removeTempFixture(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir, { mode: 0o700 });
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/linux-lease-ledger-simulated.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", preload, fixture], {
    encoding: "utf8", timeout: 160000,
    env: { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_LEDGER_TEST_MODE: "occupied-capacity" }
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.stdout.trim(), "existing records counted once");
});

test("unwritten reservations retain their projected byte budget", {
  skip: process.platform !== "darwin", timeout: 90000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-ledger-pending-bytes-"));
  t.after(() => removeTempFixture(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
  const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir, { mode: 0o700 });
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/linux-lease-ledger-simulated.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", preload, fixture], {
    encoding: "utf8", timeout: 75000,
    env: { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir, GROK_LEDGER_TEST_MODE: "pending-bytes" }
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.stdout.trim(), "pending bytes preserved");
});
