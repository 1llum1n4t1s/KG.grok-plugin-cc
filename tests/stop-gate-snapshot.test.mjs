import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { buildWorkingTreeSnapshotDiff } from "../plugins/grok/scripts/lib/git.mjs";

const source = fs.readFileSync(new URL("../plugins/grok/scripts/stop-review-gate-hook.mjs", import.meta.url), "utf8");

// Git・外部プロセス・ファイル書込みを行わず、hook のイベント経路を検証する。
function hookHarness(options = {}) {
  let session = options.session ?? null;
  let input;
  let now = 0;
  const snapshotOptions = [];
  const cryptoTimeouts = [];
  const stateTimeouts = [];
  let stateUpdates = 0;
  function makeSnapshot(edited) {
    if (!options.realDiff) return { fingerprint: edited ? "after" : "before", files: [] };
    return { version: 1, fingerprint: (edited ? "b" : "a").repeat(64), indexFingerprint: "c".repeat(64), head: "d".repeat(40), files: [
      { path: "app.js", mode: "100644", content: Buffer.from(edited ? "current-turn\n" : "baseline-turn\n").toString("base64") },
      { path: "preexisting.js", mode: "100644", content: Buffer.from("older-turn-edit\n").toString("base64") }
    ] };
  }
  let snapshot = makeSnapshot(false);
  const decisions = [];
  const reviews = [];
  let nonce = 0;
  const context = {
    Buffer, deflateRawSync, inflateRawSync,
    performance: { now: () => now },
    withWorkspaceDeadline: (_deadline, run) => run(),
    STOP_REVIEW_MAX_SNAPSHOT_BYTES: 16 * 1024 * 1024,
    STOP_REVIEW_MAX_COMPRESSED_SNAPSHOT_BYTES: 1024 * 1024,
    STOP_REVIEW_MAX_TOTAL_CIPHERTEXT_BYTES: 8 * 1024 * 1024,
    FALLBACK_TURN_KEY: "session-turn",
    randomUUID: () => `nonce-${++nonce}`,
    readHookInput: () => input, process: { platform: options.platform ?? "win32", env: { SystemRoot: "C:\\Windows" }, cwd: () => "workspace" },
    path: { join: (...parts) => parts.join("/") },
    fs: { realpathSync: { native: (root) => root } },
    spawnSync: (_executable, args, settings) => {
      cryptoTimeouts.push(settings.timeout);
      now += options.cryptoDelay ?? 0;
      if (options.cryptoError) return { status: 1, stdout: "", stderr: "sensitive error" };
      const unprotect = args.some((arg) => String(arg).includes("Unprotect"));
      if (!unprotect && options.newTurnDuringCapture) session = { turnKey: "new-turn", baselineNonce: "new-turn", baselineSnapshot: "new-baseline" };
      if (unprotect && options.decryptError) return { status: 1 };
      return { status: 0, stdout: unprotect ? Buffer.from(settings.input, "base64").toString("utf8") : Buffer.from(settings.input).toString("base64"), stderr: "" };
    },
    resolveWorkspaceRoot: () => "workspace", getConfig: () => ({ stopReviewGate: true }),
    resolveSessionIdWithFallback: () => "session", listJobs: () => [],
    sortJobsNewestFirst: (jobs) => jobs, filterJobsForCurrentSession: (jobs) => jobs,
    isActiveJob: () => false, getReviewGateSession: () => session,
    setReviewGateSession: (_root, _id, value) => { session = { ...session, ...value }; },
    updateState: (_root, mutate, stateOptions) => {
      stateTimeouts.push(stateOptions?.timeoutMs);
      stateUpdates += 1;
      if (options.stateUpdateErrorOn === stateUpdates) throw new Error("sensitive state update failure");
      const state = { reviewGateSessions: session ? [{ sessionId: "session", ...session }] : [], jobs: [{ id: "unrelated" }] };
      mutate(state, { epoch: "current-epoch" });
      assert.deepEqual(state.jobs, [{ id: "unrelated" }]);
      session = state.reviewGateSessions[0] ?? null;
    },
    withStateSnapshot: (_root, read) => {
      if (options.stateSnapshotError) throw new Error("sensitive state snapshot failure");
      return read({ reviewGateSessions: session ? [{ sessionId: "session", ...session }] : [] }, { epoch: "current-epoch" });
    },
    clearReviewGateSession: () => { session = null; }, logNote: () => {},
    collectWorkingTreeSnapshot: (_root, snapshotOption) => {
      snapshotOptions.push(snapshotOption);
      now += options.snapshotDelay ?? 0;
      if (options.collectError) throw new Error("snapshot unavailable");
      return snapshot;
    },
    getWorkingTreeFingerprint: () => snapshot.fingerprint,
    buildWorkingTreeSnapshotDiff: options.realDiff ? buildWorkingTreeSnapshotDiff : (before, after) => ({ complete: true, fingerprint: after.fingerprint, context: `old=${before.fingerprint};new=${after.fingerprint}` }),
    buildSetupNote: () => options.setupNote ?? null,
    runStopReview: (_root, _input, _pending, evidence) => {
      reviews.push(evidence);
      if (options.changeDuringReview) snapshot = { fingerprint: "raced", files: [] };
      if (options.newTurnDuringReview) session = { turnKey: "new-turn", baselineNonce: "new-turn", baselineSnapshot: "new-baseline" };
      return options.blockReview ? { ok: false, reason: "saved blocker", retryWithoutChanges: Boolean(options.retryWithoutChanges) } : { ok: true };
    },
    emitDecision: (decision) => decisions.push(decision)
  };
  const body = source.slice(source.indexOf("function getTurnKey("), source.indexOf("\ntry {\n  main();"));
  const main = vm.runInNewContext(`${body}; main`, context);
  return {
    snapshotOptions, cryptoTimeouts, stateTimeouts,
    event(name) { input = { hook_event_name: name, turn_id: "turn", session_id: "session" }; main(); },
    edit() { snapshot = makeSnapshot(true); },
    editAgain() { snapshot = { ...makeSnapshot(true), fingerprint: "changed-again" }; },
    decisions, reviews, session: () => session,
    mutateSession(change) { session = { ...session, ...change }; }
  };
}

