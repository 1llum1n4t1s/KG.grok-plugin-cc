import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const lockSource = fs.readFileSync(new URL("../plugins/grok/scripts/lib/posix-state-lock.mjs", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const recoverySource = fs.readFileSync(new URL("../plugins/grok/scripts/lib/linux-epoch-recovery.mjs", import.meta.url), "utf8");
const mountSource = recoverySource.slice(recoverySource.indexOf("function fail("), recoverySource.indexOf("function requireSameMount("))
  .replace(/^export /gm, "");

// 擬似 Linux の descriptor と fdinfo は別々に追跡する。inode は同じでも mount は異なり得る。
function model({ mounts = {}, badInfo = {}, baseMount = "41" } = {}) {
  const root = "/state", barrier = `${root}/state.lock`, marker = `${barrier}/protocol.json`, lock = `${barrier}/native.lock`;
  const names = [root, barrier, marker, lock];
  const ids = Object.fromEntries(names.map((name, i) => [name, { dev: "9", ino: String(i + 1) }]));
  const scope = { hostId: "host", fileSystem: "ext4", directoryIdentity: ids[root],
    bootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", pidNamespace: "pid:[1]", timeNamespace: "time:[1]", netNamespace: "net:[1]" };
  const payload = { protocol: "posix-linux-sentinel-v3", localOnly: true, ...scope,
    barrierIdentity: ids[barrier], markerIdentity: ids[marker], lockIdentity: ids[lock],
    epoch: "generation", sentinel: { generation: "generation" } };
  const descriptors = new Map();
  let nextFd = 10;
  function resolve(file) {
    const m = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(file);
    if (!m) return file;
    const parent = descriptors.get(Number(m[1]));
    if (!parent) throw Object.assign(new Error("bad fd"), { code: "EBADF" });
    return m[2] ? path.posix.normalize(`${parent}/${m[2]}`) : parent;
  }
  function stat(file) {
    file = resolve(file);
    const id = ids[file];
    if (!id) throw Object.assign(new Error(`missing ${file}`), { code: "ENOENT" });
    const directory = file === root || file === barrier;
    return { dev: BigInt(id.dev), ino: BigInt(id.ino), uid: 1000n, mode: directory ? 0o700n : 0o600n,
      isSymbolicLink: () => false, isDirectory: () => directory, isFile: () => !directory };
  }
  const fakeFs = {
    constants: { O_RDONLY: 0, O_NONBLOCK: 1, O_NOFOLLOW: 2, O_DIRECTORY: 4 },
    lstatSync: stat, statSync: stat,
    openSync(file) { file = resolve(file); stat(file); const fd = nextFd++; descriptors.set(fd, file); return fd; },
    fstatSync(fd) { return stat(descriptors.get(fd)); },
    closeSync(fd) { assert.equal(descriptors.delete(fd), true, "descriptor closed exactly once"); },
    fsyncSync() {},
    readFileSync(file) {
      if (typeof file === "number") return JSON.stringify(payload);
      if (file === "/proc/sys/kernel/random/boot_id") return scope.bootId;
      if (file === "/proc/self/status") return "NSpid:\t42\n";
      const match = /^\/proc\/self\/fdinfo\/(\d+)$/.exec(file);
      if (match) {
        const name = descriptors.get(Number(match[1]));
        if (!name) throw Object.assign(new Error("bad fd"), { code: "EBADF" });
        const fault = badInfo[name];
        if (fault === "unavailable") throw Object.assign(new Error("unavailable"), { code: "EACCES" });
        if (fault === "missing") return "flags:\t0\n";
        if (fault === "malformed") return "mnt_id:\tinvalid\n";
        if (fault === "duplicate") return "mnt_id:\t41\nmnt_id:\t41\n";
        return `mnt_id:\t${mounts[name] ?? baseMount}\n`;
      }
      throw new Error(`unexpected read: ${file}`);
    },
    readlinkSync(file) { return scope[`${file.split("/").pop()}Namespace`]; }
  };
  const calls = [];
  const context = vm.createContext({ fs: fakeFs, path: path.posix, process: { platform: "linux", pid: 42, getuid: () => 1000 },
    performance: { now: () => 0 }, SharedArrayBuffer, Int32Array, Atomics, Buffer,
    execFileSync(command, args, options) { calls.push({ command, args, options }); return ""; },
    verifyLinuxSentinel() {}, linuxSentinelExited() {}, sentinelScript: "/sentinel.mjs",
    initializeLinuxEpochRecovery() {}, requireLinuxEpochRecovery() {} });
  vm.runInContext(`${mountSource}\n${lockSource}\nglobalThis.enter = withPosixStateLock; globalThis.read = readPosixStateLockProtocol;`, context);
  return { context, scope, root, barrier, marker, lock, descriptors, calls };
}

test("Linux state lock accepts one mount including a root alias and retains its state FD during callback", () => {
  const m = model({ baseMount: "73" });
  m.context.enter(m.root, m.scope, () => {
    assert.ok([...m.descriptors.values()].includes(m.root), "state directory descriptor must survive the callback");
  }, { timeoutMs: 1000 });
  assert.equal(m.descriptors.size, 0);
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].options.stdio.length, 4, "flock inherits the native lock only");
});

for (const name of ["barrier", "marker", "lock"]) {
  test(`Linux state lock rejects same-inode ${name} on another mount`, () => {
    const initial = model();
    const m = model({ mounts: { [initial[name]]: "42" } });
    assert.throws(() => m.context.read(m.barrier, m.scope), /mount/i);
    let entered = false;
    assert.throws(() => m.context.enter(m.root, m.scope, () => { entered = true; }, { timeoutMs: 1000 }), /mount/i);
    assert.equal(entered, false);
    assert.equal(m.descriptors.size, 0);
  });
}

for (const name of ["root", "barrier", "marker", "lock"]) {
  for (const fault of ["unavailable", "missing", "malformed", "duplicate"]) {
    test(`Linux state lock fails closed for ${name} fdinfo ${fault}`, () => {
      const initial = model();
      const m = model({ badInfo: { [initial[name]]: fault } });
      let entered = false;
      assert.throws(() => m.context.enter(m.root, m.scope, () => { entered = true; }, { timeoutMs: 1000 }), /mount/i);
      assert.equal(entered, false);
      assert.equal(m.descriptors.size, 0);
    });
  }
}
