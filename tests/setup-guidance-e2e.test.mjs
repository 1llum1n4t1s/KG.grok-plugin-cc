import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installFakeGrok } from "./fake-grok-fixture.mjs";

const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));

test("setup explains installation, update, authentication and actual check failures", { skip: process.platform === "win32" }, () => {
  const fake = installFakeGrok();
  try {
    const invoke = (env, json = false) => spawnSync(process.execPath, [cli, "setup", ...(json ? ["--json"] : [])], { env, encoding: "utf8", timeout: 15000 });
    const check = (env, reason, match, detail) => {
      const plain = invoke(env);
      const json = invoke(env, true);
      assert.equal(plain.status, reason ? 1 : 0, plain.stderr);
      assert.equal(json.status, reason ? 1 : 0, json.stderr);
      const data = JSON.parse(json.stdout);
      assert.equal(data.reason ?? null, reason);
      assert.equal(data.authenticated, !reason);
      if (match) { assert.match(plain.stdout, match); assert.match(data.guidance, match); }
      else { assert.equal(data.guidance, undefined); assert.doesNotMatch(plain.stdout, /grok login|grok update|install\.sh/); }
      if (detail) { assert.match(plain.stdout, detail); assert.match(data.detail, detail); }
      return data;
    };
    const missing = check({ ...fake.env, GROK_BIN: path.join(fake.binDir, "missing") }, "grok-missing", /curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash/);
    assert.equal(missing.availability.reason, "not-installed");
    const oldBin = path.join(fake.binDir, "old-grok");
    fs.writeFileSync(oldBin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo old; exit 0; fi\nexit 1\n', { mode: 0o755 });
    const old = check({ ...fake.env, GROK_BIN: oldBin }, "grok-missing", /grok update/);
    assert.equal(old.availability.reason, "missing-agent-stdio");
    fs.writeFileSync(fake.env.FAKE_GROK_SCENARIO, JSON.stringify({ authError: true }));
    const auth = check(fake.env, "not-authenticated", /grok login/);
    assert.match(auth.guidance, /--device-auth/);
    assert.match(auth.guidance, /XAI_API_KEY/);
    fs.writeFileSync(fake.env.FAKE_GROK_SCENARIO, JSON.stringify({ sessionError: "fixture session failure" }));
    check(fake.env, "check-failed", null, /fixture session failure/);
    fs.writeFileSync(fake.env.FAKE_GROK_SCENARIO, JSON.stringify({ initializeError: "fixture connect failure" }));
    check(fake.env, "connect-failed", null, /fixture connect failure/);
    fs.writeFileSync(fake.env.FAKE_GROK_SCENARIO, "{}");
    check(fake.env, null, null);
  } finally {
    fs.rmSync(fake.binDir, { recursive: true, force: true });
  }
});