// 先行失敗条件: 10秒超の正常な取得、時間切れ後の暗号化・保存、期限なしの lock 待機。
test("UserPromptSubmit saves a slow baseline within one bounded hook budget", () => {
  const hook = hookHarness({ snapshotDelay: 12000, cryptoDelay: 1000 });
  hook.event("UserPromptSubmit");
  assert.ok(hook.session()?.baselineSnapshot);
  assert.ok(hook.snapshotOptions[0].deadline > 12000 && hook.snapshotOptions[0].deadline < 60000);
  assert.ok(hook.cryptoTimeouts[0] > 0 && hook.cryptoTimeouts[0] <= 10000);
  assert.ok(hook.stateTimeouts.every(value => Number.isFinite(value) && value > 0 && value < 60000));
});

test("UserPromptSubmit does not encrypt or save a baseline after its deadline", () => {
  const hook = hookHarness({ snapshotDelay: 60000 });
  hook.event("UserPromptSubmit");
  assert.equal(hook.session()?.baselineSnapshot, null);
  assert.equal(hook.cryptoTimeouts.length, 0);
  assert.equal(hook.stateTimeouts.length, 1);
});

// 先行失敗条件: 状態読取・保存エラーの例外で Stop が未完了を出さず通過する。
test("stop gate blocks when the Linux state snapshot fails", () => {
  const hook = hookHarness({ platform: "linux", stateSnapshotError: true });
  hook.event("Stop");
  assert.equal(hook.decisions[0]?.decision, "block");
  assert.match(hook.decisions[0]?.reason ?? "", /incomplete/i);
  assert.doesNotMatch(hook.decisions[0]?.reason ?? "", /sensitive/);
});

test("stop gate blocks when saving the stop decision fails", () => {
  const hook = hookHarness({ stateUpdateErrorOn: 3 });
  hook.event("UserPromptSubmit"); hook.event("Stop");
  assert.equal(hook.decisions[0]?.decision, "block");
  assert.match(hook.decisions[0]?.reason ?? "", /incomplete/i);
  assert.doesNotMatch(hook.decisions[0]?.reason ?? "", /sensitive/);
});

test("stop gate refuses a fingerprint-only baseline instead of asking for an ungrounded ALLOW", () => {
  const hook = hookHarness({ session: { turnKey: "turn", baselineFingerprint: "before" } });
  hook.edit(); hook.event("Stop");
  assert.equal(hook.reviews.length, 0);
  assert.match(hook.decisions[0]?.reason ?? "", /incomplete/i);
});

test("stop gate gives the reviewer exact baseline/current evidence", () => {
  const hook = hookHarness({ realDiff: true });
  hook.event("UserPromptSubmit"); hook.edit(); hook.event("Stop");
  assert.equal(hook.reviews.length, 1);
  assert.match(hook.reviews[0], /-baseline-turn/);
  assert.match(hook.reviews[0], /\+current-turn/);
  assert.doesNotMatch(hook.reviews[0], /preexisting\.js|older-turn-edit/);
  assert.equal(hook.decisions.length, 0);
});

test("stop gate rejects ALLOW when the repository changed during review", () => {
  const hook = hookHarness({ changeDuringReview: true });
  hook.event("UserPromptSubmit"); hook.edit(); hook.event("Stop");
  assert.match(hook.decisions[0]?.reason ?? "", /incomplete|changed/i);
  assert.ok(hook.session());
});

