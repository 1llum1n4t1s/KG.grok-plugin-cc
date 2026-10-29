import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { loadState, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";
import { sameLinuxLease } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
import { verifyPublishedLinuxLeaseRecords } from "../plugins/grok/scripts/lib/linux-lease-ledger.mjs";
import { withAvailableLinuxLease } from "../plugins/grok/scripts/lib/linux-worker-lease.mjs";

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
test("Linux direct spawn and cancellation are ordered under one state mutex", { skip: process.platform !== "linux", timeout: 60000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-spawn-cancel-"));
  process.env.CLAUDE_PLUGIN_DATA = root;
  delete process.env.PLUGIN_DATA;
  const workspace = fs.realpathSync(makeTempDir("grok-spawn-workspace-"));
  const rootIdentity = fs.lstatSync(root, { bigint: true }), workspaceIdentity = fs.lstatSync(workspace, { bigint: true });
  assert.ok(rootIdentity.isDirectory() && !rootIdentity.isSymbolicLink() && workspaceIdentity.isDirectory() && !workspaceIdentity.isSymbolicLink());
  const stateDir = resolveStateDir(workspace);
  assert.ok(path.isAbsolute(stateDir) && stateDir.startsWith(root + path.sep));
  assert.equal(fs.existsSync(stateDir), false, "state directory must be unused before migration");
  const fifo = path.join(root, "spawn.fifo"), ready = path.join(root, "spawn-ready"), called = path.join(root, "spawn-called"),
    selected = path.join(root, "cancel-selected"), agentStarted = path.join(root, "agent-started"), agentExited = path.join(root, "agent-exited");
  let worker, workerClosed, cancel, cancelClosed, probe, probeClosed, job, epoch, stateIdentity;
  let migrationStarted = false, migrated = false, released = false;
  async function releaseGate() {
    if (released || !fs.existsSync(ready)) return;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        const fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
        try { fs.writeSync(fd, "x"); } finally { fs.closeSync(fd); }
        released = true;
        return;
      } catch (error) {
        if (error.code !== "ENXIO") throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }
  const waitClosed = async (closed, timeoutMs) => {
    let timer;
    try { return await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref(); })]); }
    finally { clearTimeout(timer); }
  };
  const groupIsGone = identity => {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      let raw;
      try { raw = fs.readFileSync(`/proc/${name}/stat`, "utf8"); }
      catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
      const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      if (fields.length < 20) throw new Error(`Cannot inspect process ${name}`);
      if (!["Z", "X", "x"].includes(fields[0]) && (Number(fields[2]) === identity.group ||
          (Number(name) === identity.pid && fields[19] === identity.start))) return false;
    }
    return true;
  };
  t.after(async () => {
    try {
      await releaseGate();
      for (const [child, closed] of [[probe, probeClosed], [cancel, cancelClosed], [worker, workerClosed]]) {
        if (!child) continue;
        if (!(await waitClosed(closed, 8000))) {
          assert.equal(child.kill("SIGTERM"), true, "owned child termination signal failed");
          assert.ok(await waitClosed(closed, 5000), "owned child did not exit after termination");
        }
        assert.ok(child.exitCode !== null || child.signalCode !== null, "owned child exit unconfirmed");
      }
      if (migrationStarted) {
        assert.ok(migrated && epoch && stateIdentity, "migration identity unconfirmed");
        assert.equal(resolveStateDir(workspace), stateDir);
        const currentRoot = fs.lstatSync(root, { bigint: true }), currentWorkspace = fs.lstatSync(workspace, { bigint: true });
        assert.ok(currentRoot.isDirectory() && !currentRoot.isSymbolicLink() && currentRoot.dev === rootIdentity.dev && currentRoot.ino === rootIdentity.ino);
        assert.ok(currentWorkspace.isDirectory() && !currentWorkspace.isSymbolicLink() && currentWorkspace.dev === workspaceIdentity.dev && currentWorkspace.ino === workspaceIdentity.ino);
        const currentState = fs.lstatSync(stateDir, { bigint: true });
        assert.ok(currentState.isDirectory() && !currentState.isSymbolicLink() && currentState.dev === stateIdentity.dev && currentState.ino === stateIdentity.ino);
        assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).epoch, epoch);
        if (worker) {
          assert.ok(job?.workerLease && job.epoch === epoch && job.pid === worker.pid, "worker lease identity was not recorded");
          withStateSnapshot(workspace, (state, context) => {
            const indexed = state.jobs.find(current => current.id === job.id);
            const stored = readJobFile(resolveJobFile(workspace, job.id));
            assert.equal(context.epoch, epoch);
            assert.ok(indexed && stored && indexed.claimToken === job.claimToken && stored.claimToken === job.claimToken);
            assert.ok(sameLinuxLease(indexed.workerLease, job.workerLease) && sameLinuxLease(stored.workerLease, job.workerLease));
            const releasedLease = withAvailableLinuxLease(job.workerLease, context, () => {
              verifyPublishedLinuxLeaseRecords({ context, indexed, stored, lease: job.workerLease });
              return true;
            });
            assert.equal(releasedLease.status, "available", "worker lease release is unconfirmed");
          });
        }
        if (fs.existsSync(called)) assert.ok(fs.existsSync(agentStarted), "spawn was attempted but agent identity was not recorded");
        if (fs.existsSync(agentStarted)) {
          const identity = JSON.parse(fs.readFileSync(agentStarted, "utf8"));
          assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0 && identity.group === identity.pid && typeof identity.start === "string" && identity.start);
          const deadline = Date.now() + 8000;
          while ((!fs.existsSync(agentExited) || !groupIsGone(identity)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
          assert.ok(fs.existsSync(agentExited), "agent exit marker is missing");
          assert.deepEqual(JSON.parse(fs.readFileSync(agentExited, "utf8")), identity);
          assert.ok(groupIsGone(identity), "agent or its process group is still running");
        }
        const stopped = shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
        assert.equal(stopped.epoch, epoch); assert.equal(stopped.stopped, true);
      }
      removeTempFixture(root, { recursive: true, force: true });
      removeTempFixture(workspace, { recursive: true, force: true });
    } catch (error) {
      t.diagnostic(`Fixture retained because owned shutdown is unconfirmed: ${root}; ${workspace}`);
      throw error;
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  migrationStarted = true;
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  stateIdentity = fs.lstatSync(stateDir, { bigint: true });
  epoch = JSON.parse(fs.readFileSync(path.join(stateDir, "state.lock", "protocol.json"), "utf8")).epoch;
  assert.ok(epoch, "state epoch was not recorded");
  migrated = true;
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const wrapper = path.join(root, "fake-grok");
  const agent = fileURLToPath(new URL("./fixtures/linux-direct-spawn-agent.mjs", import.meta.url));
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(agent)} "$@"\n`, { mode: 0o700, flag: "wx" });
  const env = { ...process.env, GROK_BIN: wrapper, XAI_API_KEY: "test-only", GROK_COMPANION_DISABLE_BROKER: "1",
    GROK_TEST_DIRECT_BIN: wrapper, GROK_TEST_SPAWN_READY: ready, GROK_TEST_SPAWN_FIFO: fifo, GROK_TEST_SPAWN_CALLED: called,
    GROK_TEST_AGENT_STARTED: agentStarted, GROK_TEST_AGENT_EXITED: agentExited };
  const command = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
  worker = spawn(process.execPath, ["--require", fileURLToPath(new URL("./fixtures/linux-direct-spawn-gate.cjs", import.meta.url)),
    command, "task", "--cwd", workspace, "--json", "test"], { env, stdio: ["ignore", "ignore", "pipe"] });
  worker.stderr.resume();
  workerClosed = new Promise(resolve => worker.once("close", resolve));
  const waitFor = async (predicate, label, ms = 15000) => {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), `timed out waiting for ${label}`);
  };
  await waitFor(() => fs.existsSync(ready), "spawn gate");
  job = loadState(workspace).jobs.find(entry => entry.status === "running");
  assert.ok(job);
  assert.equal(job.pid, worker.pid, "spawn gate must belong to the selected worker");
  assert.equal(fs.existsSync(called), false, "spawn must still be held at the gate");
  assert.equal(fs.existsSync(agentStarted), false, "agent started before the held spawn");
  const cancelEnv = { ...env, GROK_TEST_STATE_FILE: path.join(stateDir, "state.json"), GROK_TEST_CANCEL_SELECTED: selected, GROK_TEST_JOB_ID: job.id };
  cancel = spawn(process.execPath, ["--import", new URL("./fixtures/linux-cancel-read-observer.mjs", import.meta.url).href,
    command, "cancel", "--cwd", workspace, "--json", job.id], { env: cancelEnv, stdio: ["ignore", "ignore", "pipe"] });
  cancel.stderr.resume();
  cancelClosed = new Promise(resolve => cancel.once("close", resolve));
  await waitFor(() => fs.existsSync(selected), "cancel selection");
  assert.equal(fs.readFileSync(selected, "utf8"), job.id);
  const runProbe = async timeoutMs => {
    probe = fork(new URL("./fixtures/linux-direct-mutex-probe.mjs", import.meta.url), [], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    probe.stderr.resume();
    probeClosed = new Promise(resolve => probe.once("close", resolve));
    probe.send({ stateDir, timeoutMs });
    const [result] = await once(probe, "message");
    await probeClosed;
    return result;
  };
  const blocked = await runProbe(0);
  assert.equal(blocked.acquired, false, "state mutex must cover admission verification through spawn");
  assert.match(blocked.message, /^Timed out acquiring Linux state root lock$/);
  assert.notEqual(loadState(workspace).jobs.find(entry => entry.id === job.id)?.status, "cancelled");
  await releaseGate();
  assert.equal(released, true);
  await waitFor(() => fs.existsSync(called), "synchronous spawn call");
  await waitFor(() => fs.existsSync(agentStarted), "owned agent identity");
  await waitFor(() => withStateSnapshot(workspace, state => state.jobs.find(entry => entry.id === job.id)?.status === "cancelled"), "cancellation intent");
  const available = await runProbe(5000);
  assert.equal(available.acquired, true, `state mutex did not become available after spawn: ${available.message}`);
});
