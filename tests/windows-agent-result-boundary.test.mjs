import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const grok = fs.readFileSync(new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url), "utf8");
const withGrok = "const brokerRequests = new WeakMap();\nfunction getBrokerUnsentRejection() { return null; }\n" + grok.slice(grok.indexOf("async function withGrok"), grok.indexOf("function isBrokerUnsentPrompt"));

for (const transport of ["direct", "broker"]) for (const outcome of ["returned", "handler-throw", "close-throw", "both-throw", "confirmed"]) {
  test(`owned agent cleanup uncertainty survives ${transport}/${outcome}`, async () => {
    const original = new Error("handler failed");
    const closeError = new Error("close failed");
    const context = vm.createContext({ process: { env: {} }, BROKER_BUSY_RPC_CODE: -32001,
      GrokAcpClient: { connect: async () => ({ transport,
        closeStopUnconfirmed: false,
        async close() {
          this.closeStopUnconfirmed = outcome !== "confirmed";
          if (["close-throw", "both-throw"].includes(outcome)) throw closeError;
        }
      }) } });
    vm.runInContext(withGrok, context);
    const run = context.withGrok("mock", async () => {
      if (["handler-throw", "both-throw"].includes(outcome)) throw original;
      return { status: "completed", turnStopUnconfirmed: false };
    });
    const uncertain = transport === "direct" && outcome !== "confirmed";
    if (["handler-throw", "close-throw", "both-throw"].includes(outcome)) {
      await assert.rejects(run, (error) => {
        assert.equal(error, outcome === "close-throw" ? closeError : original);
        assert.equal(error.turnStopUnconfirmed === true, uncertain);
        return true;
      });
    } else {
      assert.equal((await run).turnStopUnconfirmed, uncertain);
    }
  });
}

test("owned agent startup failure retains unconfirmed stop proof", async () => {
  const error = Object.assign(new Error("startup failed"), { turnStopUnconfirmed: true });
  const context = vm.createContext({ process: { env: {} }, BROKER_BUSY_RPC_CODE: -32001,
    GrokAcpClient: { connect: async () => { throw error; } } });
  vm.runInContext(withGrok, context);
  await assert.rejects(context.withGrok("mock", () => {}), (actual) => actual === error && actual.turnStopUnconfirmed);
});

const tracked = fs.readFileSync(new URL("../plugins/grok/scripts/lib/tracked-jobs.mjs", import.meta.url), "utf8");
for (const uncertain of [true, false]) {
  test(`terminal prompt then cleanup throw persists uncertainty=${uncertain} in job state`, async () => {
    let record;
    const context = vm.createContext({ process: { pid: 123 }, nowIso: () => "now", createProcessLookupDiagnostics: () => ({}),
      getProcessSnapshot: () => ({ startKey: "key" }), appendLogBlock() {}, readStoredJobOrNull: () => record,
      commitNonTerminalTransition: (_root, _id, build) => { record = build(record ?? {}); return { accepted: true, record }; } });
    vm.runInContext(tracked.slice(tracked.indexOf("export async function runTrackedJob")).replace(/^export /, ""), context);
    await assert.rejects(context.runTrackedJob({ id: "job", workspaceRoot: "mock" }, async () => {
      record.grokPromptState = "terminal";
      throw Object.assign(new Error("cleanup failed"), { turnStopUnconfirmed: uncertain });
    }));
    assert.equal(record.terminationPending, uncertain);
    assert.equal(record.phase, uncertain ? "termination-pending" : "failed");
    assert.equal(record.grokPromptState, uncertain ? "pending" : "terminal");
  });
}
