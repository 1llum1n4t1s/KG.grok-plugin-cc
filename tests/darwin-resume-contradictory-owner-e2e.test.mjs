import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fixture } from "./cancel-repair-fixture.mjs";
import { initGitRepo } from "./helpers.mjs";
import { loadState, migrateStateLock, readJobFile, resolveJobFile, resolveStateDir, updateState, writeJobFile } from "../plugins/grok/scripts/lib/state.mjs";

const companion = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));

test("Darwin resume rejects matching broker terminal records with an unconfirmed direct owner", { skip: process.platform !== "darwin", timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  initGitRepo(f.cwd);
  const env = { ...f.env, GROK_COMPANION_SESSION_ID: "contradictory-owner-host", CODEX_THREAD_ID: "" };
  const stateDir = resolveStateDir(f.cwd);
  migrateStateLock(f.cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const cli = (args) => spawnSync(process.execPath, [companion, ...args], {
    cwd: f.cwd, env, encoding: "utf8", timeout: 20000
  });
  fs.writeFileSync(env.CANCEL_REVIEW_GATE, "release");
  const first = cli(["task", "--json", "establish the conversation"]);
  assert.equal(first.status, 0, first.stderr);
  const source = JSON.parse(first.stdout);
  const generation = f.brokerIdentity.brokerGeneration;
  const records = (id) => [loadState(f.cwd).jobs.find(job => job.id === id), readJobFile(resolveJobFile(f.cwd, id))];
  const sourceRecords = records(source.jobId);
  for (const record of sourceRecords) {
    assert.equal(record.id, source.jobId);
    assert.equal(record.status, "completed");
    assert.equal(record.grokSessionId, source.grokSessionId);
    assert.equal(record.grokTransport, "broker");
    assert.equal(record.grokBrokerGeneration, generation);
    assert.equal(record.grokPromptState, "terminal");
    assert.equal(record.terminationPending, false);
    assert.equal(record.taskSessionResumable, true);
  }
  const control = await f.connect();
  const proof = await control.request("broker/cancelTurn", { sessionId: source.grokSessionId,
    executionId: source.jobId, generation });
  assert.equal(proof.generation, generation);
  assert.equal(proof.executionState, "terminal");
  assert.equal(proof.notificationSent, false);

  // 別 job の二重記録は一致させ、broker 終了と direct owner 未停止を矛盾させる。
  const otherId = randomUUID();
  const directGeneration = randomUUID();
  updateState(f.cwd, (state, context) => {
    const sourceRecord = state.jobs.find(job => job.id === source.jobId);
    const other = { ...sourceRecord, id: otherId, createdAt: "2020-01-01T00:00:00.000Z",
      taskSessionResumable: false, grokDirectGeneration: directGeneration,
      grokDirectOwnerPid: process.pid, grokDirectOwnerStartKey: "fixture-unconfirmed-owner",
      grokDirectStopGeneration: null, grokDirectStopKind: null, grokDirectStopConfirmedAt: null };
    writeJobFile(f.cwd, otherId, other, context);
    state.jobs.push(other);
  });
  const otherRecords = records(otherId);
  assert.deepEqual(otherRecords[0], otherRecords[1]);
  for (const record of otherRecords) {
    assert.equal(record.sessionId, sourceRecords[0].sessionId);
    assert.equal(record.grokSessionId, source.grokSessionId);
    assert.equal(record.grokTransport, "broker");
    assert.equal(record.grokBrokerGeneration, generation);
    assert.equal(record.status, "completed");
    assert.equal(record.grokPromptState, "terminal");
    assert.equal(record.terminationPending, false);
    assert.equal(record.taskSessionResumable, false);
    assert.equal(record.grokDirectGeneration, directGeneration);
    assert.equal(record.grokDirectOwnerPid, process.pid);
    assert.equal(record.grokDirectOwnerStartKey, "fixture-unconfirmed-owner");
    assert.equal(record.grokDirectStopGeneration, null);
    assert.equal(record.grokDirectStopKind, null);
    assert.equal(record.grokDirectStopConfirmedAt, null);
  }
  const effects = () => f.logs().filter(row => row.loadedSession || row.prompt);
  const before = effects();
  const resumed = cli(["task", "--resume-last", "--json", "continue the conversation"]);
  assert.equal(resumed.status, 1, resumed.stderr);
  assert.match(resumed.stderr, /unverified|pending|inconsistent/i);
  assert.ok(resumed.stderr.includes(otherId), resumed.stderr);
  assert.deepEqual(effects(), before, "rejected resume must not load a session or send a prompt");
  assert.deepEqual(records(source.jobId), sourceRecords);
  assert.deepEqual(records(otherId), otherRecords);
});
