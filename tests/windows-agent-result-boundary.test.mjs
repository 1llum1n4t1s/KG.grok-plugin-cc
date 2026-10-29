import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const grok = fs.readFileSync(new URL("../plugins/grok/scripts/lib/grok.mjs", import.meta.url), "utf8");
const withGrok = grok.slice(grok.indexOf("async function withGrok"), grok.indexOf("function findSessionConfigOption"));

test("owned agent cleanup uncertainty survives return and failure outcomes", async () => {
  for (const outcome of ["returned", "handler-throw", "close-throw", "both-throw", "confirmed"]) {
    const original = new Error("handler failed");
    const closeError = new Error("close failed");
    const context = vm.createContext({ process: { env: {} },
      GrokAcpClient: { connectForeground: async () => ({
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
    const uncertain = outcome !== "confirmed";
    if (["handler-throw", "close-throw", "both-throw"].includes(outcome)) {
      await assert.rejects(run, (error) => {
        assert.equal(error, outcome === "close-throw" ? closeError : original, outcome);
        assert.equal(error.turnStopUnconfirmed === true, uncertain, outcome);
        return true;
      });
    } else {
      assert.equal((await run).turnStopUnconfirmed, uncertain, outcome);
    }
  }
});

test("owned agent startup failure retains unconfirmed stop proof", async () => {
  const error = Object.assign(new Error("startup failed"), { turnStopUnconfirmed: true });
  const context = vm.createContext({ process: { env: {} },
    GrokAcpClient: { connectForeground: async () => { throw error; } } });
  vm.runInContext(withGrok, context);
  await assert.rejects(context.withGrok("mock", () => {}), (actual) => actual === error && actual.turnStopUnconfirmed);
});
