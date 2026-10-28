import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFixtureBroker } from "../broker-fixture-helper.mjs";
import { sendBrokerShutdown } from "../../plugins/grok/scripts/lib/broker-lifecycle.mjs";
import { shutdownPosixStateLockSentinel } from "../../plugins/grok/scripts/lib/posix-state-lock.mjs";

const root = process.env.GROK_LINUX_SIM_ROOT, stateDir = process.env.GROK_LINUX_SIM_STATE_DIR;
const workspace = path.join(root, "workspace"), stateFile = path.join(stateDir, "state.json"), jobsDir = path.join(stateDir, "jobs");
const command = fileURLToPath(new URL("../../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const sweep = fileURLToPath(new URL("./linux-lease-sweep-cli.mjs", import.meta.url));
const directAgent = fileURLToPath(new URL("./linux-settings-agent.mjs", import.meta.url));
const brokerAgent = fileURLToPath(new URL("./linux-history-broker-agent.mjs", import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const directWrapper = path.join(root, "direct-grok"), brokerWrapper = path.join(root, "broker-grok");
for (const [wrapper, agent] of [[directWrapper, directAgent], [brokerWrapper, brokerAgent]]) {
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { flag: "wx", mode: 0o700 });
}
const endpoint = `unix:${path.join(root, "broker.sock")}`, release = path.join(root, "broker-release");
const ready = path.join(root, "broker-load-ready"), brokerExit = path.join(root, "broker-agent-exit");
const env = { ...process.env, XAI_API_KEY: "test-only", GROK_BIN: brokerWrapper, GROK_COMPANION_DISABLE_BROKER: "0",
  GROK_COMPANION_ACP_ENDPOINT: endpoint, SETTINGS_GATE: "load", SETTINGS_READY: ready, SETTINGS_RELEASE: release,
  SETTINGS_LOG: path.join(root, "broker-agent.log"), SETTINGS_EXIT: brokerExit };
const directEnv = { ...env, GROK_BIN: directWrapper, GROK_COMPANION_DISABLE_BROKER: "1", SETTINGS_GATE: "",
  SETTINGS_LOG: path.join(root, "direct-agent.log"), SETTINGS_READY: path.join(root, "direct-ready") };
let broker, brokerClosed, resume, resumeClosed, safeToStopSentinel = false, directStopped = true;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(condition, ms) {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await delay(20);
  return condition();
}
function runTask(i, hostSession, extra = {}) {
  const exited = path.join(root, `direct-exit-${i}`), spawned = path.join(root, `direct-spawn-${i}`);
  directStopped = false;
  const result = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", "--fresh", `fill ${i}`],
    { env: { ...directEnv, ...extra, SETTINGS_EXIT: exited, GROK_LINUX_SIM_SPAWN_MARKER: spawned,
      GROK_COMPANION_SESSION_ID: hostSession }, encoding: "utf8", timeout: 30000 });
  if (!fs.existsSync(spawned) || fs.existsSync(exited)) directStopped = true;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(exited), `direct agent ${i} exit must be observed`);
  return JSON.parse(result.stdout).jobId;
}
function reclaim() {
  const result = spawnSync(process.execPath, [sweep, workspace], { env, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
try {
  const started = await startFixtureBroker(workspace, env, endpoint, { onChild(child) {
    broker = child; brokerClosed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  } });
  env.GROK_COMPANION_BROKER_GENERATION = started.session.generation;
  const first = spawnSync(process.execPath, [command, "task", "--cwd", workspace, "--json", "--fresh", "establish broker history"],
    { env: { ...env, GROK_COMPANION_SESSION_ID: "resume-pin-session" }, encoding: "utf8", timeout: 30000 });
  assert.equal(first.status, 0, first.stderr);
  const pinnedId = JSON.parse(first.stdout).jobId;
  const fillers = [];
  for (let i = 0; i < 50; i++) fillers.push(runTask(i, "resume-filler-session"));
  assert.equal(reclaim().reclaimed, 51);
  const before = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const pinned = before.jobs.find(job => job.id === pinnedId);
  assert.equal(pinned?.grokTransport, "broker");
  assert.equal(pinned.grokBrokerGeneration, started.session.generation);
  assert.equal(pinned.workerStopProof, "linux-lease-released");
  const pinnedDetail = path.join(jobsDir, `${pinnedId}.json`), detailBytes = fs.readFileSync(pinnedDetail);
  resume = spawn(process.execPath, [command, "task", "--cwd", workspace, "--json", "--resume-last", "continue"],
    { env: { ...env, GROK_COMPANION_SESSION_ID: "resume-pin-session" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  resume.stdout.on("data", chunk => { stdout += chunk; }); resume.stderr.on("data", chunk => { stderr += chunk; });
  resumeClosed = new Promise(resolve => resume.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })));
  assert.ok(await waitUntil(() => fs.existsSync(ready) || resume.exitCode !== null, 20000), "resume did not reach session/load");
  assert.ok(fs.existsSync(ready), "broker agent must hold session/load");
  const replacementId = runTask("new-same-session", "resume-pin-session");
  assert.ok(replacementId && replacementId !== pinnedId);
  assert.equal(reclaim().reclaimed, 1);
  const stillPinned = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
  assert.ok(stillPinned.some(job => job.id === pinnedId), "the in-flight resume must pin its selected source job");
  const triggerId = runTask("trigger", "resume-filler-session");
  assert.ok(triggerId);
  const after = JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs;
  assert.ok(after.some(job => job.id === pinnedId), "pruning must not remove an in-flight resume source");
  assert.deepEqual(fs.readFileSync(pinnedDetail), detailBytes);
  assert.ok(!after.some(job => job.id === fillers[0]), "another old verified job must actually be pruned");
  fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
  const completed = await resumeClosed;
  assert.equal(completed.code, 0, `${completed.stderr}\n${completed.stdout}`);
  assert.match(fs.readFileSync(env.SETTINGS_LOG, "utf8"), /(?:^|\n)session\/load(?:\n|$)/);
  safeToStopSentinel = true;
} finally {
  if (resume && resume.exitCode === null && resume.signalCode === null) {
    if (!fs.existsSync(release)) fs.writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
    if (!await waitUntil(() => resume.exitCode !== null || resume.signalCode !== null, 8000)) resume.kill("SIGTERM");
    if (resumeClosed) await resumeClosed;
  }
  if (broker) {
    if (broker.exitCode === null && broker.signalCode === null) {
      try { await sendBrokerShutdown(endpoint, 5000); } catch { /* 確認できなければ fixture を保持する。 */ }
    }
    if (!await waitUntil(() => broker.exitCode !== null || broker.signalCode !== null, 8000)) broker.kill("SIGTERM");
    if (brokerClosed) await brokerClosed;
  }
  const agentStopped = !fs.existsSync(env.SETTINGS_LOG) || await waitUntil(() => fs.existsSync(brokerExit), 8000);
  if (safeToStopSentinel && directStopped && agentStopped) {
    shutdownPosixStateLockSentinel(stateDir, { offlineConfirmed: true, expectedStateDir: stateDir });
  } else process.stderr.write(`History resume fixture retained: ${root}\n`);
}
