import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stopTrackedJobProcess } from "../plugins/grok/scripts/lib/process.mjs";

// 失敗条件: 照会直後のPID再利用、生存継続、識別不能、旧jobの識別子欠落で
// 数値PIDへsignalを送る、終了を誤認する、状態lockが所有workerの終了を妨げる。
for (const platform of ["linux", "darwin"]) {
  for (const identity of ["absent", "mismatch", "match", "unavailable"]) {
    test(`POSIX tracked stop only observes exit: ${platform}/${identity}`, () => {
      let signals = 0;
      const options = { platform, terminateImpl: () => { signals += 1; },
        inspectImpl: () => identity, sleepImpl() {} };
      if (["absent", "mismatch"].includes(identity)) {
        assert.doesNotThrow(() => stopTrackedJobProcess(42, "original-start", options));
      } else {
        assert.throws(() => stopTrackedJobProcess(42, "original-start", options), /exit could not be confirmed/i);
      }
      assert.equal(signals, 0);
    });
  }
  test(`POSIX legacy identity stays pending without signals: ${platform}`, () => {
    assert.throws(() => stopTrackedJobProcess(42, null, { platform,
      terminateImpl: () => assert.fail("Legacy PID must never be signalled"),
      sleepImpl() {} }), /exit could not be confirmed/i);
  });
}

const companion = fs.readFileSync(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url), "utf8");
const source = companion.slice(companion.indexOf("async function handleCancel"), companion.indexOf("async function main"));
for (const outcome of ["exit", "pending"]) {
  test(`legacy Darwin cancel releases state lock before waiting for worker: ${outcome}`, async () => {
    const indexed = { id: "job", createdAt: "created", epoch: "current-epoch", status: "running", pid: 42, processStartKey: "worker-start",
      grokTransport: "broker", grokPromptState: "not-sent" };
    let stored = { ...indexed };
    let locked = false;
    let lockedDuringWait;
    let outputs = 0;
    const lock = fn => { assert.equal(locked, false); locked = true;
      try { return fn({ jobs: [indexed] }, { epoch: "current-epoch" }); } finally { locked = false; } };
    const context = vm.createContext({ process: { platform: "darwin", env: {}, stderr: { write() {} } },
      parseCommandInput: () => ({ options: {}, positionals: [] }), resolveCommandCwd: () => "mock",
      resolveCancelableJob: () => ({ workspaceRoot: "mock", job: indexed }), isActiveJob: () => true,
      updateState: (_root, fn) => lock(fn), withStateSnapshot: (_root, fn) => lock(fn),
      readStoredJob: () => { assert.equal(locked, true); return stored; },
      writeJobFile: (_root, _id, value) => { assert.equal(locked, true); stored = value; },
      inspectTrackedJobProcess: () => "match", createProcessLookupDiagnostics: () => ({}),
      stopTrackedJobProcess: () => {
        lockedDuringWait = locked;
        assert.equal(locked, false, "Worker must be free to persist terminal state while cancel waits");
        assert.equal(stored.terminationPending, true);
        if (outcome === "pending") throw Error("Process exit could not be confirmed.");
      },
      nowIso: () => "now", appendLogLine() {}, setTimeout: () => ({ unref() {} }),
      outputCommandResult: () => { outputs += 1; }, renderCancelReport: () => "report"
    });
    vm.runInContext(source, context);
    const operation = context.handleCancel([]);
    if (outcome === "exit") {
      await operation;
      assert.equal(stored.terminationPending, false);
      assert.equal(stored.pid, null);
      assert.equal(outputs, 1);
    } else {
      await assert.rejects(operation, /cancellation remains pending/i);
      assert.equal(stored.terminationPending, true);
      assert.equal(stored.pid, 42);
      assert.equal(outputs, 0);
    }
    assert.equal(lockedDuringWait, false);
  });
}
