import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 実 Mac 親子 process、root flock の競合と sentinel の実 socket を使用する。
// procfs/mount/flock は模擬であり、Linux kernel や同期 fsync の中断を実証しない。
for (const scenario of ["ready-stalls", "ready-completes", "parent-alive-stalls"]) {
test(`sentinel handles parent death after commit when ${scenario}`, {
  skip: process.platform !== "darwin", timeout: 90000
}, async t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-sentinel-aborted-commit-"));
  const stateDir = path.join(root, "state"), barrier = path.join(stateDir, "state.lock");
  for (const dir of [stateDir, barrier, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const generation = randomUUID(), nonce = randomBytes(16).toString("hex");
  const ready = path.join(root, "commit-gate"), release = path.join(root, "commit-release");
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const gate = fileURLToPath(new URL("./fixtures/linux-history-sentinel-commit-gate.mjs", import.meta.url));
  const launcherScript = fileURLToPath(new URL("./fixtures/linux-history-sentinel-commit-launcher.mjs", import.meta.url));
  const contender = fileURLToPath(new URL("./fixtures/linux-history-root-flock-contender.mjs", import.meta.url));
  const sentinelScript = fileURLToPath(new URL("../plugins/grok/scripts/lib/linux-state-sentinel.mjs", import.meta.url));
  const env = { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    GROK_HISTORY_SENTINEL_GENERATION: generation, GROK_HISTORY_SENTINEL_NONCE: nonce,
    GROK_HISTORY_COMMIT_GATE: ready, GROK_HISTORY_COMMIT_RELEASE: release,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)} --import ${JSON.stringify(gate)}`.trim() };
  let launcher, closed, childPid, verifiedDone = false;
  const alive = pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  const stop = () => spawnSync(process.execPath, [sentinelScript, "stop", generation, nonce], { env, encoding: "utf8", timeout: 5000 });
  t.after(async () => {
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
    if (closed) await closed;
    if (alive(childPid)) {
      const result = stop();
      if (result.status !== 0) t.diagnostic(`Sentinel stop was not confirmed: ${result.stderr}`);
      const deadline = Date.now() + 5000;
      while (alive(childPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (verifiedDone && !alive(childPid)) removeTempFixture(root, { recursive: true, force: true });
    else t.diagnostic(`Retained aborted-commit fixture: ${root}`);
  });
  launcher = spawn(process.execPath, [launcherScript], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; launcher.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => launcher.once("exit", (code, signal) => resolve({ code, signal })));
  closed = new Promise(resolve => launcher.once("close", (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(ready) && launcher.exitCode === null && launcher.signalCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(ready), `sentinel must accept commit and pause before ready: ${stderr}`);
  const gateState = JSON.parse(fs.readFileSync(ready, "utf8")); childPid = gateState.pid;
  assert.equal(gateState.parent, launcher.pid); assert.ok(alive(childPid));
  const probe = () => spawnSync(process.execPath, [contender], { env, encoding: "utf8", timeout: 10000 });
  const before = probe();
  assert.equal(before.status, 73, `the root flock must be held before parent death: ${before.stdout} ${before.stderr}`);
  if (scenario !== "parent-alive-stalls") {
    launcher.kill("SIGKILL");
    const parent = await exited; assert.equal(parent.signal, "SIGKILL");
  }
  const readyFile = path.join(barrier, "sentinel-ready.json");
  if (scenario === "ready-completes") {
    // commit の ACK を受け取る親が消えても、期限内に ready を完了した場合は存続できる。
    fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
    const readyDeadline = Date.now() + 8000;
    while (!fs.existsSync(readyFile) && alive(childPid) && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(readyFile), "a timely ready must complete after parent death");
    let after = probe(); const unlockDeadline = Date.now() + 5000;
    while (after.status === 73 && Date.now() < unlockDeadline) { await new Promise(resolve => setTimeout(resolve, 20)); after = probe(); }
    assert.equal(after.status, 0, `ready sentinel must release the temporary root flock: ${after.stderr}`);
    const readyRecord = JSON.parse(fs.readFileSync(readyFile, "utf8"));
    assert.equal(readyRecord.generation, generation); assert.equal(readyRecord.nonce, nonce); assert.equal(readyRecord.pid, childPid);
    assert.ok(alive(childPid), "the ready sentinel must remain alive until nonce stop");
    const stopped = stop(); assert.equal(stopped.status, 0, stopped.stderr);
    const stopDeadline = Date.now() + 5000;
    while (alive(childPid) && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(!alive(childPid), "nonce stop must terminate the ready sentinel");
  } else {
    const childDeadline = Date.now() + 8000;
    while (alive(childPid) && Date.now() < childDeadline) {
      if (scenario === "parent-alive-stalls") assert.equal(launcher.exitCode, null, "the parent must remain alive while ready is pending");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const after = probe();
    t.diagnostic(`commit accepted; ${scenario}; sentinel alive=${alive(childPid)}; root flock=${after.stdout.trim() || after.stderr.trim()}`);
    assert.ok(!alive(childPid), "sentinel must not survive indefinitely without its bootstrap parent before ready");
    assert.equal(after.status, 0, `root flock must be released after the sentinel exits: ${after.stderr}`);
    assert.ok(!fs.existsSync(readyFile), "aborted startup must not publish ready");
  }
  verifiedDone = true;
});
}
