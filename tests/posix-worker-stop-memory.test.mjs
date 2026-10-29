import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { boundJsonDiagnostic, hasGenerationIdentity, sameTurnEvidence } from "../plugins/grok/scripts/lib/tracked-jobs.mjs";
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
for (const missing of ["index", "detail"]) {
  test(`Darwin cancel retains the job when the ${missing} record lacks a lease`, async () => {
    const lease = { id: "lease", slot: 0, path: "/virtual/lease", dev: "1", ino: "2", stateGeneration: "current-epoch", directoryDev: "1", directoryIno: "3" };
    const indexed = { id: "job", createdAt: "created", epoch: "current-epoch", status: "running", pid: 42, processStartKey: "worker-start",
      claimToken: "claim", workerLease: lease, grokTransport: "broker", grokPromptState: "not-sent" };
    let stored = { ...indexed };
    if (missing === "index") delete indexed.workerLease;
    else delete stored.workerLease;
    const original = JSON.stringify([indexed, stored]);
    let locked = false;
    let outputs = 0;
    const lock = fn => { assert.equal(locked, false); locked = true;
      try { return fn({ jobs: [indexed] }, { epoch: "current-epoch" }); } finally { locked = false; } };
    const context = vm.createContext({ process: { platform: "darwin", env: {}, stderr: { write() {} } },
      parseCommandInput: () => ({ options: {}, positionals: [] }), resolveCommandCwd: () => "mock",
      resolveCancelableJob: () => ({ workspaceRoot: "mock", job: indexed }), isActiveJob: () => true,
      updateState: (_root, fn) => lock(fn), withStateSnapshot: (_root, fn) => lock(fn),
      readStoredJob: () => { assert.equal(locked, true); return stored; },
      writeJobFile: () => assert.fail("An unverified job must not be changed"),
      inspectTrackedJobProcess: () => assert.fail("An unverified PID must not be inspected"), createProcessLookupDiagnostics: () => ({}),
      stopTrackedJobProcess: () => assert.fail("An unverified worker must not be stopped"),
      nowIso: () => "now", appendLogLine() {}, setTimeout: () => ({ unref() {} }),
      outputCommandResult: () => { outputs += 1; }, renderCancelReport: () => "report"
    });
    Object.assign(context, { boundJsonDiagnostic, hasGenerationIdentity, sameTurnEvidence, performance });
    vm.runInContext(source, context);
    await assert.rejects(context.handleCancel([]), /no verified current worker lease/i);
    assert.equal(JSON.stringify([indexed, stored]), original);
    assert.equal(outputs, 0);
    assert.equal(locked, false);
  });
}
