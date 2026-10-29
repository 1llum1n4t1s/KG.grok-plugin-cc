import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { migrateStateLock, resolveStateDir, withStateSnapshot } from "../plugins/grok/scripts/lib/state.mjs";
import { shutdownPosixStateLockSentinel } from "../plugins/grok/scripts/lib/posix-state-lock.mjs";
import { snapshotLegacyAdmission, createLinuxEpochRecovery, requireLinuxEpochRecovery } from "../plugins/grok/scripts/lib/linux-epoch-recovery.mjs";

// 失敗条件: 確認不足、旧対象の変化・未知項目・リンク、上限超過、部分書込み、同期失敗を成功扱いする。
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-epoch-recovery-"));
  const cwd = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(cwd); fs.mkdirSync(data);
  const previous = [process.env.CLAUDE_PLUGIN_DATA, process.env.PLUGIN_DATA];
  process.env.CLAUDE_PLUGIN_DATA = data; process.env.PLUGIN_DATA = data;
  const state = resolveStateDir(cwd);
  migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state });
  t.after(() => {
    try { shutdownPosixStateLockSentinel(state, { offlineConfirmed: true, expectedStateDir: state }); }
    finally {
      for (const [i, key] of ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].entries()) {
        if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
      }
      t.diagnostic(`Isolated fixture retained: ${root}`);
    }
  });
  const scope = (fn, options) => withStateSnapshot(cwd, (_state, context) => fn(context), options);
  const confirmed = { offlineConfirmed: true, localOnly: true, expectedStateDir: state, allOldProcessesStopped: true };
  return { root, state, scope, confirmed };
}

function linkedPointerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-linked-pointer-"));
  const cwd = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(cwd); fs.mkdirSync(data);
  const previous = [process.env.CLAUDE_PLUGIN_DATA, process.env.PLUGIN_DATA];
  process.env.CLAUDE_PLUGIN_DATA = data; process.env.PLUGIN_DATA = data;
  const state = resolveStateDir(cwd), recovery = path.join(state, "linux-epoch-recovery-v1");
  t.after(() => {
    try {
      if (fs.existsSync(path.join(state, "state.lock", "protocol.json"))) {
        shutdownPosixStateLockSentinel(state, { offlineConfirmed: true, expectedStateDir: state });
      }
    } finally {
      for (const [i, key] of ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].entries()) {
        if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
      }
      t.diagnostic(`Isolated fixture retained: ${root}`);
    }
  });
  const unlink = fs.unlinkSync; let injected = 0;
  fs.unlinkSync = file => {
    const target = fs.realpathSync(file), relative = path.relative(recovery, target).split(path.sep);
    if (relative.length === 2 && /^[0-9a-f-]{36}$/.test(relative[0]) && /^pointer-[0-9a-f-]{36}\.tmp$/.test(relative[1])) {
      injected++;
      const error = new Error("injected pointer unlink EIO"); error.code = "EIO";
      throw error;
    }
    return unlink(file);
  };
  try {
    assert.throws(() => migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state }), /injected pointer unlink EIO/);
  } finally { fs.unlinkSync = unlink; }
  assert.equal(injected, 1, "initial pointer unlink was not reached");
  const scope = fn => withStateSnapshot(cwd, (_state, context) => fn(context));
  const epoch = scope(c => c.epoch), dir = path.join(recovery, epoch), pointer = path.join(dir, "current.json");
  const current = JSON.parse(fs.readFileSync(pointer, "utf8"));
  const temp = path.join(dir, `pointer-${current.attempt.slice(0, -5)}.tmp`);
  const pointerStat = fs.statSync(pointer, { bigint: true }), tempStat = fs.statSync(temp, { bigint: true });
  assert.equal(pointerStat.nlink, 2n);
  assert.equal(pointerStat.dev, tempStat.dev);
  assert.equal(pointerStat.ino, tempStat.ino);
  return { root, state, scope, dir, pointer, temp, pointerStat,
    confirmed: { offlineConfirmed: true, localOnly: true, expectedStateDir: state, allOldProcessesStopped: true } };
}

test("offline recovery binds old inventory and repeats sync before use", { skip: process.platform !== "linux" }, t => {
  const { state, scope, confirmed } = fixture(t);
  scope(c => requireLinuxEpochRecovery(c));
  const old = path.join(state, "broker.json");
  fs.writeFileSync(old, "{broken old record");
  const oldEpoch = randomUUID(), dir = path.join(state, "broker-v3", oldEpoch);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const journal = path.join(dir, "broker-admission.jsonl");
  fs.writeFileSync(journal, '{"event":"pending"}\n');
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  for (const key of ["offlineConfirmed", "localOnly", "allOldProcessesStopped"]) {
    assert.throws(() => scope(c => createLinuxEpochRecovery(c, { ...confirmed, [key]: false })));
  }
  assert.throws(() => scope(c => createLinuxEpochRecovery(c, { ...confirmed, expectedStateDir: state + "-other" })));
  const before = scope(c => snapshotLegacyAdmission(c));
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
  assert.deepEqual(scope(c => snapshotLegacyAdmission(c)), before);
  assert.equal(fs.readFileSync(old, "utf8"), "{broken old record");
  fs.writeFileSync(journal, '{"event":"changed"}\n');
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
});

test("recovery accepts state directory aliases only for the same identity", { skip: process.platform !== "linux" }, t => {
  const { root, state, scope, confirmed } = fixture(t);
  const data = path.join(root, "data"), alias = path.join(root, "data-alias");
  fs.symlinkSync(data, alias, "dir");
  const original = fs.statSync(state, { bigint: true });
  scope(c => requireLinuxEpochRecovery(c));
  try {
    process.env.CLAUDE_PLUGIN_DATA = alias;
    process.env.PLUGIN_DATA = alias;
    scope(c => {
      const resolved = fs.statSync(c.stateDir, { bigint: true });
      assert.notEqual(c.stateDir, state);
      assert.equal(resolved.dev, original.dev);
      assert.equal(resolved.ino, original.ino);
      requireLinuxEpochRecovery(c);
    });
    fs.writeFileSync(path.join(state, "broker.lock"), "old pending");
    scope(c => createLinuxEpochRecovery(c, { ...confirmed, expectedStateDir: c.stateDir }));
    scope(c => requireLinuxEpochRecovery(c));
  } finally {
    process.env.CLAUDE_PLUGIN_DATA = data;
    process.env.PLUGIN_DATA = data;
  }
  scope(c => requireLinuxEpochRecovery(c));
  scope(c => assert.throws(() => requireLinuxEpochRecovery({ ...c, hostId: `${c.hostId}-other` })));
  scope(c => assert.throws(() => requireLinuxEpochRecovery({ ...c, epoch: randomUUID() })));
  const other = path.join(root, "other-state"); fs.mkdirSync(other);
  const different = fs.statSync(other, { bigint: true });
  assert.ok(different.dev !== original.dev || different.ino !== original.ino);
  scope(c => assert.throws(() => requireLinuxEpochRecovery({ ...c, stateDir: other })));
});

function verifyPreservedPointer(dir, original, bytes, syncEvents) {
  const matches = fs.readdirSync(dir).flatMap(name => {
    const file = path.join(dir, name), stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(bytes.length) || !fs.readFileSync(file).equals(bytes)) return [];
    return [{ file, stat }];
  });
  const originals = matches.filter(({ stat }) => stat.dev === original.dev && stat.ino === original.ino && stat.nlink === 1n);
  assert.equal(originals.length, 1, "the old pointer inode and bytes must remain preserved");
  const copies = matches.filter(({ stat }) => stat.dev !== original.dev || stat.ino !== original.ino);
  assert.ok(copies.some(({ file }) => {
    const index = syncEvents.indexOf(file);
    return index >= 0 && syncEvents.slice(index + 1).includes(dir);
  }), "a separate pointer copy and then its parent directory must be fsynced");
}

