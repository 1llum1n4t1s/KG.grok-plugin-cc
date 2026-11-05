import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url), "utf8");
const wait = source.slice(source.indexOf("async function waitForExitWithTimeout"), source.indexOf("class HandshakeTimeoutError"));
const handshake = source.slice(source.indexOf("function withTimeout("));
for (const helper of ["waitForExitWithTimeout", "withTimeout"]) {
  for (const outcome of ["resolve", "reject", "timeout"]) {
    test(`ACP ${helper} keeps its deadline live and clears settled timers: ${outcome}`, async () => {
      const timers = new Map();
      const context = vm.createContext({ CLOSE_TIMEOUT_MS: 1000,
        HandshakeTimeoutError: class extends Error {},
        setTimeout(callback, ms) {
          assert.equal(ms, 1000);
          const handle = { unref() { assert.fail("an outstanding confirmation deadline must remain live"); } };
          timers.set(handle, callback); return handle;
        },
        clearTimeout(handle) { timers.delete(handle); }
      });
      vm.runInContext(wait + handshake, context);
      let resolve, reject;
      const pending = new Promise((res, rej) => { resolve = res; reject = rej; });
      const result = context[helper](pending, 1000);
      assert.equal(timers.size, 1);
      if (outcome === "resolve") { resolve("settled"); assert.equal(await result, "settled"); }
      else if (outcome === "reject") { reject(new Error("fixture failure")); await assert.rejects(result, /fixture failure/); }
      else {
        const [handle, fire] = timers.entries().next().value;
        timers.delete(handle); fire();
        if (helper === "withTimeout") await assert.rejects(result);
        else assert.equal(await result, undefined);
      }
      assert.equal(timers.size, 0);
    });
  }
}
