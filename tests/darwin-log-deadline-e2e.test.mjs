import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { migrateStateLock, resolveStateDir, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir } from "./helpers.mjs";

// 故障条件: mutex 内で Git が停止し、後続 state 操作の期限が尽きる。
test("log path verification releases the mutex without a Git lookup", { skip: process.platform !== "darwin", timeout: 45000 }, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  t.after(() => { for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  process.env.CLAUDE_PLUGIN_DATA = fs.realpathSync(makeTempDir("grok-log-deadline-state-"));
  delete process.env.PLUGIN_DATA;
  const workspace = fs.realpathSync(makeTempDir("grok-log-deadline-workspace-"));
  const stateDir = resolveStateDir(workspace);
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const fakeBin = path.join(workspace, "fake-bin"), gitMarker = path.join(workspace, "git-invoked"), ready = path.join(workspace, "ready");
  fs.mkdirSync(fakeBin, { mode: 0o700 });
  fs.writeFileSync(path.join(fakeBin, "git"), '#!/bin/sh\nprintf invoked > "$GROK_TEST_GIT_MARKER"\nexec /bin/sleep 8\n', { mode: 0o700 });
  const worker = fork(new URL("./fixtures/darwin-log-deadline-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const closed = new Promise(resolve => worker.once("close", resolve));
  let answer = null;
  worker.on("message", message => { answer = message; });
  t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); await closed; });
  worker.send({ workspace, fakeBin, ready, gitMarker });
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(ready) && Date.now() < deadline && worker.exitCode === null) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(ready), `worker did not acquire mutex: ${JSON.stringify(answer)}`);
  let contenderError;
  try { withStateSnapshot(workspace, () => {}, { timeoutMs: 2500 }); }
  catch (error) { contenderError = error; }
  await closed;
  assert.ifError(contenderError);
  assert.equal(answer?.type, "done", JSON.stringify(answer));
  assert.equal(fs.existsSync(gitMarker), false, "log path verification must not invoke Git");
});
