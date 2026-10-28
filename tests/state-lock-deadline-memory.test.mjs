import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { types } from "node:util";

// 先行失敗条件: legacy/native競合、無効予算、照会での予算消費、取得後の例外、
// 解放漏れ、既存callerの待機変更。実ファイルの作成・削除は行わない。
const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url), "utf8");
function harness({ native = false, busy = false, scopeDelay = 0, readFailure = false, readDelay = 0, bindDelay = 0 } = {}) {
  let now = 0, owner, calls = 0, closes = 0, inspections = [];
  const absent = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const context = vm.createContext({
    fs: {
      constants: fs.constants,
      existsSync: () => true,
      realpathSync: { native: value => value },
      statSync: () => ({ isDirectory: () => true, dev: 1n, ino: 2n }),
      lstatSync() { if (!native && !busy && !owner) throw absent(); return { isSymbolicLink: () => false, isDirectory: () => native }; },
      writeFileSync(_file, text) { if (busy || owner) throw Object.assign(new Error("busy"), { code: "EEXIST" }); owner = text; },
      readFileSync() { return owner; }, rmSync() { owner = undefined; }
    },
    path, os: { tmpdir: () => "/tmp" }, process: { pid: 1, platform: "win32", env: {} },
    randomUUID: () => "owner", SharedArrayBuffer, Int32Array, Buffer, types,
    performance: { now: () => now }, Atomics: { wait(_a, _b, _c, ms) { now += ms; } },
    net: { createServer() { return {
      listening: false, on() {}, unref() {},
      listen() { calls++; now += bindDelay; this.listening = !busy; }, close() { closes++; }
    }; } },
    execFileSync(_file, _args, options) { inspections.push(options.timeout); now += scopeDelay; return JSON.stringify({ machineGuid: "11111111-1111-1111-1111-111111111111", driveType: 3, fileSystem: "NTFS", volumeGuid: "\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\", directoryIdentity: { dev: "1", ino: "2" } }); },
    createHash() { return { update() { return this; }, digest() { return "host"; } }; },
    resolveWorkspaceRoot: x => x, isActiveJob: () => false
  });
  vm.runInContext(source.replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, "").replace(/^export /gm, ""), context);
  context.read = () => { now += readDelay; if (readFailure) throw new Error("read failure"); return { jobs: [] }; };
  vm.runInContext(`resolveStateDir = () => "C:\\\\state"; ensureStateDir = () => {};
    canonicalStateLockPath = value => value; resolveNativeStateLockEndpoint = () => "endpoint";
    readStateLockProtocol = () => {}; loadState = read; saveStateWithPreviousJobs = (_cwd, state) => state;`, context);
  return { context, elapsed: () => now, advance: ms => { now += ms; }, owner: () => owner, calls: () => calls, closes: () => closes, inspections };
}
for (const native of [true]) {
  for (const api of ["updateState", "withStateSnapshot"]) {
    test(`${api}: ${native ? "native" : "legacy"} contention obeys explicit budget`, () => {
      const h = harness({ native, busy: true });
      assert.throws(() => h.context[api]("workspace", () => assert.fail("entered"), { timeoutMs: 23 }), /lock/i);
      assert.ok(h.elapsed() <= 23, `elapsed ${h.elapsed()}ms`);
    });
    test(`${api}: invalid budgets fail before locking (${native})`, () => {
      for (const timeoutMs of [-1, NaN, Infinity, "10"]) {
        const h = harness({ native });
        assert.throws(() => h.context[api]("workspace", () => {}, { timeoutMs }), /timeout/i);
        assert.equal(h.calls(), 0); assert.equal(h.owner(), undefined);
      }
    });
    test(`${api}: acquisition and callback failures release locks (${native})`, () => {
      for (const readFailure of [false, true]) {
        const h = harness({ native, readFailure });
        assert.throws(() => h.context[api]("workspace", () => { throw new Error("callback failure"); }, { timeoutMs: 50 }), /failure/);
        assert.equal(h.owner(), undefined);
        if (native) assert.equal(h.closes(), 1);
      }
    });
    test(`${api}: slow state reads cannot enter callback after deadline (${native})`, () => {
      const h = harness({ native, readDelay: 24 });
      assert.throws(() => h.context[api]("workspace", () => assert.fail("expired callback"), { timeoutMs: 23 }), /lock/i);
      assert.equal(h.owner(), undefined);
      if (native) assert.equal(h.closes(), 1);
    });
  }
}
test("unmigrated state refuses immediately for default, positive and zero budgets", () => {
  for (const busy of [false, true]) for (const timeoutMs of [undefined, 23, 0]) {
    const h = harness({ busy });
    for (const api of ["updateState", "withStateSnapshot"]) {
      assert.throws(() => h.context[api]("workspace", () => assert.fail("unmigrated callback"), { timeoutMs }), /migration/i);
    }
    assert.equal(h.elapsed(), 0);
    assert.equal(h.calls(), 0);
    assert.equal(h.owner(), undefined);
  }
});
test("native host inspection consumes remaining budget and never uses timeout zero", () => {
  const h = harness({ native: true, scopeDelay: 23 });
  assert.throws(() => h.context.withStateSnapshot("workspace", () => assert.fail("expired callback"), { timeoutMs: 23 }), /lock/i);
  assert.deepEqual(h.inspections, [23]); assert.equal(h.calls(), 0);
  const zero = harness({ native: true });
  assert.throws(() => zero.context.withStateSnapshot("workspace", () => {}, { timeoutMs: 0 }), /lock/i);
  assert.deepEqual(zero.inspections, []);
  const fractional = harness({ native: true });
  fractional.context.withStateSnapshot("workspace", () => {}, { timeoutMs: 0.2 });
  assert.deepEqual(fractional.inspections, [1]);
});
test("native bind finishing after deadline releases lock without entering callback", () => {
  const h = harness({ native: true, bindDelay: 24 });
  assert.throws(() => h.context.withStateSnapshot("workspace", () => assert.fail("expired callback"), { timeoutMs: 23 }), /lock/i);
  assert.equal(h.closes(), 1);
});
test("native contention retains default wait and shares explicit budget with inspection", () => {
  const defaultBudget = harness({ native: true, busy: true });
  assert.throws(() => defaultBudget.context.withStateSnapshot("workspace", () => {}), /lock/i);
  assert.equal(defaultBudget.elapsed(), 7500);
  const shared = harness({ native: true, busy: true, scopeDelay: 13 });
  assert.throws(() => shared.context.withStateSnapshot("workspace", () => {}, { timeoutMs: 23 }), /lock/i);
  assert.equal(shared.elapsed(), 23);
});

test("public migration guard rejects exhausted budgets without native lookup and bounds positive lookup", () => {
  for (const timeoutMs of [0, -1]) {
    const h = harness({ native: true });
    assert.throws(() => h.context.requireStateLockMigration("C:\\state", { timeoutMs }), /timeout|timed out/i);
    assert.deepEqual(h.inspections, []);
  }
  const expired = harness({ native: true, scopeDelay: 23 });
  expired.context.readStateLockProtocol = () => assert.fail("expired guard must not continue");
  assert.throws(() => expired.context.requireStateLockMigration("C:\\state", { timeoutMs: 23 }), /timed out/i);
  assert.deepEqual(expired.inspections, [23]);
  const positive = harness({ native: true, scopeDelay: 10 });
  positive.context.requireStateLockMigration("C:\\state", { timeoutMs: 23 });
  assert.deepEqual(positive.inspections, [23]);
});

test("read-only migration scope rejects spent budgets before callback or subsequent effects", () => {
  const expired = harness({ native: true, scopeDelay: 23 });
  assert.equal(typeof expired.context.withStateLockMigrationScope, "function");
  assert.throws(() => expired.context.withStateLockMigrationScope("C:\\state", () => assert.fail("expired callback"), { timeoutMs: 23 }), /timed out/i);
  assert.deepEqual(expired.inspections, [23]);
  const zero = harness({ native: true });
  assert.throws(() => zero.context.withStateLockMigrationScope("C:\\state", () => assert.fail("zero callback"), { timeoutMs: 0 }), /timed out/i);
  assert.deepEqual(zero.inspections, []);
  const during = harness({ native: true });
  let sideEffect = false;
  assert.throws(() => during.context.withStateLockMigrationScope("C:\\state", check => {
    during.advance(24);
    check();
    sideEffect = true;
  }, { timeoutMs: 23 }), /timed out/i);
  assert.equal(sideEffect, false);
});
