import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";

for (const variant of ["epoch", "pid", "start", "current"]) {
  test(`isolated simulated Linux direct registration checks original ${variant} owner`, { timeout: 10000 }, async t => {
    const child = fork(new URL("./fixtures/direct-owner-epoch-simulated-worker.mjs", import.meta.url), [], {
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    });
    const closed = new Promise(resolve => child.once("close", resolve));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    });
    child.send(variant);
    const [answer] = await once(child, "message");
    assert.equal(answer.type, variant === "current" ? "registered" : "rejected", JSON.stringify(answer));
    assert.equal(answer.writes, variant === "current" ? 1 : 0);
    if (variant !== "current") assert.match(answer.message, /cancelled or its running worker identity/);
  });
}