test("reconfirmation preserves the prior pointer inode and a durable independent copy", { skip: process.platform !== "linux" }, t => {
  const { state, scope, confirmed } = fixture(t);
  scope(c => createLinuxEpochRecovery(c, confirmed));
  const epoch = scope(c => c.epoch), dir = path.join(state, "linux-epoch-recovery-v1", epoch);
  const pointer = path.join(dir, "current.json"), original = fs.statSync(pointer, { bigint: true }), bytes = fs.readFileSync(pointer);
  const real = fs.fsyncSync, synced = [];
  scope(c => {
    fs.fsyncSync = fd => {
      try { synced.push(fs.realpathSync(`/proc/self/fd/${fd}`)); } catch { /* 切断済み descriptor は証拠にしない。 */ }
      return real(fd);
    };
    try { return createLinuxEpochRecovery(c, confirmed); } finally { fs.fsyncSync = real; }
  });
  scope(c => requireLinuxEpochRecovery(c));
  verifyPreservedPointer(dir, original, bytes, synced);
});

for (const failure of ["pointer copy fsync", "pointer preservation fsync"]) {
  test(`reconfirmation preserves the prior pointer after ${failure} EIO`, { skip: process.platform !== "linux" }, t => {
    const { state, scope, confirmed } = fixture(t);
    scope(c => createLinuxEpochRecovery(c, confirmed));
    const epoch = scope(c => c.epoch), dir = path.join(state, "linux-epoch-recovery-v1", epoch);
    const pointer = path.join(dir, "current.json"), original = fs.statSync(pointer, { bigint: true }), bytes = fs.readFileSync(pointer);
    const realFsync = fs.fsyncSync, realLink = fs.linkSync; let linked = false, injected = 0;
    assert.throws(() => scope(c => {
      fs.linkSync = (source, destination) => {
        const result = realLink(source, destination), stat = fs.statSync(destination, { bigint: true });
        if (stat.dev === original.dev && stat.ino === original.ino) linked = true;
        return result;
      };
      fs.fsyncSync = fd => {
        const stat = fs.fstatSync(fd, { bigint: true });
        const file = fs.realpathSync(`/proc/self/fd/${fd}`);
        if ((failure === "pointer copy fsync" && path.dirname(file) === dir && /^pointer-archive-[0-9a-f-]{36}\.json$/.test(path.basename(file))) ||
            (failure === "pointer preservation fsync" && linked && stat.dev === original.dev && stat.ino === original.ino)) {
          injected++;
          const error = new Error(`injected ${failure} EIO`); error.code = "EIO";
          throw error;
        }
        return realFsync(fd);
      };
      try { return createLinuxEpochRecovery(c, confirmed); } finally { fs.fsyncSync = realFsync; fs.linkSync = realLink; }
    }), /injected .* EIO/);
    assert.equal(injected, 1, `failpoint was not reached: ${failure}`);
    assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
    const synced = [];
    scope(c => {
      fs.fsyncSync = fd => { try { synced.push(fs.realpathSync(`/proc/self/fd/${fd}`)); } catch { /* 未解決の fd は除外する。 */ } return realFsync(fd); };
      try { return createLinuxEpochRecovery(c, confirmed); } finally { fs.fsyncSync = realFsync; }
    });
    scope(c => requireLinuxEpochRecovery(c));
    verifyPreservedPointer(dir, original, bytes, synced);
  });
}

test("recovery refuses non-private current and recovery directories", { skip: process.platform !== "linux" }, t => {
  const { state, scope, confirmed } = fixture(t);
  const epoch = scope(c => c.epoch), recovery = path.join(state, "linux-epoch-recovery-v1");
  const dirs = [recovery, path.join(recovery, epoch), path.join(state, "broker-v3"),
    path.join(state, "broker-v3", epoch), path.join(state, "direct-start-v2"), path.join(state, "direct-start-v2", epoch)];
  const namespaces = new Set([path.join(state, "broker-v3"), path.join(state, "direct-start-v2")]);
  for (const dir of dirs) {
    const before = fs.statSync(dir, { bigint: true });
    const original = Number(before.mode & 0o7777n);
    try {
      fs.chmodSync(dir, 0o777);
      assert.throws(() => scope(c => requireLinuxEpochRecovery(c)), `accepted non-private directory: ${dir}`);
      assert.throws(() => scope(c => createLinuxEpochRecovery(c, confirmed)), `reconfirmed non-private directory: ${dir}`);
    } finally { fs.chmodSync(dir, original); }
    if (namespaces.has(dir)) {
      assert.notEqual(fs.statSync(dir, { bigint: true }).ctimeNs, before.ctimeNs, `namespace ctime did not change: ${dir}`);
      assert.throws(() => scope(c => requireLinuxEpochRecovery(c)), /explicit offline recovery is required/);
      scope(c => createLinuxEpochRecovery(c, confirmed));
    }
    scope(c => requireLinuxEpochRecovery(c));
  }
});

test("partial attempts do not authorize use and a fresh confirmed attempt can recover", { skip: process.platform !== "linux" }, t => {
  const { state, scope, confirmed } = fixture(t);
  fs.writeFileSync(path.join(state, "broker.lock"), "old");
  const epoch = scope(c => c.epoch);
  const dir = path.join(state, "linux-epoch-recovery-v1", epoch);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const partial = path.join(dir, `${randomUUID()}.json`);
  fs.writeFileSync(partial, '{"version":');
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
  assert.equal(fs.readFileSync(partial, "utf8"), '{"version":');
});

test("recovery detects replacement of a legacy namespace parent", { skip: process.platform !== "linux" }, t => {
  const { root, state, scope, confirmed } = fixture(t);
  const namespace = path.join(state, "broker-v3"), oldEpoch = randomUUID();
  const oldDir = path.join(namespace, oldEpoch);
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, "broker-admission.jsonl"), "old pending\n");
  scope(c => createLinuxEpochRecovery(c, confirmed));
  const currentEpoch = scope(c => c.epoch);
  const current = fs.lstatSync(path.join(namespace, currentEpoch));
  assert.ok(current.isDirectory() && !current.isSymbolicLink());
  scope(c => requireLinuxEpochRecovery(c));
  const parked = path.join(root, "parked-broker-v3");
  fs.renameSync(namespace, parked);
  fs.mkdirSync(namespace);
  fs.renameSync(path.join(parked, oldEpoch), path.join(namespace, oldEpoch));
  fs.renameSync(path.join(parked, currentEpoch), path.join(namespace, currentEpoch));
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
});

test("removing the last old record invalidates an existing recovery", { skip: process.platform !== "linux" }, t => {
  const { root, state, scope, confirmed } = fixture(t);
  const old = path.join(state, "broker.json");
  fs.writeFileSync(old, "old broker state");
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
  fs.renameSync(old, path.join(root, "parked-broker.json"));
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
});

test("temporary changes to an old admission directory require new confirmation", { skip: process.platform !== "linux" }, t => {
  const { root, state, scope, confirmed } = fixture(t);
  const oldEpoch = randomUUID();
  const dirs = [path.join(state, "broker-v2"), path.join(state, "direct-start-v1"),
    path.join(state, "broker-v3", oldEpoch), path.join(state, "direct-start-v2", oldEpoch)];
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
  for (const [i, dir] of dirs.entries()) {
    const transient = path.join(dir, "transient");
    fs.writeFileSync(transient, "temporary old entry");
    fs.renameSync(transient, path.join(root, `parked-transient-${i}`));
    assert.throws(() => scope(c => requireLinuxEpochRecovery(c)), `directory change was missed: ${dir}`);
    scope(c => createLinuxEpochRecovery(c, confirmed));
    scope(c => requireLinuxEpochRecovery(c));
  }
});

test("temporary old epoch directories change the namespace inventory", { skip: process.platform !== "linux" }, t => {
  const { root, state, scope, confirmed } = fixture(t);
  for (const [i, name] of ["broker-v3", "direct-start-v2"].entries()) {
    const transient = path.join(state, name, randomUUID());
    fs.mkdirSync(transient, { mode: 0o700 });
    fs.renameSync(transient, path.join(root, `parked-epoch-${i}`));
    assert.throws(() => scope(c => requireLinuxEpochRecovery(c)), `namespace change was missed: ${name}`);
    scope(c => createLinuxEpochRecovery(c, confirmed));
    scope(c => requireLinuxEpochRecovery(c));
  }
});

test("known unfinished broker temp records are inventoried and preserved", { skip: process.platform !== "linux" }, t => {
  const { state, scope, confirmed } = fixture(t);
  const oldEpoch = randomUUID(), brokerV2 = path.join(state, "broker-v2");
  const oldDir = path.join(state, "broker-v3", oldEpoch);
  fs.mkdirSync(brokerV2); fs.mkdirSync(oldDir, { recursive: true });
  const temps = [path.join(state, "broker.json.123.abc123.tmp"),
    path.join(brokerV2, "broker.json.456.def456.tmp"),
    path.join(oldDir, "broker.json.789.ghi789.tmp")];
  for (const file of temps) fs.writeFileSync(file, "{unfinished");
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
  for (const file of temps) assert.equal(fs.readFileSync(file, "utf8"), "{unfinished");
  fs.writeFileSync(temps[0], "{changed");
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
});

