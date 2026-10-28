import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { loadState, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir, updateState, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { reserveDarwinTrackedJob } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { verifyPublishedDarwinLease } from "../plugins/grok/scripts/lib/darwin-lease-sweep.mjs";
import { makeTempDir } from "./helpers.mjs";

const darwin = { skip: process.platform !== "darwin", timeout: 45000 };
function fixture(t) {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const root = fs.realpathSync(makeTempDir("grok-around-commit-"));
  process.env.CLAUDE_PLUGIN_DATA = root;
  delete process.env.PLUGIN_DATA;
  const workspace = fs.realpathSync(makeTempDir("grok-around-workspace-"));
  const stateDir = resolveStateDir(workspace);
  const { epoch } = migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  return { root, workspace, stateDir, epoch };
}

for (const variant of ["omitted", "twice", "async", "throw-before", "throw-after", "null", "false", "zero", "empty"]) {
  test(`aroundCommit enforces synchronous single commit: ${variant}`, darwin, t => {
    const { workspace } = fixture(t);
    const before = JSON.stringify(loadState(workspace));
    const invalid = { null: null, false: false, zero: 0, empty: "" };
    const aroundCommit = Object.hasOwn(invalid, variant) ? invalid[variant] : variant === "async" ? async (_state, _context, commit) => commit()
      : (_state, _context, commit) => {
        if (variant === "omitted") return undefined;
        if (variant === "throw-before") throw new Error("before commit");
        const result = commit();
        if (variant === "twice") commit();
        if (variant === "throw-after") throw new Error("after commit");
        return result;
      };
    assert.throws(() => updateState(workspace, state => { state.config.stopReviewGate = true; }, { aroundCommit }));
    if (["omitted", "async", "throw-before", "null", "false", "zero", "empty"].includes(variant)) assert.equal(JSON.stringify(loadState(workspace)), before);
    else assert.equal(loadState(workspace).config.stopReviewGate, true);
  });
}

test("observer FD remains locked until the state index is saved", darwin, async t => {
  const { root, workspace, stateDir, epoch } = fixture(t);
  const jobId = "around-commit-observer";
  const acquired = reserveDarwinTrackedJob({ id: jobId, workspaceRoot: workspace, jobClass: "review", title: "Review" });
  const directoryIdentity = { dev: acquired.lease.directoryDev, ino: acquired.lease.directoryIno };
  try {
    withStateSnapshot(workspace, (state, context) => {
      const indexed = state.jobs.find(job => job.id === jobId);
      const stored = readJobFile(resolveJobFile(workspace, jobId));
      assert.equal(verifyPublishedDarwinLease({ context, indexed, stored,
        owner: { epoch, claimToken: acquired.claimToken, workerLease: acquired.lease, leaseFd: acquired.fd } }), true);
    });
  } finally { fs.closeSync(acquired.fd); }
  const ready = path.join(root, "saving"), release = path.join(root, "release");
  const child = fork(new URL("./fixtures/darwin-around-commit-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => {
    if (!fs.existsSync(release)) fs.writeFileSync(release, "release");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  child.send({ workspace, stateDir, lease: acquired.lease, directoryIdentity, ready, release });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(ready), "worker did not reach index save");
  const fd = fs.openSync(acquired.lease.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const locked = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], { stdio: ["ignore", "pipe", "pipe", fd], timeout: 2000 });
    assert.ifError(locked.error);
    assert.equal(locked.status, 75, "observer released lease before index save");
  } finally { fs.closeSync(fd); }
  fs.writeFileSync(release, "release");
  const [answer] = await once(child, "message");
  assert.equal(answer.type, "completed", JSON.stringify(answer));
  assert.equal(loadState(workspace).config.stopReviewGate, true);
});

for (const variant of ["omitted", "thenable", "then-getter"]) {
  test(`delayed ${variant} callback cannot mutate after the state mutex is released`, darwin, async t => {
    const { root, workspace } = fixture(t);
    const marker = path.join(root, `late-${variant}`);
    const child = fork(new URL("./fixtures/darwin-delayed-commit-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const closed = new Promise(resolve => child.once("close", resolve));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    });
    child.send({ workspace, marker, variant });
    const [result] = await once(child, "message");
    assert.ok(result.outerError);
    assert.ok(result.delayedError);
    assert.equal(result.mutated, false, "expired commit invoked the mutator");
    assert.equal(loadState(workspace).config.stopReviewGate, false);
  });
}

for (const variant of ["async", "thenable"]) {
  test(`state mutation rejects a ${variant} callback without saving`, darwin, async t => {
    const { root, workspace } = fixture(t);
    const marker = path.join(root, `mutator-${variant}`);
    const child = fork(new URL("./fixtures/darwin-async-mutator-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const closed = new Promise(resolve => child.once("close", resolve));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    });
    child.send({ workspace, marker, variant });
    const [result] = await once(child, "message");
    assert.equal(result.type, "rejected", JSON.stringify(result));
    if (variant === "async") assert.equal(result.mutated, false);
    assert.equal(loadState(workspace).config.stopReviewGate, false);
  });
}

for (const variant of ["async", "thenable"]) {
  test(`afterSave rejects a ${variant} callback without claiming rollback`, darwin, t => {
    const { root, workspace } = fixture(t);
    const marker = path.join(root, `after-save-${variant}`);
    const afterSave = variant === "async" ? async () => {
      fs.writeFileSync(marker, "callback ran");
      await Promise.resolve();
    } : () => ({ then(resolve) { resolve(); } });
    assert.throws(() => updateState(workspace, state => { state.config.stopReviewGate = true; }, { afterSave }));
    if (variant === "async") {
      assert.equal(fs.existsSync(marker), false);
      assert.equal(loadState(workspace).config.stopReviewGate, false);
    } else assert.equal(loadState(workspace).config.stopReviewGate, true);
  });
}
