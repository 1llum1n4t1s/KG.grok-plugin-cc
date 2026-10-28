import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

// 先行検証の失敗候補: 生存所有者の経過時間だけでの奪取、所有者不明・別ホスト・
// クラッシュ後の無根拠な回収、旧所有者による後継の解放、検査と削除の間の置換。
// fs はメモリ内だけで動く。実ディスクの fixture 作成・削除や PID 照会は行わない。
const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url), "utf8");
const lockSource = source.slice(source.indexOf("function resolveStateLockFile("), source.indexOf("export function updateState("));

function memoryLock(initial) {
  const files = new Map(initial ? [["/state/state.lock", { text: initial, mtimeMs: 0 }]] : []);
  const removals = [];
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const hooks = {};
  let generation = 0;
  const fakeFs = {
    lstatSync(file) {
      if (!files.has(file)) throw missing();
      return { isSymbolicLink: () => false, isDirectory: () => false };
    },
    writeFileSync(file, text, options) {
      if (options?.flag === "wx" && files.has(file)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(file, { text, mtimeMs: 20000 });
    },
    statSync(file) { return files.get(file) ?? (() => { throw missing(); })(); },
    readFileSync(file) {
      if (!files.has(file)) throw missing();
      const text = files.get(file).text;
      hooks.afterRead?.();
      return text;
    },
    existsSync(file) { return files.has(file); },
    rmSync(file) { removals.push(file); files.delete(file); }
  };
  const guardSource = source.slice(source.indexOf("function assertStateLockBarrier("), source.indexOf("function requireStateLockMigration("));
  const lock = vm.runInNewContext(`${lockSource}; ${guardSource}; withStateLock`, {
    fs: fakeFs, path: path.posix,
    resolveStateDir: () => "/state", ensureStateDir() {},
    STATE_LOCK_FILE_NAME: "state.lock", STATE_LOCK_STALE_MS: 10000,
    randomUUID: () => `generation-${++generation}`,
    STATE_LOCK_RETRY_LIMIT: 3, STATE_LOCK_RETRY_INTERVAL_MS: 0,
    SLEEP_SIGNAL: new Int32Array(1), Atomics: { wait() {} },
    Date: { now: () => 20000 }, process: { platform: "win32", pid: 100, kill() {} }
  });
  return { lock, files, removals, hooks };
}

for (const owner of ["200\n", "unknown\n", '{"pid":200,"hostname":"another-host"}\n']) {
  test(`old mtime cannot authorize lock takeover (${owner.trim()})`, () => {
    const memory = memoryLock(owner);
    let entered = false;
    assert.throws(() => memory.lock("workspace", () => { entered = true; }), /state lock/i);
    assert.equal(entered, false);
    assert.equal(memory.files.get("/state/state.lock").text, owner);
    assert.deepEqual(memory.removals, []);
  });
}

test("unmigrated state rejects a writer before it can replace an owner", () => {
  const memory = memoryLock();
  assert.throws(() => memory.lock("workspace", () => assert.fail("unmigrated callback")), /migration/i);
  assert.equal(memory.files.has("/state/state.lock"), false);
  assert.deepEqual(memory.removals, []);
});

test("repeated unmigrated writers cannot create a legacy lock", () => {
  const memory = memoryLock();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => memory.lock("workspace", () => assert.fail("unmigrated callback")), /migration/i);
  }
  assert.equal(memory.files.has("/state/state.lock"), false);
});

test("unmigrated state never reaches a failing callback", () => {
  const memory = memoryLock();
  assert.throws(() => memory.lock("workspace", () => assert.fail("callback must not run")), /migration/i);
  assert.equal(memory.files.has("/state/state.lock"), false);
});

test("a crashed owner's lock is retained rather than recovered without proof", () => {
  const memory = memoryLock('{"pid":999999,"token":"crashed-owner"}\n');
  assert.throws(() => memory.lock("workspace", () => assert.fail("unsafe recovery")), /state lock/i);
  assert.deepEqual(memory.removals, []);
});

test("external successor is retained because legacy ownership checks and unlink never run", () => {
  const memory = memoryLock();
  memory.hooks.afterRead = () => {
    memory.files.set("/state/state.lock", { text: "external-successor\n", mtimeMs: 20000 });
  };
  let entered = false;
  assert.throws(() => memory.lock("workspace", () => { entered = true; }), /migration/i);
  assert.equal(entered, false);
  // 旧実装がreadを開始すれば、上のhookが後継を差し込む。同じ攻撃を再度差し込む。
  memory.files.set("/state/state.lock", { text: "external-successor\n", mtimeMs: 20000 });
  assert.throws(() => memory.lock("workspace", () => { entered = true; }), /migration/i);
  assert.equal(memory.files.get("/state/state.lock")?.text, "external-successor\n");
  assert.equal(entered, false);
  assert.deepEqual(memory.removals, []);
});
