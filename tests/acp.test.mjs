import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";

import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

async function waitForOwnedExit(record, timeoutMs = 4000) {
  if (record.exited) return true;
  let timer;
  try {
    return await Promise.race([record.exit.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

test("failed direct ACP initialization closes the spawned agent", async (t) => {
  const cwd = makeTempDir("grok-acp-failed-init-");
  const fake = installFakeGrok({ initializeError: "fixture initialization failed" });
  const childProcess = createRequire(import.meta.url)("node:child_process");
  const originalSpawn = childProcess.spawn;
  const owned = [];
  let failure;
  const observedSpawn = function(command, args, options) {
    const child = originalSpawn.apply(this, arguments);
    const supervisor = process.platform === "win32" && path.win32.basename(String(command)).toLowerCase() === "powershell.exe" &&
      Array.isArray(args) && args.some(value => String(value).endsWith("windows-agent-supervisor.ps1"));
    const direct = process.platform !== "win32" && command === process.execPath &&
      args?.[0]?.endsWith("posix-agent-supervisor.mjs") && args?.[1] === fake.env.GROK_BIN && args?.[2] === "agent" && args?.[3] === "stdio";
    if ((direct || supervisor) && options?.cwd === cwd && options?.env?.FAKE_GROK_STATE === fake.env.FAKE_GROK_STATE) {
      const record = { child, exited: false, exit: null, spawnError: null };
      record.exit = new Promise(resolve => child.once("exit", (code, signal) => { record.exited = true; resolve({ code, signal }); }));
      child.once("error", error => { record.spawnError = error; });
      owned.push(record);
    }
    return child;
  };
  childProcess.spawn = observedSpawn;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      GrokAcpClient.connectForeground(cwd, {
        grokBin: fake.env.GROK_BIN,
        env: fake.env
      }),
      error => { failure = error; return /fixture initialization failed/.test(error.message); }
    );
    const pid = fake.readState()?.pid;
    assert.ok(Number.isInteger(pid), "the fake agent must have started");
    assert.equal(owned.length, 1, "the spawned agent or Windows supervisor must have an observed child handle");
    assert.ok(Number.isInteger(owned[0].child.pid), "the observed child handle must belong to a spawned process");
    if (process.platform !== "win32") assert.notEqual(owned[0].child.pid, pid, "the supervisor and fixture agent must be distinct processes");
    assert.equal(await waitForOwnedExit(owned[0]), true, "the rejected handshake must close the observed child");
    assert.notEqual(failure.turnStopUnconfirmed, true);
  } finally {
    if (childProcess.spawn === observedSpawn) {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
    for (const record of owned) {
      if (!record.exited && record.child.exitCode === null && record.child.signalCode === null && Number.isInteger(record.child.pid)) {
        record.child.kill("SIGTERM");
      }
      if (!(await waitForOwnedExit(record))) throw new Error(`Fixture child exit was not confirmed; preserve ${cwd} and ${fake.binDir}`);
    }
    if (!owned.length && Number.isInteger(fake.readState()?.pid)) throw new Error(`Fixture child handle was not observed; preserve ${cwd} and ${fake.binDir}`);
    if (process.platform === "win32" && Number.isInteger(fake.readState()?.pid) && failure?.turnStopUnconfirmed === true) {
      throw new Error(`Fixture Windows Job termination was not confirmed; preserve ${cwd} and ${fake.binDir}`);
    }
    if (process.platform === "linux") {
      assert.equal(owned.length, 1, "owned agent handle was not confirmed");
      assert.ok(owned[0].exited && Number.isInteger(owned[0].child.pid));
      assert.notEqual(failure.turnStopUnconfirmed, true);

    }
    removeTempFixture(cwd, { recursive: true, force: true });
  }
});
