import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("Stop gate: failed snapshot blocks explicitly without Grok, state mutation or repeated review", async () => {
  const hookPath = path.resolve("plugins/grok/scripts/stop-review-gate-hook.mjs");
  const original = fs.readFileSync(hookPath, "utf8");
  for (let attempt = 0; attempt < 2; attempt++) {
    const decisions = [];
    const notes = [];
    let spawned = 0;
    let mutations = 0;
    let collections = 0;
    const session = Object.freeze({ turnKey: "turn-a", baselineFingerprint: "old" });
    const key = `__stopGateSnapshotTest${attempt}`;
    globalThis[key] = {
      process: { env: {}, cwd: () => process.cwd(), stdout: { write: (text) => decisions.push(JSON.parse(text)) }, stderr: { write: (text) => notes.push(text) } },
      path, fileURLToPath: () => hookPath,
      spawnSync: () => { spawned++; throw new Error("Unexpected child process"); },
      getGrokAvailability: () => { spawned++; throw new Error("Unexpected Grok probe"); },
      collectWorkingTreeSnapshot: () => { collections++; throw new Error("sensitive snapshot failure detail"); },
      buildWorkingTreeSnapshotDiff: () => { throw new Error("Unexpected diff construction"); },
      READ_ONLY_GIT_GLOBAL_ARGS: [],
      getConfig: () => ({ stopReviewGate: true }),
      getReviewGateSession: () => session,
      clearReviewGateSession: () => { mutations++; }, setReviewGateSession: () => { mutations++; },
      updateState: () => { mutations++; throw new Error("Unexpected state mutation"); },
      listJobs: () => [], filterJobsForCurrentSession: () => [], sortJobsNewestFirst: (jobs) => jobs,
      isActiveJob: () => false, resolveSessionIdWithFallback: () => "session-a", SESSION_ID_ENV: "SESSION_ID",
      resolveWorkspaceRoot: (cwd) => cwd,
      readHookInput: () => ({ cwd: process.cwd(), hook_event_name: "Stop", turn_id: "turn-a" }),
      loadPromptTemplate: () => { throw new Error("Unexpected review prompt"); }, interpolateTemplate: () => ""
    };
    const names = Object.keys(globalThis[key]).join(", ");
    const source = original.replace(/^#![^\n]*\n/, "").replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, "");
    try {
      await import(`data:text/javascript;base64,${Buffer.from(`const { ${names} } = globalThis[${JSON.stringify(key)}];\n${source}`).toString("base64")}#${attempt}`);
      assert.equal(spawned, 0);
      assert.equal(mutations, 0);
      assert.equal(collections, 1);
      assert.deepEqual(session, { turnKey: "turn-a", baselineFingerprint: "old" });
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].decision, "block");
      assert.match(decisions[0].reason, /incomplete[\s\S]*snapshot/i);
      assert.ok(notes.some((note) => /could not snapshot/i.test(note)));
      assert.doesNotMatch([...notes, decisions[0].reason].join("\n"), /sensitive snapshot failure detail/);
    } finally { delete globalThis[key]; }
  }
});
