import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import { getGrokAuthStatus, getGrokAvailability, runGrokTurn } from "../plugins/grok/scripts/lib/grok.mjs";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

test("injected Grok environment is used for preflight, authentication and model selection", async () => {
  const fake = installFakeGrok({ replies: [{ text: "ok" }] });
  const cwd = makeTempDir("grok-env-override-");
  const env = { ...fake.env, GROK_PLUGIN_MODEL: "grok-4.5" };
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
    if (previousBin === undefined) delete process.env.GROK_BIN;
    else process.env.GROK_BIN = previousBin;
    if (previousModel === undefined) delete process.env.GROK_PLUGIN_MODEL;
    else process.env.GROK_PLUGIN_MODEL = previousModel;
  }
});
