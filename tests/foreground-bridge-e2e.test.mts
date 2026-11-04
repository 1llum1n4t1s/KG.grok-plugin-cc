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

test("foreground review ignores old state, enforces read-only permission, and closes its agent", { skip: process.platform === "win32" }, () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-foreground-work-"));
  const fake = installFakeGrok({ replies: [{ text: output }] });
  try {
    initGitRepo(workspace);
    const env = { ...fake.env, CLAUDE_PLUGIN_DATA: path.join(workspace, "old-state"), PLUGIN_DATA: path.join(workspace, "old-state") };
    fs.mkdirSync(env.PLUGIN_DATA);
    fs.writeFileSync(path.join(env.PLUGIN_DATA, "state.json"), "invalid legacy state");
    const invoke = args => spawnSync(process.execPath, [cli, ...args], { cwd: workspace, env, encoding: "utf8", timeout: 15000 });
    const review = invoke(["audit", "--json"]);
    assert.equal(review.status, 0, review.stderr);
    assert.equal(JSON.parse(review.stdout).result.summary, "Reviewed");
    assert.equal(fs.readFileSync(path.join(env.PLUGIN_DATA, "state.json"), "utf8"), "invalid legacy state");
    assert.deepEqual(fs.readdirSync(env.PLUGIN_DATA), ["state.json"]);
    const agent = fake.readState();
    assert.equal(agent.sessions, 1);
    assert.throws(() => process.kill(agent.pid, 0), { code: "ESRCH" });
    fs.writeFileSync(env.FAKE_GROK_SCENARIO, JSON.stringify({ replies: [{ requestClientFileWrite: { path: path.join(workspace, "forbidden"), content: "no" }, text: output }] }));
    const denied = invoke(["audit", "--json"]);
    assert.equal(denied.status, 1, denied.stderr);
    const denial = JSON.parse(denied.stdout);
    assert.equal(denial.result.verdict, "incomplete");
    assert.ok(denial.permissionDenials.length);
    assert.equal(fs.existsSync(path.join(workspace, "forbidden")), false);
    assert.throws(() => process.kill(fake.readState().pid, 0), { code: "ESRCH" });
    fs.writeFileSync(env.FAKE_GROK_SCENARIO, JSON.stringify({ replies: [{ requestPermissionFor: { title: "unknown external tool", kind: "other" }, onDenied: { text: output } }] }));
    const unknown = invoke(["audit", "--json"]);
    assert.equal(unknown.status, 1, unknown.stderr);
    assert.ok(JSON.parse(unknown.stdout).permissionDenials.length);
    fs.writeFileSync(env.FAKE_GROK_SCENARIO, JSON.stringify({ replies: [{ text: "task answer" }] }));
    const task = invoke(["task", "--json", "inspect"]);
    assert.equal(task.status, 0, task.stderr);
    assert.equal(JSON.parse(task.stdout).finalMessage, "task answer");
    const acpUrl = new URL("../plugins/grok/scripts/lib/acp.mjs", import.meta.url).href;
    const injection = `import { GrokAcpClient } from ${JSON.stringify(acpUrl)};
const original = GrokAcpClient.connectForeground;
GrokAcpClient.connectForeground = async (...args) => {
  const client = await original.call(GrokAcpClient, ...args);
  const close = client.close.bind(client);
  client.close = async () => { await close(); client.closeStopUnconfirmed = true; };
  return client;
};`;
    const injectedEnv = { ...env, NODE_OPTIONS: `--import=${`data:text/javascript,${encodeURIComponent(injection)}`}` };
    const invokeUnconfirmed = args => spawnSync(process.execPath, [cli, ...args], { cwd: workspace, env: injectedEnv, encoding: "utf8", timeout: 15000 });
    fs.writeFileSync(env.FAKE_GROK_SCENARIO, JSON.stringify({ replies: [{ text: output }] }));
    const unconfirmedReview = invokeUnconfirmed(["audit", "--json"]);
    assert.equal(unconfirmedReview.status, 1, unconfirmedReview.stderr);
    assert.equal(JSON.parse(unconfirmedReview.stdout).turnStopUnconfirmed, true);
    assert.equal(JSON.parse(unconfirmedReview.stdout).result.verdict, "incomplete");
    const unconfirmedTask = invokeUnconfirmed(["task", "--json", "inspect"]);
    assert.equal(unconfirmedTask.status, 1, unconfirmedTask.stderr);
    assert.equal(JSON.parse(unconfirmedTask.stdout).turnStopUnconfirmed, true);
    const unconfirmedSetup = invokeUnconfirmed(["setup", "--json"]);
    assert.equal(unconfirmedSetup.status, 1, unconfirmedSetup.stderr);
    assert.equal(JSON.parse(unconfirmedSetup.stdout).turnStopUnconfirmed, true);
    fs.writeFileSync(env.FAKE_GROK_SCENARIO, JSON.stringify({ replies: [{ rpcError: "fixture failure" }] }));
    const failed = invoke(["audit", "--json"]);
    assert.equal(failed.status, 1);
    assert.deepEqual(JSON.parse(failed.stdout).error, { message: "fixture failure", rpcCode: -32000, data: null });
    const failureInjection = `import { GrokAcpClient } from ${JSON.stringify(acpUrl)};
const original = GrokAcpClient.connectForeground;
GrokAcpClient.connectForeground = async (...args) => {
  const client = await original.call(GrokAcpClient, ...args);
  const request = client.request.bind(client);
  client.request = async (...requestArgs) => {
    try { return await request(...requestArgs); }
    catch (error) { if (requestArgs[0] === "session/prompt") error.data.data = JSON.parse(process.env.TEST_RPC_DATA); throw error; }
  };
  return client;
};`;
    const failureEnv = { ...env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(failureInjection)}`,
      TEST_RPC_DATA: JSON.stringify({ message: "API error (status 402 Payment Required): Grok Build usage balance exhausted", http_status: 402 }) };
    const invokeFailure = (args, envOverride = failureEnv) => spawnSync(process.execPath, [cli, ...args], { cwd: workspace, env: envOverride, encoding: "utf8", timeout: 15000 });
    for (const args of [["audit"], ["task", "inspect"]]) {
      const response = invokeFailure(args);
      assert.equal(response.status, 1);
      assert.match(response.stderr, /Grokの利用枠が不足しています（HTTP 402）/);
    }
    const exhausted = invokeFailure(["audit", "--json"]);
    const error = JSON.parse(exhausted.stdout).error;
    assert.equal(exhausted.status, 1);
    assert.equal(error.classification, "usage-balance-exhausted");
    assert.deepEqual(error.data, JSON.parse(failureEnv.TEST_RPC_DATA));
    for (const data of [{ message: "payment required", http_status: 402 }, { message: "usage balance exhausted", http_status: 429 }]) {
      const response = invokeFailure(["task", "inspect"], { ...failureEnv, TEST_RPC_DATA: JSON.stringify(data) });
      assert.equal(response.status, 1);
      assert.doesNotMatch(response.stderr, /Grokの利用枠が不足しています/);
    }
    const resume = invoke(["task", "--resume", "continue"]);
    assert.equal(resume.status, 1);
    assert.match(resume.stderr, /Grok.s own commands/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(fake.binDir, { recursive: true, force: true });
  }
});
