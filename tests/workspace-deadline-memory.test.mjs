import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";

// 先行失敗条件: 無期限Git、失敗時probeによる予算更新、timeout/起動不能のcwd fallback、
// 実際の非repositoryのfallback消失、期限切れでの追加spawn、既存呼出しの互換性。
const gitSource = fs.readFileSync(new URL("../plugins/grok/scripts/lib/git.mjs", import.meta.url), "utf8");
const workspaceSource = fs.readFileSync(new URL("../plugins/grok/scripts/lib/workspace.mjs", import.meta.url), "utf8");
const stateSource = fs.readFileSync(new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url), "utf8");
function harness(results) {
  let now = 0;
  const calls = [];
  const context = vm.createContext({
    AsyncLocalStorage,
    process: { env: {} }, performance: { now: () => now },
    fs: { statSync: () => ({ isDirectory: () => true }) },
    formatCommandFailure: () => "git failed",
    runCommand(_command, args, options) {
      calls.push({ args, options });
      const next = results.shift() ?? { stdout: "git version 2.50.0", status: 0 };
      const delay = next.delay ?? 0;
      if (options.timeout !== undefined && delay > options.timeout) {
        now += options.timeout;
        return { error: Object.assign(new Error("expired"), { code: "ETIMEDOUT" }), stdout: "", stderr: "", status: null };
      }
      now += delay;
      return { stdout: "", stderr: "", status: 0, ...next };
    }
  });
  vm.runInContext(gitSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), context);
  vm.runInContext(workspaceSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), context);
  return { context, calls, elapsed: () => now };
}
test("workspace Git timeout is bounded and cannot choose a different state root", () => {
  const h = harness([{ delay: 1000, stdout: "/repo" }]);
  assert.throws(() => h.context.resolveWorkspaceRoot("/repo/sub", { deadline: 23 }), /expired|timeout|ETIMEDOUT/i);
  assert.equal(h.elapsed(), 23);
  assert.equal(h.calls[0].options.timeout, 23);
});
test("workspace lookup failure does not fallback when a deadline is supplied", () => {
  for (const result of [
    { error: Object.assign(new Error("missing Git"), { code: "ENOENT" }) },
    { status: 128, stderr: "fatal: permission denied" }
  ]) {
    const h = harness([result]);
    assert.throws(() => h.context.resolveWorkspaceRoot("/repo/sub", { deadline: 23 }), /Git|git/);
  }
});
test("a genuine nonrepository keeps cwd fallback and shares the capability probe budget", () => {
  const h = harness([{ delay: 13, status: 128, stderr: "fatal: not a git repository (or any parent)" }]);
  assert.equal(h.context.resolveWorkspaceRoot("/outside", { deadline: 23 }), "/outside");
  assert.equal(h.calls[1].options.timeout, 10);
});
test("capability probe timeout cannot turn into nonrepository fallback", () => {
  const h = harness([
    { delay: 13, status: 128, stderr: "fatal: not a git repository (or any parent)" },
    { delay: 1000, stdout: "git version 2.50.0" }
  ]);
  assert.throws(() => h.context.resolveWorkspaceRoot("/outside", { deadline: 23 }), /expired|timeout|ETIMEDOUT/i);
  assert.equal(h.elapsed(), 23);
});
test("expired or invalid deadlines never launch an external process", () => {
  for (const deadline of [0, -1, NaN, Infinity]) {
    const h = harness([]);
    assert.throws(() => h.context.resolveWorkspaceRoot("/repo", { deadline }), /deadline|timeout|expired/i);
    assert.equal(h.calls.length, 0);
  }
});
test("default fallback and successful workspace identities remain compatible", () => {
  const fallback = harness([{ error: new Error("unavailable") }]);
  assert.equal(fallback.context.resolveWorkspaceRoot("/repo/sub"), "/repo/sub");
  const root = harness([{ stdout: "/repo\n" }]);
  assert.equal(root.context.resolveWorkspaceRoot("/repo/sub", { deadline: 23 }), "/repo");
});