test("stop gate fails closed on incomplete snapshot and unavailable Grok", () => {
  for (const options of [{ collectError: true }, { setupNote: "Grok unavailable" }]) {
    const hook = hookHarness(options);
    hook.event("UserPromptSubmit"); hook.edit(); hook.event("Stop");
    assert.equal(hook.reviews.length, 0);
    assert.match(hook.decisions[0]?.reason ?? "", /incomplete/i);
  }
});

test("stop gate skips an unchanged turn using the same captured snapshot", () => {
  const hook = hookHarness();
  hook.event("UserPromptSubmit"); hook.event("Stop");
  assert.equal(hook.reviews.length, 0);
  assert.equal(hook.decisions.length, 0);
});

test("stop gate refuses another turn's baseline", () => {
  const hook = hookHarness({ session: { turnKey: "old-turn", baselineFingerprint: "before" } });
  hook.edit(); hook.event("Stop");
  assert.equal(hook.reviews.length, 0);
  assert.match(hook.decisions[0]?.reason ?? "", /incomplete/i);
});

test("baseline collection failure invalidates a previous turn's evidence", () => {
  const hook = hookHarness({ collectError: true, session: { turnKey: "old-turn", baselineFingerprint: "stale", baselineSnapshot: "stale" } });
  hook.event("UserPromptSubmit");
  assert.equal(hook.session()?.baselineSnapshot, null);
  hook.event("Stop");
  assert.equal(hook.reviews.length, 0);
  assert.match(hook.decisions[0]?.reason ?? "", /incomplete/i);
});

test("baseline protection failure cannot reuse stale plaintext evidence", () => {
  const hook = hookHarness({ cryptoError: true });
  hook.event("UserPromptSubmit"); hook.edit(); hook.event("Stop");
  assert.equal(hook.reviews.length, 0);
  assert.match(hook.decisions[0]?.reason ?? "", /incomplete/i);
  assert.doesNotMatch(hook.decisions[0]?.reason ?? "", /sensitive error/);
});

test("unsupported platform and failed decryption remain incomplete", () => {
  for (const options of [{ platform: "linux" }, { decryptError: true }]) {
    const hook = hookHarness(options);
    hook.event("UserPromptSubmit"); hook.edit(); hook.event("Stop");
    assert.equal(hook.reviews.length, 0);
    assert.match(hook.decisions[0]?.reason ?? "", /incomplete/i);
  }
});

test("protected baseline cannot be moved into a different turn", () => {
  const hook = hookHarness();
  hook.event("UserPromptSubmit");
  hook.mutateSession({ turnKey: "other-turn" });
  hook.edit(); hook.event("Stop");
  assert.equal(hook.reviews.length, 0);
  assert.match(hook.decisions[0]?.reason ?? "", /incomplete/i);
});

test("review completion does not erase a new turn's baseline or unrelated jobs", () => {
  for (const blockReview of [false, true]) {
    const hook = hookHarness({ newTurnDuringReview: true, blockReview });
    hook.event("UserPromptSubmit"); hook.edit(); hook.event("Stop");
    assert.equal(hook.session()?.baselineSnapshot, "new-baseline");
    assert.match(hook.decisions[0]?.reason ?? "", /incomplete/i);
  }
});

test("a repeated Stop after BLOCK reuses the review until the current content changes", () => {
  const hook = hookHarness({ blockReview: true });
  hook.event("UserPromptSubmit"); hook.edit(); hook.event("Stop"); hook.event("Stop");
  assert.equal(hook.reviews.length, 1);
  assert.equal(hook.decisions.at(-1)?.reason, "saved blocker");
  hook.editAgain(); hook.event("Stop");
  assert.equal(hook.reviews.length, 2);
});

test("a new user turn preserves the saved blocker but reviews subsequent edits", () => {
  const hook = hookHarness({ blockReview: true });
  hook.event("UserPromptSubmit"); hook.edit(); hook.event("Stop");
  hook.event("UserPromptSubmit"); hook.event("Stop");
  assert.equal(hook.reviews.length, 1);
  assert.equal(hook.decisions.at(-1)?.reason, "saved blocker");
  hook.editAgain(); hook.event("Stop");
  assert.equal(hook.reviews.length, 2);
});

test("an incomplete review can retry unchanged content", () => {
  const hook = hookHarness({ blockReview: true, retryWithoutChanges: true });
  hook.event("UserPromptSubmit"); hook.edit(); hook.event("Stop"); hook.event("Stop");
  assert.equal(hook.reviews.length, 2);
});

test("a baseline captured across a new turn cannot overwrite that turn or allow Stop", () => {
  const hook = hookHarness({ newTurnDuringCapture: true });
  hook.event("UserPromptSubmit"); hook.edit(); hook.event("Stop");
  assert.equal(hook.session()?.baselineSnapshot, "new-baseline");
  assert.equal(hook.reviews.length, 0);
  assert.match(hook.decisions[0]?.reason ?? "", /incomplete/i);
});
