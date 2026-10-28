import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { acquireDarwinWorkerLease, withAvailableDarwinLease } from "../plugins/grok/scripts/lib/darwin-worker-lease.mjs";
import * as primitive from "../plugins/grok/scripts/lib/darwin-worker-lease.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 故障条件: 生存中の worker を終了と誤判定、PID 再利用、競合 FD を
// 早期 close、別 inode・リンク・不正な内容を終了証拠にする、子が FD を継承する。
// 呼出側は state mutex を保持し、callback 内で epoch・両 record・名前/inode を再照合する。
// worker は lease -> state mutex、sweep は state mutex -> 非待機 lease の順で取得する。
const darwin = { skip: process.platform !== "darwin", timeout: 20000 };
const generation = "11111111-1111-4111-8111-111111111111";
function context(expectedDirectory) {
  const stat = fs.lstatSync(expectedDirectory, { bigint: true });
  return { stateGeneration: generation, expectedDirectory, expectedDirectoryIdentity: { dev: String(stat.dev), ino: String(stat.ino) } };
}
function acquire(directory, slot) {
  return acquireDarwinWorkerLease({ directory, stateGeneration: generation, slot, expectedDirectoryIdentity: context(directory).expectedDirectoryIdentity });
}
const fixtures = new Map();

function setup(t) {
  const directory = makeTempDir("grok-darwin-lease-primitive-");
  const fixture = { children: [], descendantMarkers: [] };
  fixtures.set(directory, fixture);
  t.after(async () => {
    for (const { child, closed, mustFinishNaturally } of fixture.children) {
      if (mustFinishNaturally && child.exitCode === null && child.signalCode === null) {
        let timer;
        const finished = await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 12000); })]);
        clearTimeout(timer);
        if (!finished) {
          child.kill("SIGKILL");
          await closed;
          assert.fail(`utility owner did not finish; retained ${directory}`);
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGCONT");
        child.kill("SIGKILL");
      }
      await closed;
    }
    for (const marker of fixture.descendantMarkers) {
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(fs.existsSync(marker), `descendant did not finish; retained ${directory}`);
    }
    removeTempFixture(directory, { recursive: true, force: true });
    fixtures.delete(directory);
  });
  return directory;
}

