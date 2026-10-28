import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { inspectTrackedJobProcess } from "../plugins/grok/scripts/lib/process.mjs";

// 失敗条件: 親が同期cancel待ちでreapできず、停止済workerのPIDがMac上でZとして
// 残る。kill(pid,0)成功や<defunct>のcommandだけで、生存/終了を決めない。
for (const commandLine of ["node grok-companion.mjs task", "<defunct>", null]) {
for (const stat of ["Z", "Z+", "Zs", "S", "R+", "", "bad", "ZZ"]) {
  test(`Darwin tracked worker treats only verified zombie state as exit: ${commandLine}/${stat}`, () => {
    let queries = 0;
    const identity = inspectTrackedJobProcess(42, "darwin-lstart-utc-v1:start", { platform: "darwin",
      getProcessSnapshotImpl: () => commandLine === null ? null : { startKey: "darwin-lstart-utc-v1:start", commandLine },
      processExistsImpl: () => true, sleepImpl() {},
      runCommandImpl(command, args, options) {
        queries += 1;
        assert.equal(command, "ps");
        assert.deepEqual(args, ["-p", "42", "-o", "pid=", "-o", "stat="]);
        assert.equal(options.shell, false); assert.ok(options.timeout > 0 && options.timeout <= 3000);
        return { status: 0, stdout: `42 ${stat}\n`, stderr: "", error: null };
      }
    });
    assert.equal(identity, ["Z", "Z+", "Zs"].includes(stat) ? "absent" :
      commandLine === "node grok-companion.mjs task" ? "match" : "unavailable");
    assert.equal(queries, 1);
  });
}
}

for (const result of [
  { status: 0, stdout: "99 Z\n" },
  { status: 1, stdout: "42 Z\n" },
  { status: 0, stdout: "42 Z\n99 Z\n" },
  { status: 0, stdout: "42 Z\n", error: Object.assign(Error("timeout"), { code: "ETIMEDOUT" }) }
]) {
  test(`Darwin zombie lookup fails closed for invalid response ${JSON.stringify(result)}`, () => {
    assert.equal(inspectTrackedJobProcess(42, "darwin-lstart-utc-v1:start", { platform: "darwin",
      getProcessSnapshotImpl: () => ({ startKey: "darwin-lstart-utc-v1:start", commandLine: "<defunct>" }),
      processExistsImpl: () => true, runCommandImpl: () => result
    }), "unavailable");
  });
}

test("Darwin zombie lookup never extends the caller deadline", () => {
  let queries = 0;
  assert.equal(inspectTrackedJobProcess(42, "darwin-lstart-utc-v1:start", { platform: "darwin",
    processLookupDeadline: performance.now() - 1, processExistsImpl: () => true,
    runCommandImpl: () => { queries += 1; }, sleepImpl() {}
  }), "unavailable");
  assert.equal(queries, 0);
});
