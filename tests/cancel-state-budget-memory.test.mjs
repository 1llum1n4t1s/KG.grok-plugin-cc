import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// 失敗条件: 他jobのcancelが停止予算5秒までlockを保持する間、500msで
// 取得を諦めて進捗更新を失敗させる。時計とFSを仮想化し実待機・削除をしない。
const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url), "utf8");
const limits = source.match(/^const STATE_LOCK_RETRY_(?:LIMIT|INTERVAL_MS) = .*;$/gm).join("\n");
const start = source.indexOf("function withStateLock(");
const lockSource = source.slice(start, source.indexOf("export function updateState", start));
const nativeStart = source.indexOf("export function withNativeStateLock(");
const nativeSource = source.slice(nativeStart, source.indexOf("function canonicalStateLockPath", nativeStart)).replace(/^export /gm, "");

function fixture(releaseAt, resolutionMs = 0) {
  let elapsed = 0;
  let released = 0;
  const resolutions = [];
  const stateDir = "virtual-state-root";
  const protocol = { protocol: "native-local-v2", localOnly: true, hostId: "virtual-host", directoryIdentity: { dev: "1", ino: "2" } };
  const context = vm.createContext({
    resolveStateDir(cwd, options) {
      assert.equal(cwd, "virtual");
      resolutions.push(options?.deadline);
      elapsed += resolutionMs;
      return stateDir;
    },
    ensureStateDir(cwd, resolvedDir) { assert.equal(cwd, "virtual"); assert.equal(resolvedDir, stateDir); },
    resolveStateLockFile(cwd, resolvedDir) {
      assert.equal(cwd, "virtual"); assert.equal(resolvedDir, stateDir);
      return "virtual-lock";
    },
    performance: { now: () => elapsed },
    process: { pid: 123, platform: "win32" }, SLEEP_SIGNAL: {},
    HELD_STATE_LOCK_SCOPES: new Map(),
    assertStateLockBarrier: value => { assert.equal(value, stateDir); return "virtual-lock"; },
    inspectNativeStateLockScope: value => { assert.equal(value, stateDir); return { hostId: protocol.hostId }; },
    readStateLockProtocol(value, scope) {
      assert.equal(value, "virtual-lock");
      assert.equal(protocol.protocol, "native-local-v2");
      assert.equal(protocol.localOnly, true);
      assert.equal(scope.hostId, protocol.hostId);
    },
    resolveNativeStateLockEndpoint: value => { assert.equal(value, stateDir); return "virtual-native-endpoint"; },
    readNativeStateLockIdentity: () => protocol.directoryIdentity,
    nativeStateLockEndpoint: () => "virtual-native-endpoint",
    Atomics: { wait: (_array, _index, _value, milliseconds) => { elapsed += milliseconds; } },
    net: {
      createServer: () => ({
        listening: false,
        on() {},
        listen(options) { assert.equal(options.path, "virtual-native-endpoint"); assert.equal(options.exclusive, true); this.listening = elapsed >= releaseAt; },
        unref() {},
        close() { if (this.listening) released += 1; this.listening = false; }
      })
    }
  });
  vm.runInContext(`${limits}\n${nativeSource}\n${lockSource}`, context);
  return {
    lock: (run, options) => context.withStateLock("virtual", run, options),
    // 旧fixtureの削除回数に相当する、自分が取得したmutexの解放回数。
    elapsed: () => elapsed, removed: () => released, resolutions, stateDir
  };
}

test("state writer waits through the cancellation stop budget before updating", () => {
  const f = fixture(5000);
  assert.equal(f.lock(() => "updated"), "updated");
  assert.equal(f.elapsed(), 5000);
  assert.equal(f.removed(), 1);
  assert.deepEqual(f.resolutions, [undefined]);
});

test("state writer bounds contention below legacy stale-age and never removes another owner", () => {
  const f = fixture(Infinity);
  assert.throws(() => f.lock(() => assert.fail("Must not write")), /Native state lock acquisition failed/);
  assert.ok(f.elapsed() > 5000);
  assert.ok(f.elapsed() < 10_000);
  assert.equal(f.removed(), 0);
  assert.deepEqual(f.resolutions, [undefined]);
});

test("explicit lock budget includes root resolution and never renews its deadline", () => {
  const f = fixture(Infinity, 13);
  assert.throws(() => f.lock(() => assert.fail("Must not write"), { timeoutMs: 23 }), /Native state lock acquisition failed/);
  assert.equal(f.elapsed(), 23);
  assert.equal(f.removed(), 0);
  assert.deepEqual(f.resolutions, [23]);
});

test("transaction callback receives the same root resolved once within its budget", () => {
  const f = fixture(0, 13);
  assert.equal(f.lock((assertDeadline, stateDir) => {
    assertDeadline();
    assert.equal(stateDir, f.stateDir);
    return "updated";
  }, { timeoutMs: 23 }), "updated");
  assert.equal(f.elapsed(), 13);
  assert.equal(f.removed(), 1);
  assert.deepEqual(f.resolutions, [23]);
});