async function start(t, directory, options = {}) {
  const child = fork(new URL("./fixtures/darwin-worker-lease-primitive-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  const fixture = fixtures.get(directory);
  fixture.children.push({ child, closed });
  if (options.descendantMarker) fixture.descendantMarkers.push(options.descendantMarker);
  child.send({ directory, stateGeneration: generation, ...options });
  const [message] = await once(child, "message");
  assert.equal(message.type, "acquired", JSON.stringify(message));
  return { child, closed, lease: message.lease, message };
}

function unavailable(lease, ctx = context(path.dirname(lease.path))) {
  let calls = 0;
  assert.deepEqual(withAvailableDarwinLease(lease, ctx, () => { calls++; }), { status: "unknown" });
  assert.equal(calls, 0);
}

async function waitStopped(child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const ps = spawnSync("/bin/ps", ["-o", "state=", "-p", String(child.pid)], { encoding: "utf8", timeout: 1000 });
    assert.ifError(ps.error);
    assert.equal(ps.status, 0);
    if (/^T/.test(ps.stdout.trim())) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("direct child did not enter a stopped state");
}

test("a stopped worker holds a private lease until its own process exits", darwin, async t => {
  const directory = setup(t);
  const owner = await start(t, directory);
  const { lease } = owner;
  assert.match(lease.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  assert.equal(lease.stateGeneration, generation);
  assert.equal(lease.slot, 0);
  assert.equal(path.basename(lease.path), "slot-000.lease");
  assert.equal(path.dirname(lease.path), directory);
  const stat = fs.lstatSync(lease.path, { bigint: true });
  assert.ok(stat.isFile());
  assert.equal(stat.uid, BigInt(process.getuid()));
  assert.equal(stat.mode & 0o077n, 0n);
  assert.equal(stat.nlink, 1n);
  assert.equal(String(stat.dev), lease.dev);
  assert.equal(String(stat.ino), lease.ino);
  assert.equal(fs.readFileSync(lease.path, "utf8").trim(), lease.id);
  owner.child.kill("SIGSTOP");
  await waitStopped(owner.child);
  unavailable(lease);
  // 同一ファイルを別 FD で開閉しても所有 FD のロックは維持される。
  fs.appendFileSync(lease.path, "");
  unavailable(lease);
  owner.child.kill("SIGKILL");
  await owner.closed;
  assert.deepEqual(withAvailableDarwinLease(lease, context(directory), () => "observed"), { status: "available", value: "observed" });
});

test("the observer holds its own lock through the synchronous callback", darwin, async t => {
  const directory = setup(t);
  const owner = await start(t, directory);
  owner.child.kill("SIGKILL");
  await owner.closed;
  const result = withAvailableDarwinLease(owner.lease, context(directory), () => {
    unavailable(owner.lease);
    const fd = fs.openSync(owner.lease.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const probe = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], {
        stdio: ["ignore", "pipe", "pipe", fd], timeout: 2000
      });
      assert.ifError(probe.error);
      assert.equal(probe.signal, null);
      assert.equal(probe.status, 75);
    } finally { fs.closeSync(fd); }
    return 42;
  });
  assert.deepEqual(result, { status: "available", value: 42 });
  assert.deepEqual(withAvailableDarwinLease(owner.lease, context(directory), () => true), { status: "available", value: true });
  assert.throws(() => withAvailableDarwinLease(owner.lease, context(directory), () => Promise.resolve()), /synchronous|thenable|async/i);
  assert.deepEqual(withAvailableDarwinLease(owner.lease, context(directory), () => true), { status: "available", value: true });
  assert.throws(() => withAvailableDarwinLease(owner.lease, context(directory), () => { throw new Error("callback failure"); }), /callback failure/);
  assert.deepEqual(withAvailableDarwinLease(owner.lease, context(directory), () => true), { status: "available", value: true });
});

test("unverifiable identity or permissions never invokes the callback", darwin, async t => {
  const directory = setup(t);
  const owner = await start(t, directory);
  owner.child.kill("SIGKILL");
  await owner.closed;
  const lease = owner.lease;
  unavailable({ ...lease, id: "22222222-2222-4222-8222-222222222222" });
  unavailable({ ...lease, ino: String(BigInt(lease.ino) + 1n) });
  unavailable({ ...lease, slot: 1 });
  unavailable({ ...lease, slot: undefined });
  unavailable(lease, { ...context(directory), stateGeneration: "22222222-2222-4222-8222-222222222222" });
  unavailable(lease, { stateGeneration: generation, expectedDirectory: directory });
  unavailable(lease, { ...context(directory), expectedDirectoryIdentity: { ...context(directory).expectedDirectoryIdentity, ino: "1" } });
  unavailable(lease, { ...context(directory), expectedDirectoryIdentity: { ...context(directory).expectedDirectoryIdentity, dev: String(BigInt(context(directory).expectedDirectoryIdentity.dev) + 1n) } });
  fs.chmodSync(lease.path, 0o644);
  try { unavailable(lease); } finally { fs.chmodSync(lease.path, 0o600); }
  const alias = path.join(directory, "hardlink");
  fs.linkSync(lease.path, alias);
  try { unavailable(lease); } finally { fs.unlinkSync(alias); }
  // 名前の構文検査を通し、リンクと欠落の検査まで到達させる。
  const alternateDirectory = path.join(directory, "alternate");
  fs.mkdirSync(alternateDirectory, { mode: 0o700 });
  const symlink = path.join(alternateDirectory, path.basename(lease.path));
  fs.symlinkSync(lease.path, symlink);
  try { unavailable({ ...lease, path: symlink }); } finally { fs.unlinkSync(symlink); }
  const bytes = fs.readFileSync(lease.path);
  fs.writeFileSync(lease.path, "22222222-2222-4222-8222-222222222222");
  try { unavailable(lease); } finally { fs.writeFileSync(lease.path, bytes); }
  unavailable({ ...lease, path: symlink });
});

test("a descendant without the owner FD cannot keep the lease locked", darwin, async t => {
  const directory = setup(t);
  const marker = path.join(directory, "descendant-exited");
  const owner = await start(t, directory, { descendantMarker: marker });
  owner.child.kill("SIGKILL");
  await owner.closed;
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(withAvailableDarwinLease(owner.lease, context(directory), () => true), { status: "available", value: true });
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(marker), "descendant did not finish");
});

test("independent acquisitions produce distinct exclusively created files", darwin, t => {
  const directory = setup(t);
  const first = acquire(directory, 0);
  const second = acquire(directory, 1);
  try {
    assert.notEqual(first.lease.id, second.lease.id);
    assert.notEqual(first.lease.path, second.lease.path);
    assert.notEqual(first.lease.ino, second.lease.ino);
    unavailable(first.lease);
    unavailable(second.lease);
  } finally {
    fs.closeSync(first.fd);
    fs.closeSync(second.fd);
  }
});

