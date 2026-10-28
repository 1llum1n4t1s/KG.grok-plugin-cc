import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { makeTempDir } from "./helpers.mjs";
import { startFixtureBroker } from "./broker-fixture-helper.mjs";
import { GrokAcpClient } from "../plugins/grok/scripts/lib/acp.mjs";
import { sendBrokerShutdown } from "../plugins/grok/scripts/lib/broker-lifecycle.mjs";

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
for (const variant of ["model", "effort", "model-fallback", "resume-model", "resume-effort"]) {
  test(`stale owner cannot send ${variant} settings or continue its turn`, { skip: !["linux", "darwin"].includes(process.platform), timeout: 60000 }, async t => {
    const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
    const root = fs.realpathSync(makeTempDir("grok-owner-settings-"));
    process.env.CLAUDE_PLUGIN_DATA = root;
    delete process.env.PLUGIN_DATA;
    const workspace = fs.realpathSync(makeTempDir("grok-owner-settings-workspace-"));
    const stateDir = resolveStateDir(workspace);
    const log = path.join(root, "agent-requests"), ready = path.join(root, "agent-ready"),
      release = path.join(root, "agent-release"), revoked = path.join(root, "owner-revoked"), exited = path.join(root, "agent-exit");
    let migrated = false, child, closed, broker, brokerClosed, brokerLog, endpoint;
    t.after(async () => {
      try {
        if (child) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await closed;
        }
        if (broker) {
          const waitClose = async ms => {
            let timer;
            try { return await Promise.race([brokerClosed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
            finally { if (timer) clearTimeout(timer); }
          };
          if (broker.exitCode === null && broker.signalCode === null) {
            try { await sendBrokerShutdown(endpoint, 1000); } catch { /* directly owned child is handled below */ }
          }
          if (!(await waitClose(3000)) && broker.exitCode === null && broker.signalCode === null) broker.kill("SIGTERM");
          if (!(await waitClose(3000)) && broker.exitCode === null && broker.signalCode === null) broker.kill("SIGKILL");
          await brokerClosed;
        }
        if (fs.existsSync(log)) {
          const deadline = Date.now() + 25000;
          while (!fs.existsSync(exited) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
          assert.ok(fs.existsSync(exited), "fake agent did not report exit; preserve the fixture");
        }
        if (migrated && process.platform === "linux") shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
    migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
    migrated = true;
    const agent = fileURLToPath(new URL("./fixtures/linux-settings-agent.mjs", import.meta.url));
    const wrapper = path.join(root, "fake-grok");
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(agent)} "$@"\n`, { mode: 0o700, flag: "wx" });
    const resuming = variant.startsWith("resume-");
    const env = { ...process.env, GROK_BIN: wrapper, XAI_API_KEY: "test-only", GROK_COMPANION_DISABLE_BROKER: resuming ? "0" : "1",
      SETTINGS_LOG: log, SETTINGS_READY: ready, SETTINGS_RELEASE: release, SETTINGS_EXIT: exited,
      SETTINGS_GATE: resuming ? "load" : variant === "model-fallback" ? "model" : "new" };
    if (resuming) {
      endpoint = `unix:${path.join(root, "broker.sock")}`;
      const startedBroker = await startFixtureBroker(workspace, env, endpoint, { onChild(value) {
        broker = value;
        brokerClosed = new Promise(resolve => value.once("close", resolve));
      } });
      brokerLog = startedBroker.session.logFile;
      env.GROK_COMPANION_ACP_ENDPOINT = endpoint;
      const client = await GrokAcpClient.connect(workspace, { brokerEndpoint: endpoint, env });
      try {
        assert.equal((await client.request("session/new", { cwd: workspace, mcpServers: [] })).sessionId, "s");
        const setup = await client.request("session/prompt", { sessionId: "s", executionId: "fixture-setup",
          prompt: [{ type: "text", text: "establish terminal history" }] });
        assert.equal(setup.stopReason, "end_turn");
      }
      finally { await client.close(); }
    }
    const baselineLog = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    child = fork(new URL("./fixtures/linux-settings-worker.mjs", import.meta.url), [], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    closed = new Promise(resolve => child.once("close", resolve));
    let stderr = "", earlyMessage = null;
    child.stderr.on("data", chunk => { stderr += chunk; });
    const response = new Promise(resolve => child.once("message", message => { earlyMessage = message; resolve(message); }));
    child.send({ workspace, variant, revoked });
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(ready) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const brokerDiagnostic = brokerLog && fs.existsSync(brokerLog) ? fs.readFileSync(brokerLog, "utf8").slice(-4000) : "";
    assert.ok(fs.existsSync(ready), `agent did not reach the expected setting boundary; worker=${JSON.stringify(earlyMessage)}; stderr=${stderr}; broker=${brokerDiagnostic}`);
    fs.writeFileSync(revoked, "revoked");
    fs.writeFileSync(release, "release");
    const result = await response;
    assert.equal(result.type, "rejected", JSON.stringify(result));
    assert.match(result.message, /owner changed/i);
    const allRequests = fs.readFileSync(log, "utf8");
    assert.ok(allRequests.startsWith(baselineLog));
    const methods = allRequests.slice(baselineLog.length).trim().split("\n");
    if (variant !== "model-fallback") assert.equal(methods.includes("session/set_model"), false);
    assert.equal(methods.includes("session/set_config_option"), false);
    assert.equal(methods.includes("session/prompt"), false);
  });
}