function stateHarness(results) {
  const h = harness(results);
  const files = new Map();
  const writes = [];
  const stateDir = path.posix.join("/plugin/state", `repo-${createHash("sha256").update("/repo").digest("hex").slice(0, 16)}`);
  const lockDir = path.posix.join(stateDir, "state.lock");
  files.set(lockDir, null);
  files.set(path.posix.join(lockDir, "protocol.json"), JSON.stringify({
    protocol: "native-local-v2", localOnly: true, hostId: "virtual-host", directoryIdentity: { dev: "1", ino: "2" }, volumeGuid: "\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\"
  }));
  Object.assign(h.context, {
    path: path.posix, createHash, randomUUID: () => "owner", SharedArrayBuffer, Int32Array, types,
    os: { tmpdir: () => "/tmp" }, Atomics: { wait() { assert.fail("unexpected contention"); } },
    isActiveJob: () => true,
    net: {
      createServer: () => ({
        listening: false, on() {}, unref() {},
        listen(options) { assert.equal(options.exclusive, true); this.listening = true; },
        close() { this.listening = false; }
      })
    },
    fs: {
      constants: fs.constants,
      realpathSync: { native: value => value },
      statSync: () => ({ isDirectory: () => true, dev: 1n, ino: 2n }),
      mkdirSync(value) { writes.push(value); files.set(value, null); }, chmodSync() {},
      existsSync: value => files.has(value),
      lstatSync(value) {
        if (!files.has(value)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { isSymbolicLink: () => false, isDirectory: () => files.get(value) === null, isFile: () => files.get(value) !== null };
      },
      readFileSync: value => files.get(value),
      writeFileSync(value, text, options) {
        if (options?.flag === "wx" && files.has(value)) throw Object.assign(new Error("busy"), { code: "EEXIST" });
        writes.push(value); files.set(value, text);
      },
      renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
      rmSync(value) { files.delete(value); }
    }
  });
  h.context.process.env.CLAUDE_PLUGIN_DATA = "/plugin";
  h.context.process.platform = "win32";
  vm.runInContext(stateSource.replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, "").replace(/^export /gm, ""), h.context);
  // 実PowerShellは使わず、移行時に確認済みの固定drive/hostをモデル化する。
  h.context.inspectNativeStateLockScope = value => {
    assert.equal(value, stateDir);
    return { hostId: "virtual-host", volumeGuid: "\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\" };
  };
  return { ...h, files, writes };
}
test("deadline state transactions preserve existing state/jobs and resolve Git only once", () => {
  const h = stateHarness(Array.from({ length: 3 }, () => ({ stdout: "/repo\n" })));
  const dir = h.context.resolveStateDir("/repo/sub");
  const stateFile = path.posix.join(dir, "state.json");
  const jobFile = path.posix.join(dir, "jobs", "running.json");
  h.files.set(stateFile, JSON.stringify({ jobs: [{ id: "running", status: "running" }], config: { stopReviewGate: true } }));
  h.files.set(jobFile, "existing job payload");
  h.context.updateState("/repo/sub", state => { state.config.stopReviewGate = false; }, { timeoutMs: 23 });
  assert.equal(h.calls.length, 2, "one baseline lookup and one transaction lookup");
  const snapshot = h.context.withStateSnapshot("/repo/sub", state => state, { timeoutMs: 23 });
  assert.equal(h.calls.length, 3);
  assert.equal(snapshot.config.stopReviewGate, false);
  assert.equal(snapshot.jobs[0].id, "running");
  assert.equal(h.files.get(jobFile), "existing job payload");
  assert.equal(JSON.parse(h.files.get(stateFile)).jobs[0].id, "running");
  assert.ok(h.writes.every(value => value === dir || value.startsWith(`${dir}/`)));
});
test("state deadline Git failure occurs before any filesystem mutation", () => {
  const h = stateHarness([{ stdout: "/repo\n", delay: 1000 }]);
  assert.throws(() => h.context.updateState("/repo/sub", () => assert.fail("entered"), { timeoutMs: 23 }), /Git|git/);
  assert.equal(h.elapsed(), 23);
  assert.deepEqual(h.writes, []);
});

test("workspace scope bounds implicit Git queries and preserves timeout failures", () => {
  const h = harness([{ stdout: "/repo", delay: 1000 }]);
  assert.equal(typeof h.context.withWorkspaceDeadline, "function");
  assert.throws(() => h.context.withWorkspaceDeadline(23,
    () => h.context.resolveWorkspaceRoot("/repo/sub")), /Git|git|expired|timeout/i);
  assert.equal(h.elapsed(), 23);
  assert.equal(h.calls[0].options.timeout, 23);
});
test("implicit scope preserves genuine nonrepository fallback and refuses expired Git launches", () => {
  const outside = harness([{ status: 128, stderr: "fatal: not a git repository (or any parent)" }]);
  assert.equal(outside.context.withWorkspaceDeadline(23, () => outside.context.resolveWorkspaceRoot("/outside")), "/outside");
  const expired = harness([]);
  assert.throws(() => expired.context.withWorkspaceDeadline(0, () => expired.context.resolveWorkspaceRoot("/repo")), /deadline/i);
  assert.equal(expired.calls.length, 0);
});
test("nested workspace deadlines and explicit options always select the earliest budget", () => {
  const h = harness(Array.from({ length: 5 }, () => ({ stdout: "/repo" })));
  h.context.withWorkspaceDeadline(23, () => {
    h.context.resolveWorkspaceRoot("/repo", { deadline: 100 });
    h.context.withWorkspaceDeadline(100, () => h.context.resolveWorkspaceRoot("/repo"));
    h.context.withWorkspaceDeadline(11, () => h.context.resolveWorkspaceRoot("/repo"));
    h.context.resolveWorkspaceRoot("/repo", { deadline: 7 });
    h.context.resolveWorkspaceRoot("/repo");
  });
  assert.deepEqual(h.calls.map(call => call.options.timeout), [23, 23, 11, 7, 23]);
});
test("async workspace scopes remain isolated and restore default fallback after completion", async () => {
  const h = harness([
    { stdout: "/repo" }, { stdout: "/repo" },
    { error: new Error("outside default failure") }
  ]);
  await Promise.all([23, 43].map(deadline => h.context.withWorkspaceDeadline(deadline, async () => {
    await Promise.resolve();
    return h.context.resolveWorkspaceRoot("/repo");
  })));
  assert.deepEqual(h.calls.map(call => call.options.timeout), [23, 43]);
  assert.equal(h.context.resolveWorkspaceRoot("/fallback"), "/fallback");
  const failure = new Error("scope callback failure");
  assert.throws(() => h.context.withWorkspaceDeadline(23, () => { throw failure; }), error => error === failure);
  assert.equal(h.context.resolveWorkspaceRoot("/outside", { deadline: undefined }), "git version 2.50.0");
  assert.equal(h.calls.at(-1).options.timeout, undefined);
});
test("invalid workspace scopes do not run callbacks or spawn Git", () => {
  for (const deadline of [NaN, Infinity, "23"]) {
    const h = harness([]);
    assert.equal(typeof h.context.withWorkspaceDeadline, "function");
    assert.throws(() => h.context.withWorkspaceDeadline(deadline, () => assert.fail("entered")), /deadline/i);
    assert.equal(h.calls.length, 0);
  }
});
test("workspace scope reaches callback job path lookups without changing state identity", () => {
  const h = stateHarness(Array.from({ length: 12 }, () => ({ stdout: "/repo" })));
  const dir = h.context.resolveStateDir("/repo/sub");
  h.context.withWorkspaceDeadline(23, () => h.context.updateState("/repo/sub", () => {
    const jobFile = h.context.resolveJobFile("/repo/sub", "job");
    h.context.writeJobFile("/repo/sub", "job", { id: "job" });
    assert.equal(jobFile, path.posix.join(dir, "jobs", "job.json"));
  }, { timeoutMs: 100 }));
  assert.ok(h.calls.length > 2);
  assert.ok(h.calls.slice(1).every(call => call.options.timeout === 23));
  assert.equal(JSON.parse(h.files.get(path.posix.join(dir, "jobs", "job.json"))).id, "job");
});