test("an authentic lease outside the expected directory cannot invoke the callback", darwin, t => {
  const directory = setup(t);
  const otherDirectory = path.join(directory, "other");
  fs.mkdirSync(otherDirectory, { mode: 0o700 });
  const owner = acquire(otherDirectory, 0);
  fs.closeSync(owner.fd);
  // この lease は名前・内容・識別情報が正しいが、検証済み領域には属さない。
  unavailable(owner.lease, context(directory));
  assert.deepEqual(withAvailableDarwinLease(owner.lease, context(otherDirectory), () => true), { status: "available", value: true });
});

test("a lock utility ignoring SIGTERM is killed and reaped after the timeout", darwin, async t => {
  const directory = setup(t);
  const marker = path.join(directory, "fake-lockf-started");
  const child = fork(new URL("./fixtures/darwin-worker-lease-primitive-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  fixtures.get(directory).children.push({ child, closed, mustFinishNaturally: true });
  child.send({ directory, stateGeneration: generation, fakeLockf: marker });
  const [message] = await once(child, "message");
  await closed;
  assert.equal(message.type, "timeout-probed", JSON.stringify(message));
  assert.equal(message.started, true, "fake utility must install its SIGTERM handler");
  assert.deepEqual(message.result, { status: "unknown" });
  assert.equal(message.called, false);
  assert.equal(message.killSignal, "SIGKILL");
  assert.deepEqual(message.utilityResult, { errorCode: "ETIMEDOUT", signal: "SIGKILL" });
  assert.ok(message.elapsedMs < 6500, `probe took ${message.elapsedMs}ms`);
});

for (const probeTimeoutMs of [0, 500]) test(`observer respects a ${probeTimeoutMs}ms remaining budget`, darwin, async t => {
  const directory = setup(t);
  const marker = path.join(directory, "fake-lockf-started");
  const child = fork(new URL("./fixtures/darwin-worker-lease-primitive-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  fixtures.get(directory).children.push({ child, closed, mustFinishNaturally: true });
  child.send({ directory, stateGeneration: generation, fakeLockf: marker, probeTimeoutMs });
  const [message] = await once(child, "message");
  await closed;
  assert.equal(message.type, "timeout-probed", JSON.stringify(message));
  assert.deepEqual(message.result, { status: "unknown" });
  assert.equal(message.called, false);
  if (probeTimeoutMs === 0) {
    assert.equal(message.started, false, "an expired budget must not start the utility");
    assert.equal(message.utilityTimeout, undefined);
  } else {
    assert.equal(message.started, true, "fake utility must start before its timeout");
    assert.ok(message.utilityTimeout >= 1 && message.utilityTimeout <= probeTimeoutMs);
    assert.deepEqual(message.utilityResult, { errorCode: "ETIMEDOUT", signal: "SIGKILL" });
    assert.ok(message.elapsedMs < 1700, `probe took ${message.elapsedMs}ms`);
  }
});

test("owned lease revalidation rejects changed FD, name, directory, generation and contents", darwin, t => {
  const root = setup(t);
  const directory = path.join(root, "leases");
  fs.mkdirSync(directory, { mode: 0o700 });
  const verify = primitive.validateOwnedDarwinWorkerLease;
  assert.equal(typeof verify, "function", "owned lease revalidation API must be exported");
  const first = acquire(directory, 0);
  const second = acquire(directory, 1);
  let firstOpen = true;
  const args = { fd: first.fd, lease: first.lease, ...context(directory) };
  const check = changes => assert.throws(() => verify({ ...args, ...changes }));
  try {
    assert.equal(verify(args), true);
    assert.equal(fs.fstatSync(first.fd, { bigint: true }).ino, BigInt(first.lease.ino));
    check({ fd: second.fd });
    check({ stateGeneration: "22222222-2222-4222-8222-222222222222" });
    check({ expectedDirectoryIdentity: { ...args.expectedDirectoryIdentity, ino: String(BigInt(args.expectedDirectoryIdentity.ino) + 1n) } });
    check({ expectedDirectoryIdentity: { ...args.expectedDirectoryIdentity, dev: String(BigInt(args.expectedDirectoryIdentity.dev) + 1n) } });
    check({ expectedDirectory: root });
    check({ lease: { ...first.lease, id: "22222222-2222-4222-8222-222222222222" } });
    check({ lease: { ...first.lease, slot: 1 } });
    check({ lease: { ...first.lease, slot: undefined } });

    const original = fs.readFileSync(first.lease.path);
    fs.writeFileSync(first.lease.path, "22222222-2222-4222-8222-222222222222");
    try { check({}); } finally { fs.writeFileSync(first.lease.path, original); }
    fs.chmodSync(first.lease.path, 0o644);
    try { check({}); } finally { fs.chmodSync(first.lease.path, 0o600); }
    const alias = path.join(directory, "alias");
    fs.linkSync(first.lease.path, alias);
    try { check({}); } finally { fs.unlinkSync(alias); }

    const moved = path.join(directory, "moved");
    fs.renameSync(first.lease.path, moved);
    try {
      check({});
      fs.symlinkSync(moved, first.lease.path);
      try { check({}); } finally { fs.unlinkSync(first.lease.path); }
      const fifo = spawnSync("/usr/bin/mkfifo", [first.lease.path], { timeout: 2000 });
      assert.ifError(fifo.error);
      assert.equal(fifo.status, 0);
      try { check({}); } finally { fs.unlinkSync(first.lease.path); }
      fs.writeFileSync(first.lease.path, original, { mode: 0o600 });
      try { check({}); } finally { fs.unlinkSync(first.lease.path); }
    } finally { fs.renameSync(moved, first.lease.path); }

    const movedDirectory = path.join(root, "moved-leases");
    fs.renameSync(directory, movedDirectory);
    fs.mkdirSync(directory, { mode: 0o700 });
    try { check({}); } finally {
      fs.rmdirSync(directory);
      fs.renameSync(movedDirectory, directory);
    }
    assert.equal(verify(args), true);
    fs.closeSync(first.fd);
    firstOpen = false;
    check({});
  } finally {
    if (firstOpen) fs.closeSync(first.fd);
    fs.closeSync(second.fd);
  }
});

test("a fixed slot cannot be replaced while its original lease exists", darwin, t => {
  const directory = setup(t);
  const expectedDirectoryIdentity = context(directory).expectedDirectoryIdentity;
  const args = { directory, stateGeneration: generation, slot: 0, expectedDirectoryIdentity };
  const first = acquireDarwinWorkerLease(args);
  let second;
  try {
    const before = fs.statSync(first.lease.path, { bigint: true });
    const bytes = fs.readFileSync(first.lease.path);
    assert.throws(() => { second = acquireDarwinWorkerLease(args); });
    const after = fs.statSync(first.lease.path, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.deepEqual(fs.readFileSync(first.lease.path), bytes);
  } finally {
    if (second) fs.closeSync(second.fd);
    fs.closeSync(first.fd);
  }
});

test("invalid slot and unverified directory identity cannot allocate a lease", darwin, t => {
  const directory = setup(t);
  const expectedDirectoryIdentity = context(directory).expectedDirectoryIdentity;
  const args = { directory, stateGeneration: generation, slot: 0, expectedDirectoryIdentity };
  for (const changes of [
    { slot: -1 },
    { slot: 0.5 },
    { slot: 256 },
    { slot: Number.MAX_SAFE_INTEGER },
    { slot: undefined },
    { expectedDirectoryIdentity: undefined },
    { expectedDirectoryIdentity: { ...expectedDirectoryIdentity, ino: String(BigInt(expectedDirectoryIdentity.ino) + 1n) } },
    { expectedDirectoryIdentity: { ...expectedDirectoryIdentity, dev: String(BigInt(expectedDirectoryIdentity.dev) + 1n) } }
  ]) {
    let owner;
    try { assert.throws(() => { owner = acquireDarwinWorkerLease({ ...args, ...changes }); }); }
    finally { if (owner) fs.closeSync(owner.fd); }
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});

test("fixed slot names and range use one exported capacity", darwin, t => {
  const directory = setup(t);
  assert.equal(primitive.DARWIN_LEASE_SLOT_COUNT, 256);
  const owner = acquire(directory, 255);
  try {
    assert.equal(owner.lease.slot, 255);
    assert.equal(path.basename(owner.lease.path), "slot-255.lease");
    assert.equal(primitive.validateOwnedDarwinWorkerLease({ fd: owner.fd, lease: owner.lease, ...context(directory) }), true);
    unavailable(owner.lease);
  } finally { fs.closeSync(owner.fd); }
});

test("legacy UUID-named files are not accepted as fixed slots", darwin, t => {
  const directory = setup(t);
  const id = "22222222-2222-4222-8222-222222222222";
  const legacy = path.join(directory, `${id}.lease`);
  fs.writeFileSync(legacy, id, { mode: 0o600, flag: "wx" });
  const stat = fs.lstatSync(legacy, { bigint: true });
  const lease = { id, path: legacy, dev: String(stat.dev), ino: String(stat.ino), stateGeneration: generation };
  unavailable(lease, context(directory));
  // slot が妥当でも旧 UUID 名は固定 slot 名として受理しない。
  unavailable({ ...lease, slot: 0 }, context(directory));
  const after = fs.lstatSync(legacy, { bigint: true });
  assert.equal(after.ino, stat.ino);
  assert.equal(fs.readFileSync(legacy, "utf8"), id);
});

for (const failFsync of ["file", "directory"]) test(`failed ${failFsync} fsync cannot publish a slot lease`, darwin, async t => {
  const directory = setup(t);
  const child = fork(new URL("./fixtures/darwin-worker-lease-primitive-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  fixtures.get(directory).children.push({ child, closed });
  child.send({ directory, stateGeneration: generation, failFsync });
  const [message] = await once(child, "message");
  assert.equal(message.type, "sync-failed", JSON.stringify(message));
  assert.equal(message.fsyncInjected, true);
  assert.equal(message.code, "EIO");
  assert.equal(child.exitCode, null, "owner process must still be alive during the probe");
  assert.deepEqual(fs.readdirSync(directory), ["slot-000.lease"], "an uncertain slot must be retained for inspection");
  const file = path.join(directory, "slot-000.lease");
  const before = fs.lstatSync(file, { bigint: true });
  const bytes = fs.readFileSync(file, "utf8");
  assert.match(bytes, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const probe = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], {
      stdio: ["ignore", "pipe", "pipe", fd], timeout: 2000, killSignal: "SIGKILL"
    });
    assert.ifError(probe.error);
    assert.equal(probe.signal, null);
    assert.equal(probe.status, 0, "failed acquisition must close its FD before process exit");
  } finally { fs.closeSync(fd); }
  const after = fs.lstatSync(file, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  child.send("release");
  await closed;
});

test("successful acquisition synchronizes the file before its directory", darwin, async t => {
  const directory = setup(t);
  const owner = await start(t, directory, { auditFsync: true });
  assert.deepEqual(owner.message.fsyncCalls, ["file", "directory"]);
  owner.child.send("release");
  await owner.closed;
});

test("a restrictive umask cannot publish a lease unreadable to a later observer", darwin, async t => {
  const directory = setup(t);
  const child = fork(new URL("./fixtures/darwin-worker-lease-primitive-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  fixtures.get(directory).children.push({ child, closed });
  child.send({ directory, stateGeneration: generation, restrictiveUmask: true });
  const [message] = await once(child, "message");
  if (message.type === "acquired") {
    const stat = fs.lstatSync(message.lease.path, { bigint: true });
    assert.equal(stat.mode & 0o400n, 0n);
    child.send("release");
    await closed;
    let observerFd;
    try { assert.throws(() => { observerFd = fs.openSync(message.lease.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }, { code: "EACCES" }); }
    finally { if (observerFd !== undefined) fs.closeSync(observerFd); }
    unavailable(message.lease);
    assert.fail("acquisition returned a lease that cannot be read after its owner exits");
  }
  assert.equal(message.type, "error", JSON.stringify(message));
  await closed;
  const names = fs.readdirSync(directory);
  assert.ok(names.length === 0 || (names.length === 1 && names[0] === "slot-000.lease"));
  if (names.length) {
    const stat = fs.lstatSync(path.join(directory, names[0]), { bigint: true });
    assert.equal(stat.mode & 0o400n, 0n, "failed acquisition must not widen permissions");
  }
});

test("observer read-open denial cannot publish a lease", darwin, async t => {
  const directory = setup(t);
  const child = fork(new URL("./fixtures/darwin-worker-lease-primitive-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  fixtures.get(directory).children.push({ child, closed });
  child.send({ directory, stateGeneration: generation, denyObserverOpen: true });
  const [message] = await once(child, "message");
  if (message.type === "acquired") {
    child.send("release");
    await closed;
    assert.fail("acquisition did not check whether a separate read-only open succeeds");
  }
  assert.equal(message.type, "error", JSON.stringify(message));
  assert.equal(message.observerOpenDenied, true);
  assert.equal(message.code, "EACCES");
  await closed;
  assert.deepEqual(fs.readdirSync(directory), ["slot-000.lease"]);
  const stat = fs.lstatSync(path.join(directory, "slot-000.lease"), { bigint: true });
  assert.equal(stat.mode & 0o777n, 0o600n);
});
