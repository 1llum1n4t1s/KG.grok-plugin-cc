import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

import { getGrokAuthStatus, getGrokAvailability, runGrokTurn } from "../plugins/grok/scripts/lib/grok.mjs";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

test("injected Grok environment is used for preflight, authentication and model selection", async (t) => {
  const cwd = makeTempDir("grok-env-override-");
  const fake = installFakeGrok({ replies: [{ text: "ok" }] });
  const env = { ...fake.env, GROK_PLUGIN_MODEL: "grok-4.5" };
  const childProcess = createRequire(import.meta.url)("node:child_process");
  const originalSpawn = childProcess.spawn, owned = [];
  const observedSpawn = function(command, args, options) {
    const child = originalSpawn.apply(this, arguments);
    if (process.platform === "linux" && command === process.execPath && args?.[0]?.endsWith("posix-agent-supervisor.mjs") &&
        args?.[1] === fake.env.GROK_BIN && options?.env?.FAKE_GROK_STATE === fake.env.FAKE_GROK_STATE) {
      const record = { child, identity: null, closed: false, error: null };
      owned.push(record);
      record.close = new Promise(resolve => child.once("close", (code, signal) => { record.closed = true; resolve({ code, signal }); }));
      child.once("error", error => { record.error = error; });
      try {
        const stat = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        record.identity = { group: Number(fields[2]), start: fields[19] };
      } catch (error) { record.error = error; }
    }
    return child;
  };
  if (process.platform === "linux") { childProcess.spawn = observedSpawn; syncBuiltinESMExports(); }
  const previousBin = process.env.GROK_BIN;
  const previousModel = process.env.GROK_PLUGIN_MODEL;
  process.env.GROK_BIN = "missing-global-grok-binary";
  process.env.GROK_PLUGIN_MODEL = "grok-4.7";
  try {
    assert.equal(getGrokAvailability(cwd, env).available, true);
    assert.equal((await getGrokAuthStatus(cwd, { env })).authenticated, true);
    const result = await runGrokTurn(cwd, { env, prompt: "check injected environment", readOnly: true });
    assert.equal(result.model, "grok-4.5");
    assert.equal(fake.readState().prompts.length, 1);
  } finally {
    try {
      if (process.platform === "linux") {
        if (childProcess.spawn !== observedSpawn) throw new Error("fixture agent observer was replaced");
        childProcess.spawn = originalSpawn; syncBuiltinESMExports();
        assert.equal(owned.length, 2, "both direct agent starts must have owned child handles");
        for (const record of owned) {
          assert.equal(record.error, null);
          assert.ok(Number.isInteger(record.child.pid) && record.identity?.start);
          assert.equal(record.identity.group, record.child.pid);
          let timer;
          try {
            await Promise.race([record.close, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned agent close was not confirmed")), 5000); })]);
          } finally { clearTimeout(timer); }
          assert.ok(record.closed);
          try {
            process.kill(-record.child.pid, 0);
            throw new Error("owned agent process group is still present");
          } catch (error) { if (error.code !== "ESRCH") throw error; }
        }

      }
    } finally {
      if (process.platform === "linux" && childProcess.spawn === observedSpawn) { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
      if (previousBin === undefined) delete process.env.GROK_BIN;
      else process.env.GROK_BIN = previousBin;
      if (previousModel === undefined) delete process.env.GROK_PLUGIN_MODEL;
      else process.env.GROK_PLUGIN_MODEL = previousModel;
      removeTempFixture(cwd, { recursive: true, force: true });
    }
  }
});
