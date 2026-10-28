import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { loadState, migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { makeTempDir } from "./helpers.mjs";

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
test("Linux direct spawn and cancellation are ordered under one state mutex", { skip: process.platform !== "linux", timeout: 60000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-spawn-cancel-"));
  process.env.CLAUDE_PLUGIN_DATA = root;
  delete process.env.PLUGIN_DATA;
  const workspace = fs.realpathSync(makeTempDir("grok-spawn-workspace-"));
  const stateDir = resolveStateDir(workspace);
  const fifo = path.join(root, "spawn.fifo"), ready = path.join(root, "spawn-ready"), called = path.join(root, "spawn-called"),
    selected = path.join(root, "cancel-selected"), agentStarted = path.join(root, "agent-started"), agentExited = path.join(root, "agent-exited");
  let worker, workerClosed, cancel, cancelClosed, probe, probeClosed, migrated = false, released = false;
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
  t.after(async () => {
    try {
      await releaseGate();
      for (const [child, closed] of [[probe, probeClosed], [cancel, cancelClosed], [worker, workerClosed]]) {
        if (!child) continue;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }
      if (migrated && !fs.existsSync(agentStarted)) {
        shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
      } else if (migrated) t.diagnostic(`Retained state and sentinel pending owned-agent exit verification: ${root}`);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
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
  const job = loadState(workspace).jobs.find(entry => entry.status === "running");
  assert.ok(job);
  const cancelEnv = { ...env, GROK_TEST_STATE_FILE: path.join(stateDir, "state.json"), GROK_TEST_CANCEL_SELECTED: selected };
  cancel = spawn(process.execPath, ["--import", new URL("./fixtures/linux-cancel-read-observer.mjs", import.meta.url).href,
    command, "cancel", "--cwd", workspace, "--json", job.id], { env: cancelEnv, stdio: ["ignore", "ignore", "pipe"] });
  cancel.stderr.resume();
  cancelClosed = new Promise(resolve => cancel.once("close", resolve));
  await waitFor(() => fs.existsSync(selected), "cancel selection");
  let acquired = false;
  for (let attempt = 0; attempt < 12 && !acquired; attempt += 1) {
    probe = fork(new URL("./fixtures/linux-direct-mutex-probe.mjs", import.meta.url), [], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    probe.stderr.resume();
    probeClosed = new Promise(resolve => probe.once("close", resolve));
    probe.send(workspace);
    const [result] = await once(probe, "message");
    acquired = result.acquired;
    if (!acquired) assert.match(result.message, /timed out/i);
    await probeClosed;
    if (!acquired) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(acquired, false, "state mutex must cover admission verification through spawn");
  assert.notEqual(loadState(workspace).jobs.find(entry => entry.id === job.id)?.status, "cancelled");
  await releaseGate();
  assert.equal(released, true);
  await waitFor(() => fs.existsSync(called), "synchronous spawn call");
  await waitFor(() => loadState(workspace).jobs.find(entry => entry.id === job.id)?.status === "cancelled", "cancellation intent");
});