test("unknown, symbolic, hard-linked and oversized legacy entries fail closed", { skip: process.platform !== "linux" }, t => {
  const { state, scope } = fixture(t);
  const root = path.join(state, "broker-v2"); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "unknown"), "x");
  assert.throws(() => scope(c => snapshotLegacyAdmission(c)));
  fs.renameSync(path.join(root, "unknown"), path.join(root, "broker.json"));
  fs.linkSync(path.join(root, "broker.json"), path.join(state, "broker.json"));
  assert.throws(() => scope(c => snapshotLegacyAdmission(c)));
  fs.unlinkSync(path.join(state, "broker.json"));
  fs.symlinkSync(path.join(root, "broker.json"), path.join(state, "broker.lock"));
  assert.throws(() => scope(c => snapshotLegacyAdmission(c)));
  fs.unlinkSync(path.join(state, "broker.lock"));
  fs.writeFileSync(path.join(root, "broker-admission.jsonl"), Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.throws(() => scope(c => snapshotLegacyAdmission(c)));
});

test("a regular file swapped for a FIFO before open is rejected without blocking", { skip: process.platform !== "linux", timeout: 30000 }, t => {
  const { root, state } = fixture(t), cwd = path.join(root, "workspace");
  const original = path.join(state, "broker.json"), fifo = path.join(root, "replacement.fifo");
  fs.writeFileSync(original, "old broker");
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const script = String.raw`
    import fs from "node:fs";
    import path from "node:path";
    const { withStateSnapshot } = await import(process.env.TEST_STATE_MODULE);
    const { snapshotLegacyAdmission } = await import(process.env.TEST_RECOVERY_MODULE);
    const cwd = process.env.TEST_CWD, original = process.env.TEST_ORIGINAL, fifo = process.env.TEST_FIFO;
    const real = fs.openSync; let swapped = 0;
    fs.openSync = (file, ...args) => {
      if (typeof file === "string" && path.basename(file) === "broker.json" && !swapped) {
        fs.renameSync(original, process.env.TEST_PARKED);
        fs.renameSync(fifo, original);
        swapped++;
      }
      return real(file, ...args);
    };
    try {
      withStateSnapshot(cwd, (_state, context) => snapshotLegacyAdmission(context));
      process.exitCode = 2;
    } catch {
      if (swapped !== 1) process.exitCode = 3;
      else process.stdout.write("swapped and rejected\n");
    } finally { fs.openSync = real; }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd, encoding: "utf8", timeout: 12000,
    env: { ...process.env, TEST_STATE_MODULE: new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href,
      TEST_RECOVERY_MODULE: new URL("../plugins/grok/scripts/lib/linux-epoch-recovery.mjs", import.meta.url).href,
      TEST_CWD: cwd, TEST_ORIGINAL: original, TEST_FIFO: fifo, TEST_PARKED: path.join(root, "parked-broker.json") }
  });
  assert.equal(result.error?.code, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /swapped and rejected/);
});

for (const mountKind of ["foreign", "same-device"]) {
for (const kind of ["namespace", "current-epoch", "recovery", "recovery-epoch", "file"]) {
  test(`${mountKind} bind mount ${kind} is rejected without modifying evidence`, { skip: process.platform !== "linux", timeout: 60000 }, t => {
    const { root, state, scope } = fixture(t), cwd = path.join(root, "workspace");
    const epoch = scope(c => c.epoch), scratch = path.join(root, "mount-source");
    fs.mkdirSync(scratch, { mode: 0o700 });
    fs.writeFileSync(path.join(state, "broker.lock"), "original old lock");
    const pointer = path.join(state, "linux-epoch-recovery-v1", epoch, "current.json");
    const beforePointer = fs.readFileSync(pointer), beforeLock = fs.readFileSync(path.join(state, "broker.lock"));
    const script = String.raw`
      import fs from "node:fs";
      import path from "node:path";
      import { spawnSync } from "node:child_process";
      const { withStateSnapshot } = await import(process.env.TEST_STATE_MODULE);
      const { snapshotLegacyAdmission, createLinuxEpochRecovery, requireLinuxEpochRecovery } = await import(process.env.TEST_RECOVERY_MODULE);
      const { TEST_STATE: state, TEST_CWD: cwd, TEST_EPOCH: epoch, TEST_SCRATCH: scratch, TEST_KIND: kind, TEST_MOUNT_KIND: mountKind } = process.env;
      const mountInfo = target => {
        const unescape = value => value.replace(/\\(040|011|012|134)/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
        return fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").map(line => line.split(" "))
          .filter(parts => parts.length > 6 && unescape(parts[4]) === target).map(parts => parts[0]).at(-1) ?? null;
      };
      const run = (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 10000 });
      const fdMountId = file => {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
        try {
          const match = fs.readFileSync("/proc/self/fdinfo/" + fd, "utf8").match(/^mnt_id:\s*(\d+)\s*$/m);
          if (!match) throw new Error("fd mount identity is unavailable");
          return match[1];
        } finally { fs.closeSync(fd); }
      };
      let scratchId = null, targetId = null, target = null, code = 0;
      try {
        const mounted = mountKind === "foreign" ? run("mount", ["-t", "tmpfs", "-o", "mode=700,uid=" + process.getuid() + ",gid=" + process.getgid(), "tmpfs", scratch]) : { status: 0 };
        if (mounted.status !== 0) {
          if (/permission denied|operation not permitted/i.test(mounted.stderr ?? "")) { process.stdout.write("mount permission unavailable\n"); code = 77; }
          else throw new Error("tmpfs mount failed: " + (mounted.stderr || mounted.error?.message));
        } else {
          if (mountKind === "foreign") {
            scratchId = mountInfo(scratch);
            if (!scratchId) throw new Error("scratch mount identity is unavailable");
          }
          const source = path.join(scratch, "foreign");
          if (kind === "file") fs.writeFileSync(source, "foreign old lock", { mode: 0o600 });
          else {
            fs.mkdirSync(source, { mode: 0o700 });
            if (kind === "namespace") fs.mkdirSync(path.join(source, epoch), { mode: 0o700 });
          }
          target = kind === "namespace" ? path.join(state, "broker-v3") :
            kind === "current-epoch" ? path.join(state, "broker-v3", epoch) :
            kind === "recovery" ? path.join(state, "linux-epoch-recovery-v1") :
            kind === "recovery-epoch" ? path.join(state, "linux-epoch-recovery-v1", epoch) : path.join(state, "broker.lock");
          const bound = run("mount", ["--bind", source, target]);
          if (bound.status !== 0) throw new Error("bind mount failed: " + (bound.stderr || bound.error?.message));
          targetId = mountInfo(target);
          const sameDevice = fs.statSync(target, { bigint: true }).dev === fs.statSync(state, { bigint: true }).dev;
          if (!targetId || targetId === scratchId || fdMountId(target) !== targetId || fdMountId(state) === targetId ||
              (mountKind === "same-device" ? !sameDevice : sameDevice)) {
            throw new Error("requested device and mount identities were not established");
          }
          const listing = file => {
            const stat = fs.lstatSync(file);
            if (stat.isFile()) return { type: "file", bytes: fs.readFileSync(file).toString("base64") };
            if (!stat.isDirectory()) throw new Error("unexpected fixture entry");
            return { type: "directory", entries: fs.readdirSync(file).sort().map(name => [name, listing(path.join(file, name))]) };
          };
          const before = JSON.stringify(listing(source));
          const scope = fn => withStateSnapshot(cwd, (_state, context) => fn(context));
          let inspectRejected = false, createRejected = false, useRejected = false;
          let inspectEntered = 0, createEntered = 0, useEntered = 0;
          try { scope(context => { inspectEntered++; return snapshotLegacyAdmission(context); }); } catch { inspectRejected = true; }
          try { scope(context => { createEntered++; return createLinuxEpochRecovery(context, { offlineConfirmed: true, localOnly: true, expectedStateDir: state, allOldProcessesStopped: true }); }); } catch { createRejected = true; }
          try { scope(context => { useEntered++; return requireLinuxEpochRecovery(context); }); } catch { useRejected = true; }
          const inventoryUsesTarget = kind !== "recovery" && kind !== "recovery-epoch";
          if (inspectEntered !== 1 || createEntered !== 1 || useEntered !== 1 ||
              (inventoryUsesTarget && !inspectRejected) || !createRejected || !useRejected) {
            throw new Error("foreign filesystem accepted: inspect=" + inspectRejected + ", create=" + createRejected + ", use=" + useRejected);
          }
          if (JSON.stringify(listing(source)) !== before) throw new Error("foreign evidence was modified");
          process.stdout.write("foreign filesystem rejected\n");
        }
      } catch (error) { console.error(error.stack || error); code = 1; }
      finally {
        for (const [point, id] of [[target, targetId], [scratch, scratchId]]) {
          if (!id) continue;
          if (mountInfo(point) !== id) { console.error("mount identity changed; retained: " + point); code = 1; continue; }
          const result = run("umount", ["--", point]);
          if (result.status !== 0 || mountInfo(point) === id) { console.error("mount cleanup failed; retained: " + point + ": " + result.stderr); code = 1; }
        }
      }
      process.exitCode = code;
    `;
    const result = spawnSync("unshare", ["--mount", "--fork", process.execPath, "--input-type=module", "-e", script], {
      cwd, encoding: "utf8", timeout: 45000,
      env: { ...process.env, TEST_STATE_MODULE: new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href,
        TEST_RECOVERY_MODULE: new URL("../plugins/grok/scripts/lib/linux-epoch-recovery.mjs", import.meta.url).href,
        TEST_STATE: state, TEST_CWD: cwd, TEST_EPOCH: epoch, TEST_SCRATCH: scratch, TEST_KIND: kind, TEST_MOUNT_KIND: mountKind }
    });
    if (result.status === 77 || /unshare failed: operation not permitted/i.test(result.stderr ?? "")) {
      t.skip(`isolated mount privileges unavailable: ${(result.stderr || result.stdout).trim()}`);
      return;
    }
    assert.equal(result.error?.code, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /foreign filesystem rejected/);
    assert.deepEqual(fs.readFileSync(pointer), beforePointer);
    assert.deepEqual(fs.readFileSync(path.join(state, "broker.lock")), beforeLock);
  });
}
}

test("a bind alias of the state root remains usable across mount IDs", { skip: process.platform !== "linux", timeout: 60000 }, t => {
  const { root, state, scope } = fixture(t), cwd = path.join(root, "workspace");
  const data = path.join(root, "data"), alias = path.join(root, "data-bind");
  fs.mkdirSync(alias, { mode: 0o700 });
  const script = String.raw`
    import fs from "node:fs";
    import path from "node:path";
    import { spawnSync } from "node:child_process";
    const { withStateSnapshot } = await import(process.env.TEST_STATE_MODULE);
    const { requireLinuxEpochRecovery, createLinuxEpochRecovery } = await import(process.env.TEST_RECOVERY_MODULE);
    const { TEST_STATE: state, TEST_CWD: cwd, TEST_DATA: data, TEST_ALIAS: alias } = process.env;
    const mountInfo = target => {
      const unescape = value => value.replace(/\\(040|011|012|134)/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
      return fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").map(line => line.split(" "))
        .filter(parts => parts.length > 6 && unescape(parts[4]) === target).map(parts => parts[0]).at(-1) ?? null;
    };
    const fdMountId = file => {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const match = fs.readFileSync("/proc/self/fdinfo/" + fd, "utf8").match(/^mnt_id:\s*(\d+)\s*$/m);
        if (!match) throw new Error("fd mount identity is unavailable");
        return match[1];
      } finally { fs.closeSync(fd); }
    };
    let id = null, code = 0;
    try {
      const mounted = spawnSync("mount", ["--bind", data, alias], { encoding: "utf8", timeout: 10000 });
      if (mounted.status !== 0) {
        if (/permission denied|operation not permitted/i.test(mounted.stderr ?? "")) { process.stdout.write("mount permission unavailable\n"); code = 77; }
        else throw new Error("bind mount failed: " + (mounted.stderr || mounted.error?.message));
      } else {
        id = mountInfo(alias);
        const aliasState = path.join(alias, path.relative(data, state));
        const original = fs.statSync(state, { bigint: true }), mapped = fs.statSync(aliasState, { bigint: true });
        if (!id || original.dev !== mapped.dev || original.ino !== mapped.ino || fdMountId(state) === fdMountId(aliasState)) {
          throw new Error("bind alias identity was not established");
        }
        process.env.CLAUDE_PLUGIN_DATA = alias; process.env.PLUGIN_DATA = alias;
        const scope = fn => withStateSnapshot(cwd, (_state, context) => fn(context));
        scope(context => { if (context.stateDir !== aliasState) throw new Error("alias state was not used"); return requireLinuxEpochRecovery(context); });
        scope(context => createLinuxEpochRecovery(context, { offlineConfirmed: true, localOnly: true, expectedStateDir: aliasState, allOldProcessesStopped: true }));
        scope(context => requireLinuxEpochRecovery(context));
        process.stdout.write("bind alias accepted\n");
      }
    } catch (error) { console.error(error.stack || error); code = 1; }
    finally {
      if (id) {
        if (mountInfo(alias) !== id) { console.error("mount identity changed; retained: " + alias); code = 1; }
        else {
          const result = spawnSync("umount", ["--", alias], { encoding: "utf8", timeout: 10000 });
          if (result.status !== 0 || mountInfo(alias) === id) { console.error("mount cleanup failed; retained: " + alias); code = 1; }
        }
      }
    }
    process.exitCode = code;
  `;
  const result = spawnSync("unshare", ["--mount", "--fork", process.execPath, "--input-type=module", "-e", script], {
    cwd, encoding: "utf8", timeout: 45000,
    env: { ...process.env, TEST_STATE_MODULE: new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url).href,
      TEST_RECOVERY_MODULE: new URL("../plugins/grok/scripts/lib/linux-epoch-recovery.mjs", import.meta.url).href,
      TEST_STATE: state, TEST_CWD: cwd, TEST_DATA: data, TEST_ALIAS: alias }
  });
  if (result.status === 77 || /unshare failed: operation not permitted/i.test(result.stderr ?? "")) {
    t.skip(`isolated mount privileges unavailable: ${(result.stderr || result.stdout).trim()}`);
    return;
  }
  assert.equal(result.error?.code, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bind alias accepted/);
  scope(c => requireLinuxEpochRecovery(c));
});

test("sync failure is not treated as success and confirmed retry re-syncs existing record", { skip: process.platform !== "linux" }, t => {
  const { state, scope, confirmed } = fixture(t);
  fs.writeFileSync(path.join(state, "broker.lock"), "old");
  const epoch = scope(c => c.epoch), attempts = path.join(state, "linux-epoch-recovery-v1", epoch);
  const existing = new Set(fs.readdirSync(attempts));
  const real = fs.fsyncSync; let entered = 0, injected = 0;
  assert.throws(() => scope(c => {
    entered++;
    fs.fsyncSync = fd => {
      const file = fs.realpathSync(`/proc/self/fd/${fd}`), name = path.basename(file);
      const stat = fs.fstatSync(fd, { bigint: true });
      if (path.dirname(file) === attempts && /^[0-9a-f-]{36}\.json$/.test(name) &&
          !existing.has(name) && stat.isFile() && stat.nlink === 1n) {
        injected++;
        throw new Error("injected attempt fsync failure");
      }
      return real(fd);
    };
    try { return createLinuxEpochRecovery(c, confirmed); } finally { fs.fsyncSync = real; }
  }), /injected attempt fsync failure/);
  assert.equal(entered, 1, "recovery callback was not entered");
  assert.equal(injected, 1, "new attempt fsync was not reached");
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
});

test("consumer refuses fsync failures at the attempt and every parent", { skip: process.platform !== "linux" }, t => {
  const { state, scope, confirmed } = fixture(t);
  fs.writeFileSync(path.join(state, "broker.lock"), "old");
  scope(c => createLinuxEpochRecovery(c, confirmed));
  const epoch = scope(c => c.epoch), recovery = path.join(state, "linux-epoch-recovery-v1");
  const attempts = path.join(recovery, epoch);
  const pointer = path.join(attempts, "current.json");
  const attempt = path.join(attempts, JSON.parse(fs.readFileSync(pointer, "utf8")).attempt);
  const real = fs.fsyncSync, targets = [attempt, pointer, attempts, recovery, state];
  const identities = new Map(targets.map(target => {
    const stat = fs.lstatSync(target, { bigint: true });
    return [target, { dev: stat.dev, ino: stat.ino }];
  }));
  const targetFor = fd => {
    const file = fs.realpathSync(`/proc/self/fd/${fd}`), expected = identities.get(file);
    if (!expected) return null;
    const actual = fs.fstatSync(fd, { bigint: true });
    return actual.dev === expected.dev && actual.ino === expected.ino ? file : null;
  };
  for (const [index, target] of targets.entries()) {
    let entered = 0, injected = 0;
    const reached = new Set();
    assert.throws(() => scope(c => {
      entered++;
      fs.fsyncSync = fd => {
        const current = targetFor(fd);
        if (current === target && targets.slice(0, index).every(previous => reached.has(previous))) {
          injected++;
          throw new Error("injected target fsync failure");
        }
        if (current) reached.add(current);
        return real(fd);
      };
      try { return requireLinuxEpochRecovery(c); } finally { fs.fsyncSync = real; }
    }), /injected target/);
    assert.equal(entered, 1, `recovery callback was not entered for ${target}`);
    assert.equal(injected, 1, `did not reach recovery sync stage for ${target}`);
    scope(c => requireLinuxEpochRecovery(c));
  }
  const synced = new Set();
  let entered = 0;
  scope(c => {
    entered++;
    fs.fsyncSync = fd => { const target = targetFor(fd); if (target) synced.add(target); return real(fd); };
    try { return requireLinuxEpochRecovery(c); } finally { fs.fsyncSync = real; }
  });
  assert.equal(entered, 1, "recovery callback was not entered");
  for (const target of [attempt, pointer, attempts, recovery, state]) assert.ok(synced.has(target), `not synced: ${target}`);
});

test("pointer damage and missing referenced attempt fail closed until fresh confirmation", { skip: process.platform !== "linux" }, t => {
  const { root, state, scope, confirmed } = fixture(t);
  fs.writeFileSync(path.join(state, "broker.lock"), "old");
  scope(c => createLinuxEpochRecovery(c, confirmed));
  const epoch = scope(c => c.epoch), dir = path.join(state, "linux-epoch-recovery-v1", epoch);
  const pointer = path.join(dir, "current.json");
  fs.writeFileSync(pointer, "{partial");
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
  fs.renameSync(pointer, path.join(root, "parked-pointer.json"));
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  scope(c => createLinuxEpochRecovery(c, confirmed));
  const current = JSON.parse(fs.readFileSync(pointer, "utf8"));
  fs.renameSync(path.join(dir, current.attempt), path.join(root, "parked-attempt.json"));
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
});

test("a clean initial epoch refuses missing baseline evidence", { skip: process.platform !== "linux" }, t => {
  const { root, state, scope, confirmed } = fixture(t);
  const epoch = scope(c => c.epoch), dir = path.join(state, "linux-epoch-recovery-v1", epoch);
  const pointer = path.join(dir, "current.json");
  const current = JSON.parse(fs.readFileSync(pointer, "utf8"));
  fs.renameSync(pointer, path.join(root, "missing-clean-pointer.json"));
  fs.renameSync(path.join(dir, current.attempt), path.join(root, "missing-clean-attempt.json"));
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
});

test("dangling pending symlink blocks both use and explicit recovery", { skip: process.platform !== "linux" }, t => {
  const { root, state, scope, confirmed } = fixture(t);
  const epoch = scope(c => c.epoch), pending = path.join(state, "linux-epoch-recovery-v1", epoch, "pending.json");
  fs.symlinkSync(path.join(root, "missing-intent-target"), pending);
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  assert.throws(() => scope(c => createLinuxEpochRecovery(c, confirmed)));
  assert.equal(fs.lstatSync(pending).isSymbolicLink(), true);
});

for (const fault of ["unavailable", "missing", "invalid", "duplicate"]) {
  test(`fdinfo ${fault} mount identity rejects recovery without modifying evidence`, { skip: process.platform !== "linux" }, t => {
    const { state, scope, confirmed } = fixture(t);
    const source = path.join(state, "broker.lock"), sourceBytes = Buffer.from("old pending owner");
    fs.writeFileSync(source, sourceBytes);
    const sourcePath = fs.realpathSync(source), epoch = scope(c => c.epoch);
    const pointer = path.join(state, "linux-epoch-recovery-v1", epoch, "current.json");
    const before = fs.statSync(pointer, { bigint: true }), pointerBytes = fs.readFileSync(pointer);
    for (const action of [c => snapshotLegacyAdmission(c), c => createLinuxEpochRecovery(c, confirmed)]) {
      const real = fs.readFileSync; let entered = 0, injected = 0, hadOriginal = true;
      assert.throws(() => scope(c => {
        entered++;
        fs.readFileSync = (file, ...args) => {
          const match = typeof file === "string" ? /^\/proc\/self\/fdinfo\/(\d+)$/.exec(file) : null;
          let opened = null;
          if (match) { try { opened = fs.realpathSync(`/proc/self/fd/${match[1]}`); } catch { /* 他の fd は変更しない。 */ } }
          if (opened !== sourcePath) return real(file, ...args);
          injected++;
          if (fault === "unavailable") { const error = new Error("injected missing fdinfo"); error.code = "ENOENT"; throw error; }
          const value = real(file, ...args);
          const lines = value.split("\n"), id = lines.find(line => line.startsWith("mnt_id"));
          if (!id) { hadOriginal = false; return value; }
          if (fault === "missing") return lines.filter(line => !line.startsWith("mnt_id")).join("\n");
          if (fault === "invalid") return lines.map(line => line.startsWith("mnt_id") ? "mnt_id:\tinvalid" : line).join("\n");
          return `${value}\n${id}\n`;
        };
        try { return action(c); } finally { fs.readFileSync = real; }
      }), /fd mount identity/);
      assert.equal(entered, 1, "recovery callback was not entered");
      assert.equal(injected, 1, `fdinfo ${fault} fault was not reached`);
      assert.equal(hadOriginal, true, "fixture fdinfo must initially contain a mount ID");
      const after = fs.statSync(pointer, { bigint: true });
      assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
      assert.ok(fs.readFileSync(pointer).equals(pointerBytes));
      assert.ok(fs.readFileSync(source).equals(sourceBytes));
    }
  });
}

test("initial pointer fsync failure requires explicit recovery even after the fault clears", { skip: process.platform !== "linux" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-initial-pointer-fsync-"));
  const cwd = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(cwd); fs.mkdirSync(data);
  const previous = [process.env.CLAUDE_PLUGIN_DATA, process.env.PLUGIN_DATA];
  process.env.CLAUDE_PLUGIN_DATA = data; process.env.PLUGIN_DATA = data;
  const state = resolveStateDir(cwd), recovery = path.join(state, "linux-epoch-recovery-v1");
  t.after(() => {
    try {
      if (fs.existsSync(path.join(state, "state.lock", "protocol.json"))) {
        shutdownPosixStateLockSentinel(state, { offlineConfirmed: true, expectedStateDir: state });
      }
    } finally {
      for (const [i, key] of ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].entries()) {
        if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
      }
      t.diagnostic(`Isolated fixture retained: ${root}`);
    }
  });
  const real = fs.fsyncSync; let injected = 0;
  fs.fsyncSync = fd => {
    let file;
    try { file = fs.realpathSync(`/proc/self/fd/${fd}`); } catch { return real(fd); }
    const relative = path.relative(recovery, file).split(path.sep);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (relative.length === 2 && /^[0-9a-f-]{36}$/.test(relative[0]) && stat.isFile() && stat.size <= 4096n) {
      let value;
      try { value = JSON.parse(fs.readFileSync(`/proc/self/fd/${fd}`, "utf8")); } catch { return real(fd); }
      if (value?.version === 1 && typeof value.attempt === "string" && /^[a-f0-9]{64}$/.test(value.sha256 ?? "")) {
        injected++;
        const error = new Error("injected initial pointer fsync EIO"); error.code = "EIO";
        throw error;
      }
    }
    return real(fd);
  };
  try {
    assert.throws(() => migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state }), /injected initial pointer fsync EIO/);
  } finally { fs.fsyncSync = real; }
  assert.equal(injected, 1, "initial pointer file fsync was not reached");
  const scope = fn => withStateSnapshot(cwd, (_state, context) => fn(context));
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  scope(c => createLinuxEpochRecovery(c, { offlineConfirmed: true, localOnly: true, expectedStateDir: state, allOldProcessesStopped: true }));
  scope(c => requireLinuxEpochRecovery(c));
});

test("initial interruption after pointer temp unlink retains an intent", { skip: process.platform !== "linux" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-initial-unlink-"));
  const cwd = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(cwd); fs.mkdirSync(data);
  const previous = [process.env.CLAUDE_PLUGIN_DATA, process.env.PLUGIN_DATA];
  process.env.CLAUDE_PLUGIN_DATA = data; process.env.PLUGIN_DATA = data;
  const state = resolveStateDir(cwd), recovery = path.join(state, "linux-epoch-recovery-v1");
  t.after(() => {
    try {
      if (fs.existsSync(path.join(state, "state.lock", "protocol.json"))) {
        shutdownPosixStateLockSentinel(state, { offlineConfirmed: true, expectedStateDir: state });
      }
    } finally {
      for (const [i, key] of ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].entries()) {
        if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
      }
      t.diagnostic(`Isolated fixture retained: ${root}`);
    }
  });
  const real = fs.unlinkSync; let injected = 0;
  fs.unlinkSync = file => {
    const target = fs.realpathSync(file), relative = path.relative(recovery, target).split(path.sep);
    if (relative.length === 2 && /^[0-9a-f-]{36}$/.test(relative[0]) && /^pointer-[0-9a-f-]{36}\.tmp$/.test(relative[1])) {
      const result = real(file); injected++;
      const error = new Error("injected after initial unlink EIO"); error.code = "EIO";
      throw error;
    }
    return real(file);
  };
  try {
    assert.throws(() => migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: state }), /injected after initial unlink EIO/);
  } finally { fs.unlinkSync = real; }
  assert.equal(injected, 1, "initial pointer temp unlink was not reached");
  const scope = fn => withStateSnapshot(cwd, (_state, context) => fn(context));
  const epoch = scope(c => c.epoch), dir = path.join(recovery, epoch);
  assert.equal(fs.statSync(path.join(dir, "current.json")).nlink, 1);
  assert.ok(fs.lstatSync(path.join(dir, "pending.json")).isFile());
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  scope(c => createLinuxEpochRecovery(c, { offlineConfirmed: true, localOnly: true, expectedStateDir: state, allOldProcessesStopped: true }));
  scope(c => requireLinuxEpochRecovery(c));
});

test("explicit recovery preserves the linked initial pointer after interruption", { skip: process.platform !== "linux" }, t => {
  const { scope, confirmed, temp, pointerStat } = linkedPointerFixture(t);
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
  const saved = fs.statSync(temp, { bigint: true });
  assert.equal(saved.dev, pointerStat.dev);
  assert.equal(saved.ino, pointerStat.ino);
  assert.equal(saved.nlink, 1n);
});

test("explicit recovery refuses an external hardlink to the interrupted pointer", { skip: process.platform !== "linux" }, t => {
  const { root, scope, confirmed, pointer, temp } = linkedPointerFixture(t);
  fs.linkSync(pointer, path.join(root, "external-pointer-link"));
  assert.equal(fs.statSync(temp).nlink, 3);
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  assert.throws(() => scope(c => createLinuxEpochRecovery(c, confirmed)));
});

test("explicit recovery refuses an interrupted pointer with a different temp inode", { skip: process.platform !== "linux" }, t => {
  const { root, scope, confirmed, temp } = linkedPointerFixture(t);
  const bytes = fs.readFileSync(temp);
  fs.renameSync(temp, path.join(root, "original-pointer-temp"));
  fs.writeFileSync(temp, bytes, { mode: 0o600 });
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  assert.throws(() => scope(c => createLinuxEpochRecovery(c, confirmed)));
});

test("a linked pointer changed during its fsync keeps the intent and blocks use", { skip: process.platform !== "linux" }, t => {
  const { scope, confirmed, dir, temp, pointerStat } = linkedPointerFixture(t);
  const real = fs.fsyncSync; let changed = 0;
  assert.throws(() => scope(c => {
    fs.fsyncSync = fd => {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!changed && stat.dev === pointerStat.dev && stat.ino === pointerStat.ino) {
        changed++;
        fs.writeFileSync(temp, "modified during pointer fsync");
      }
      return real(fd);
    };
    try { return createLinuxEpochRecovery(c, confirmed); } finally { fs.fsyncSync = real; }
  }));
  assert.equal(changed, 1, "old pointer fsync was not reached");
  assert.ok(fs.lstatSync(path.join(dir, "pending.json")).isFile());
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
});

for (const failure of ["old pointer verification", "parent fsync"]) {
  test(`post-rename ${failure} failure blocks use until explicit recovery`, { skip: process.platform !== "linux" }, t => {
    const { scope, confirmed, dir, pointer, temp, pointerStat } = linkedPointerFixture(t);
    const realRename = fs.renameSync, realFstat = fs.fstatSync, realFsync = fs.fsyncSync;
    let entered = 0, renamed = false, injected = 0;
    assert.throws(() => scope(c => {
      entered++;
      fs.renameSync = (source, destination) => {
        const result = realRename(source, destination);
        if (fs.realpathSync(destination) === pointer) renamed = true;
        return result;
      };
      fs.fstatSync = (fd, options) => {
        const stat = realFstat(fd, options);
        if (renamed && failure === "old pointer verification" && BigInt(stat.dev) === pointerStat.dev && BigInt(stat.ino) === pointerStat.ino) {
          injected++;
          const error = new Error("injected post-rename failure"); error.code = "EIO";
          throw error;
        }
        return stat;
      };
      fs.fsyncSync = fd => {
        if (renamed && failure === "parent fsync" && fs.realpathSync(`/proc/self/fd/${fd}`) === dir) {
          injected++;
          const error = new Error("injected post-rename failure"); error.code = "EIO";
          throw error;
        }
        return realFsync(fd);
      };
      try { return createLinuxEpochRecovery(c, confirmed); }
      finally { fs.renameSync = realRename; fs.fstatSync = realFstat; fs.fsyncSync = realFsync; }
    }), /injected post-rename failure/);
    assert.equal(entered, 1, "recovery callback was not entered");
    assert.equal(renamed, true, "pointer rename was not reached");
    assert.equal(injected, 1, "selected post-rename failure was not reached");
    assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
    scope(c => createLinuxEpochRecovery(c, confirmed));
    scope(c => requireLinuxEpochRecovery(c));
    assert.ok(fs.statSync(temp).isFile(), "the interrupted pointer temp must be preserved");
  });
}

for (const failure of ["intent open", "intent write", "intent fsync", "intent parent fsync", "old pointer fsync",
  "pointer rename", "inventory recheck", "intent unlink", "intent removal parent fsync"]) {
  test(`intent recovery handles ${failure} failure`, { skip: process.platform !== "linux" }, t => {
    const { scope, confirmed, state, dir, pointer, pointerStat } = linkedPointerFixture(t);
    const pending = path.join(dir, "pending.json"), real = {
      open: fs.openSync, write: fs.writeSync, fsync: fs.fsyncSync, rename: fs.renameSync,
      lstat: fs.lstatSync, unlink: fs.unlinkSync
    };
    const fdPath = fd => { try { return fs.realpathSync(`/proc/self/fd/${fd}`); } catch { return null; } };
    const targetPath = file => {
      if (typeof file !== "string") return null;
      try { return path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); } catch { return null; }
    };
    const isIntent = file => file === pending || (typeof file === "string" && path.dirname(file) === dir && /^pending-new-[0-9a-f-]{36}\.tmp$/.test(path.basename(file)));
    let entered = 0, injected = 0, intentSynced = false, renamed = false, removed = false;
    const inject = () => { injected++; const error = new Error(`injected ${failure} EIO`); error.code = "EIO"; throw error; };
    assert.throws(() => scope(c => {
      entered++;
      fs.openSync = (file, ...args) => {
        if (failure === "intent open" && isIntent(targetPath(file))) inject();
        return real.open(file, ...args);
      };
      fs.writeSync = (fd, ...args) => {
        if (failure === "intent write" && isIntent(fdPath(fd))) inject();
        return real.write(fd, ...args);
      };
      fs.fsyncSync = fd => {
        const file = fdPath(fd), stat = fs.fstatSync(fd, { bigint: true });
        if (failure === "intent fsync" && isIntent(file)) inject();
        if (failure === "intent parent fsync" && intentSynced && file === dir) inject();
        if (failure === "old pointer fsync" && stat.dev === pointerStat.dev && stat.ino === pointerStat.ino) inject();
        if (failure === "intent removal parent fsync" && removed && file === dir) inject();
        const result = real.fsync(fd);
        if (isIntent(file)) intentSynced = true;
        return result;
      };
      fs.renameSync = (source, destination) => {
        if (targetPath(destination) === pointer) {
          if (failure === "pointer rename") inject();
          const result = real.rename(source, destination); renamed = true; return result;
        }
        return real.rename(source, destination);
      };
      fs.lstatSync = (file, ...args) => {
        if (failure === "inventory recheck" && renamed && targetPath(file) === path.join(state, "broker.json")) inject();
        return real.lstat(file, ...args);
      };
      fs.unlinkSync = file => {
        if (targetPath(file) === pending) {
          if (failure === "intent unlink") inject();
          const result = real.unlink(file); removed = true; return result;
        }
        return real.unlink(file);
      };
      try { return createLinuxEpochRecovery(c, confirmed); }
      finally {
        fs.openSync = real.open; fs.writeSync = real.write; fs.fsyncSync = real.fsync;
        fs.renameSync = real.rename; fs.lstatSync = real.lstat; fs.unlinkSync = real.unlink;
      }
    }), /injected .* EIO/);
    assert.equal(entered, 1, "recovery callback was not entered");
    assert.equal(injected, 1, `failpoint was not reached: ${failure}`);
    if (failure !== "intent removal parent fsync") {
      assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
    } else {
      // unlink 後の同期失敗は、再読取側が全対象を再同期できた場合のみ許容する。
      const current = JSON.parse(fs.readFileSync(pointer, "utf8"));
      const targets = [path.join(dir, current.attempt), pointer, dir, path.dirname(dir), state];
      const synced = new Set(); let allowed = false;
      try {
        scope(c => {
          fs.fsyncSync = fd => {
            const file = fdPath(fd), index = targets.indexOf(file);
            if (index >= 0 && targets.slice(0, index).every(previous => synced.has(previous))) synced.add(file);
            return real.fsync(fd);
          };
          try { return requireLinuxEpochRecovery(c); } finally { fs.fsyncSync = real.fsync; }
        });
        allowed = true;
      } catch { /* 同期・再照合できなければ fail closed も許容する。 */ }
      if (allowed) for (const target of targets) assert.ok(synced.has(target), `not re-synced: ${target}`);
    }
    scope(c => createLinuxEpochRecovery(c, confirmed));
    scope(c => requireLinuxEpochRecovery(c));
  });
}

test("interrupted intent archival preserves evidence and permits a confirmed retry", { skip: process.platform !== "linux" }, t => {
  const { scope, confirmed, dir } = linkedPointerFixture(t);
  const pending = path.join(dir, "pending.json"), realFsync = fs.fsyncSync;
  const fdPath = fd => { try { return fs.realpathSync(`/proc/self/fd/${fd}`); } catch { return null; } };
  let fileFault = 0;
  assert.throws(() => scope(c => {
    fs.fsyncSync = fd => {
      if (fdPath(fd) === pending) {
        fileFault++; const error = new Error("injected pending fsync EIO"); error.code = "EIO"; throw error;
      }
      return realFsync(fd);
    };
    try { return createLinuxEpochRecovery(c, confirmed); } finally { fs.fsyncSync = realFsync; }
  }), /injected pending fsync EIO/);
  assert.equal(fileFault, 1);
  const old = fs.statSync(pending, { bigint: true }), oldBytes = fs.readFileSync(pending);
  let archiveFault = 0;
  assert.throws(() => scope(c => {
    fs.fsyncSync = fd => {
      const file = fdPath(fd);
      if (file && path.dirname(file) === dir && /^pending-archive-[0-9a-f-]{36}\.json$/.test(path.basename(file))) {
        archiveFault++; const error = new Error("injected archive fsync EIO"); error.code = "EIO"; throw error;
      }
      return realFsync(fd);
    };
    try { return createLinuxEpochRecovery(c, confirmed); } finally { fs.fsyncSync = realFsync; }
  }), /injected archive fsync EIO/);
  assert.equal(archiveFault, 1);
  assert.throws(() => scope(c => requireLinuxEpochRecovery(c)));
  const synced = new Set();
  scope(c => {
    fs.fsyncSync = fd => { const file = fdPath(fd); if (file) synced.add(file); return realFsync(fd); };
    try { return createLinuxEpochRecovery(c, confirmed); } finally { fs.fsyncSync = realFsync; }
  });
  scope(c => requireLinuxEpochRecovery(c));
  const archives = fs.readdirSync(dir).filter(name => /^pending-archive-[0-9a-f-]{36}\.json$/.test(name));
  const saved = archives.filter(name => {
    const file = path.join(dir, name), stat = fs.lstatSync(file, { bigint: true });
    return stat.isFile() && (stat.dev !== old.dev || stat.ino !== old.ino) && fs.readFileSync(file).equals(oldBytes);
  });
  assert.ok(saved.length >= 2, "both failed and successful archive copies must be retained as separate inodes");
  assert.ok(saved.some(name => synced.has(path.join(dir, name))), "a successful archive copy must be fsynced");
  assert.ok(synced.has(dir), "the archive parent must be fsynced");
  const originalLinks = fs.readdirSync(dir).filter(name => {
    const stat = fs.lstatSync(path.join(dir, name), { bigint: true });
    return stat.isFile() && stat.dev === old.dev && stat.ino === old.ino && stat.nlink === 1n;
  });
  assert.equal(originalLinks.length, 1, "the original pending inode must also be retained");
});

for (const kind of ["initial", "replacement"]) {
  test(`partial ${kind} pending write remains blocked and is preserved on retry`, { skip: process.platform !== "linux" }, t => {
    const f = kind === "initial" ? fixture(t) : linkedPointerFixture(t);
    const epoch = f.scope(c => c.epoch), dir = path.join(f.state, "linux-epoch-recovery-v1", epoch);
    const pending = path.join(dir, "pending.json"), pointer = path.join(dir, "current.json");
    const oldPointer = fs.statSync(pointer, { bigint: true }), pointerBytes = fs.readFileSync(pointer);
    const oldPending = kind === "replacement" ? fs.statSync(pending, { bigint: true }) : null;
    const oldPendingBytes = kind === "replacement" ? fs.readFileSync(pending) : null;
    const realWrite = fs.writeSync; let entered = 0, writes = 0, partial = null;
    assert.throws(() => f.scope(c => {
      entered++;
      fs.writeSync = (fd, ...args) => {
        let file;
        try { file = fs.realpathSync(`/proc/self/fd/${fd}`); } catch { return realWrite(fd, ...args); }
        const targeted = kind === "initial" ? file === pending :
          path.dirname(file) === dir && /^pending-new-[0-9a-f-]{36}\.tmp$/.test(path.basename(file));
        if (!targeted) return realWrite(fd, ...args);
        partial = file; writes++;
        if (writes === 1) {
          const [data, offset, length, position] = args;
          return realWrite(fd, data, offset, Math.max(1, Math.floor(length / 2)), position);
        }
        const error = new Error("injected partial pending EIO"); error.code = "EIO"; throw error;
      };
      try { return createLinuxEpochRecovery(c, f.confirmed); } finally { fs.writeSync = realWrite; }
    }), /injected partial pending EIO/);
    assert.equal(entered, 1, "recovery callback was not entered");
    assert.equal(writes, 2, "short write and EIO were not reached");
    const fragment = fs.readFileSync(partial), partialStat = fs.statSync(partial, { bigint: true });
    assert.ok(fragment.length > 0, "partial pending bytes must remain visible");
    assert.throws(() => JSON.parse(fragment.toString("utf8")), "the saved fragment must be incomplete");
    const pendingStat = fs.statSync(pending, { bigint: true }), pendingBytes = fs.readFileSync(pending);
    if (oldPending) {
      assert.equal(pendingStat.dev, oldPending.dev); assert.equal(pendingStat.ino, oldPending.ino);
      assert.ok(pendingBytes.equals(oldPendingBytes));
    } else {
      assert.equal(pendingStat.dev, partialStat.dev); assert.equal(pendingStat.ino, partialStat.ino);
      assert.ok(pendingBytes.equals(fragment));
    }
    const afterPointer = fs.statSync(pointer, { bigint: true });
    assert.equal(afterPointer.dev, oldPointer.dev); assert.equal(afterPointer.ino, oldPointer.ino);
    assert.ok(fs.readFileSync(pointer).equals(pointerBytes));
    assert.throws(() => f.scope(c => requireLinuxEpochRecovery(c)));
    const realFsync = fs.fsyncSync, events = [];
    f.scope(c => {
      fs.fsyncSync = fd => {
        try { events.push(fs.realpathSync(`/proc/self/fd/${fd}`)); } catch { /* 取得できない fd は証拠にしない。 */ }
        return realFsync(fd);
      };
      try { return createLinuxEpochRecovery(c, f.confirmed); } finally { fs.fsyncSync = realFsync; }
    });
    f.scope(c => requireLinuxEpochRecovery(c));
    if (kind === "replacement") {
      const retained = fs.statSync(partial, { bigint: true });
      assert.equal(retained.dev, partialStat.dev); assert.equal(retained.ino, partialStat.ino);
      assert.ok(fs.readFileSync(partial).equals(fragment));
    }
    const entries = fs.readdirSync(dir).map(name => {
      const file = path.join(dir, name), stat = fs.lstatSync(file, { bigint: true });
      return { file, stat };
    });
    const originals = entries.filter(({ file, stat }) => stat.isFile() && stat.dev === pendingStat.dev && stat.ino === pendingStat.ino && fs.readFileSync(file).equals(pendingBytes));
    assert.equal(originals.length, 1, "the interrupted pending inode and bytes must be preserved");
    const archives = entries.filter(({ file, stat }) => stat.isFile() && /^pending-archive-[0-9a-f-]{36}\.json$/.test(path.basename(file)) &&
      (stat.dev !== pendingStat.dev || stat.ino !== pendingStat.ino) && stat.size === BigInt(pendingBytes.length) && fs.readFileSync(file).equals(pendingBytes));
    assert.ok(archives.some(({ file }) => {
      const index = events.indexOf(file);
      return index >= 0 && events.slice(index + 1).includes(dir);
    }), "a separate pending copy and then its parent must be fsynced");
  });
}

for (const kind of ["pending", "pointer"]) {
  test(`partial ${kind} archive write preserves evidence and permits a confirmed retry`, { skip: process.platform !== "linux" }, t => {
    let f, dir, source;
    if (kind === "pending") {
      f = linkedPointerFixture(t);
      dir = f.dir;
      source = path.join(dir, "pending.json");
    } else {
      f = fixture(t);
      f.scope(c => createLinuxEpochRecovery(c, f.confirmed));
      const epoch = f.scope(c => c.epoch);
      dir = path.join(f.state, "linux-epoch-recovery-v1", epoch);
      source = path.join(dir, "current.json");
    }
    const original = fs.statSync(source, { bigint: true }), bytes = fs.readFileSync(source);
    assert.ok(bytes.length > 1, "fixture must contain a nonempty archive source");
    const realWrite = fs.writeSync, archiveName = new RegExp(`^${kind}-archive-[0-9a-f-]{36}\\.json$`);
    let entered = 0, writes = 0, partial = null;
    assert.throws(() => f.scope(c => {
      entered++;
      fs.writeSync = (fd, ...args) => {
        let file;
        try { file = fs.realpathSync(`/proc/self/fd/${fd}`); } catch { return realWrite(fd, ...args); }
        if (path.dirname(file) === dir && archiveName.test(path.basename(file))) {
          partial = file;
          writes++;
          if (writes === 1) {
            const [data, offset, length, position] = args;
            return realWrite(fd, data, offset, Math.max(1, Math.floor(length / 2)), position);
          }
          const error = new Error(`injected partial ${kind} archive EIO`); error.code = "EIO";
          throw error;
        }
        return realWrite(fd, ...args);
      };
      try { return createLinuxEpochRecovery(c, f.confirmed); } finally { fs.writeSync = realWrite; }
    }), /injected partial .* archive EIO/);
    assert.equal(entered, 1, "recovery callback was not entered");
    assert.equal(writes, 2, "short write and subsequent failure were not reached");
    const fragment = fs.readFileSync(partial), partialStat = fs.statSync(partial, { bigint: true });
    assert.ok(fragment.length > 0 && fragment.length < bytes.length);
    assert.ok(bytes.subarray(0, fragment.length).equals(fragment));
    const still = fs.statSync(source, { bigint: true });
    assert.equal(still.dev, original.dev); assert.equal(still.ino, original.ino);
    assert.ok(fs.readFileSync(source).equals(bytes));
    assert.throws(() => f.scope(c => requireLinuxEpochRecovery(c)));
    const realFsync = fs.fsyncSync, events = [];
    f.scope(c => {
      fs.fsyncSync = fd => {
        try { events.push(fs.realpathSync(`/proc/self/fd/${fd}`)); } catch { /* 取得できない fd は証拠にしない。 */ }
        return realFsync(fd);
      };
      try { return createLinuxEpochRecovery(c, f.confirmed); } finally { fs.fsyncSync = realFsync; }
    });
    f.scope(c => requireLinuxEpochRecovery(c));
    const retained = fs.statSync(partial, { bigint: true });
    assert.equal(retained.dev, partialStat.dev); assert.equal(retained.ino, partialStat.ino);
    assert.ok(fs.readFileSync(partial).equals(fragment), "partial archive must remain unchanged");
    const entries = fs.readdirSync(dir).map(name => {
      const file = path.join(dir, name), stat = fs.lstatSync(file, { bigint: true });
      return { file, stat };
    });
    const originals = entries.filter(({ file, stat }) => stat.isFile() && stat.dev === original.dev && stat.ino === original.ino && fs.readFileSync(file).equals(bytes));
    assert.equal(originals.length, 1, "the original source inode must remain preserved");
    const copies = entries.filter(({ file, stat }) => stat.isFile() && archiveName.test(path.basename(file)) &&
      (stat.dev !== original.dev || stat.ino !== original.ino) && stat.size === BigInt(bytes.length) && fs.readFileSync(file).equals(bytes));
    assert.ok(copies.some(({ file }) => {
      const index = events.indexOf(file);
      return index >= 0 && events.slice(index + 1).includes(dir);
    }), "a complete independent archive copy and then its parent must be fsynced");
  });
}

test("preserved failed attempts do not prevent a new confirmation", { skip: process.platform !== "linux" }, t => {
  const { state, scope, confirmed } = fixture(t);
  fs.writeFileSync(path.join(state, "broker.lock"), "old");
  const epoch = scope(c => c.epoch), dir = path.join(state, "linux-epoch-recovery-v1", epoch);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 260; i++) fs.writeFileSync(path.join(dir, `${randomUUID()}.json`), "{partial");
  const large = path.join(dir, `${randomUUID()}.json`);
  const fd = fs.openSync(large, "wx");
  try { fs.ftruncateSync(fd, 65 * 1024 * 1024); } finally { fs.closeSync(fd); }
  scope(c => createLinuxEpochRecovery(c, confirmed));
  scope(c => requireLinuxEpochRecovery(c));
  assert.equal(fs.statSync(large).size, 65 * 1024 * 1024);
});

test("recovery handles maximum markers and a maximum broker journal", { skip: process.platform !== "linux", timeout: 60000 }, t => {
  const { state, scope, confirmed } = fixture(t);
  const direct = path.join(state, "direct-start-v1"), broker = path.join(state, "broker-v2");
  fs.mkdirSync(direct); fs.mkdirSync(broker);
  const marker = Buffer.alloc(24576, 120);
  for (let i = 0; i < 256; i++) fs.writeFileSync(path.join(direct, `${randomUUID()}.jsonl`), marker);
  fs.writeFileSync(path.join(broker, "broker-admission.jsonl"), Buffer.alloc(4 * 1024 * 1024, 120));
  const options = { timeoutMs: 30000 };
  scope(c => createLinuxEpochRecovery(c, confirmed), options);
  scope(c => requireLinuxEpochRecovery(c), options);
});
