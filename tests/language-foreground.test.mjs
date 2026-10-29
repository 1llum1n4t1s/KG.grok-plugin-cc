import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo } from "./helpers.mjs";

const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const output = JSON.stringify({ verdict: "approve", summary: "Reviewed", findings: [], next_steps: [] });

test("foreground audit validates language tags and sends normalized language with the focus", { skip: process.platform === "win32" }, () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-language-work-"));
  const fake = installFakeGrok({ replies: [{ text: output }] });
  initGitRepo(workspace);
  const invoke = (tag) => spawnSync(process.execPath, [cli, "audit", "--language", tag, "focus on retries --language en"],
    { cwd: workspace, env: fake.env, encoding: "utf8", timeout: 15000 });
  for (const [tag, normalized] of [["ja-jp", "ja-JP"], ["en-GB-oed", "en-gb-oed"], ["zh-cmn-Hans-CN", "zh-cmn-hans-cn"], ["x-kagayoi", "x-kagayoi"], ["en-u-ca-gregory-x-local", "en-u-ca-gregory-x-local"]]) {
    const result = invoke(tag);
    assert.equal(result.status, 0, result.stderr);
    const prompt = fake.readState().prompts[0];
    assert.ok(prompt.includes(`BCP 47 tag "${normalized}"`));
    assert.ok(prompt.includes("focus on retries --language en"));
  }
  const stateBeforeInvalid = fs.readFileSync(fake.statePath, "utf8");
  for (const tag of ["x", "en-a-foo-a-bar", "en-1901-1901", "en--US", 'en" do something']) {
    const result = invoke(tag);
    assert.equal(result.status, 1, tag);
    assert.match(result.stderr, /Invalid BCP 47 language tag/);
    assert.equal(fs.readFileSync(fake.statePath, "utf8"), stateBeforeInvalid);
  }
});

test("foreground audit preserves invalid review text without exposing a partial result", { skip: process.platform === "win32" }, () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-invalid-review-work-"));
  const partial = JSON.stringify({ verdict: "approve", summary: "Partial review" });
  const fake = installFakeGrok({ replies: [{ text: partial, stopReason: "cancelled" }] });
  initGitRepo(workspace);
  const invoke = (args) => spawnSync(process.execPath, [cli, "audit", ...args],
    { cwd: workspace, env: fake.env, encoding: "utf8", timeout: 15000 });
  const json = invoke(["--json"]);
  assert.equal(json.status, 1);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.result, null);
  assert.equal(payload.reviewText, partial);
  assert.match(payload.parseError, /findings/i);
  const text = invoke([]);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /Review incomplete/);
  assert.ok(text.stdout.includes(partial));
  for (const invalid of [
    { verdict: "approve", summary: "Reviewed", findings: [], next_steps: [], extra: true },
    { verdict: "approve", summary: "Reviewed", findings: "invalid", next_steps: [] }
  ]) {
    const raw = JSON.stringify(invalid);
    fs.writeFileSync(fake.env.FAKE_GROK_SCENARIO, JSON.stringify({ replies: [{ text: raw }] }));
    const result = invoke(["--json"]);
    assert.equal(result.status, 1);
    const invalidPayload = JSON.parse(result.stdout);
    assert.equal(invalidPayload.result, null);
    assert.equal(invalidPayload.reviewText, raw);
    assert.ok(invalidPayload.parseError);
  }
  fs.writeFileSync(fake.env.FAKE_GROK_SCENARIO, JSON.stringify({ replies: [{ text: output, stopReason: "cancelled" }] }));
  const incomplete = invoke(["--json"]);
  assert.equal(incomplete.status, 1);
  const incompletePayload = JSON.parse(incomplete.stdout);
  assert.equal(incompletePayload.result.verdict, "incomplete");
  assert.equal(incompletePayload.reviewText, output);
});
