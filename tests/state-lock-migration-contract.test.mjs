import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { types } from "node:util";
import vm from "node:vm";

// 移行契約の先行検証。拒否試験はAPI自体の欠落を成功と誤認しない。
// 旧全runtime停止と単一host限定は、実行時の明示確認を必須にする。
// 実FSの作成・変更・削除は行わず、state専用APIだけをメモリFSで評価する。
const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url), "utf8");
const barrier = "/state/state.lock";
const marker = `${barrier}/protocol.json`;
const protocol = "native-local-v2";
const directoryIdentity = { dev: "7", ino: "9007199254740993" };
const volumeGuid = "\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\";
const accepted = { offlineConfirmed: true, localOnly: true };

function fixture({ platform = "win32", initial = [], failMarker = false, failWrite = false, failSync = false, failLink = false, failAfterLink = false, linkRace, hostId = "host-a", scopeMock = true, machineGuid = "11111111-2222-3333-4444-555555555555", driveType = 3, fileSystem = "NTFS", handleIdentity = directoryIdentity, requiredApi = "migrateStateLock", canonicalPaths = {}, nativeCapability = true } = {}) {
  const hooks = {};
  const files = new Map([
    ["/state", { kind: "directory" }],
    ["/state/state.json", { kind: "file", text: '{"version":1,"config":{},"jobs":[{"id":"job"}]}' }],
    ["/state/jobs", { kind: "directory" }],
    ["/state/jobs/job.json", { kind: "file", text: '{"id":"job"}' }],
    ["/state/jobs/job.log", { kind: "file", text: "original log\n" }],
    ...initial
  ]);
  const before = JSON.stringify([...files].filter(([name]) => !name.startsWith(barrier)));
  const events = [];
  let interrupt = failMarker;
  const error = code => Object.assign(new Error(code), { code });
  const entry = name => {
    if (!files.has(name)) throw error("ENOENT");
    return files.get(name);
  };
  const metadata = name => {
    const item = entry(name);
    return {
      dev: Object.hasOwn(item, "dev") ? item.dev : 7n,
      ino: Object.hasOwn(item, "ino") ? item.ino : 9007199254740993n,
      isDirectory: () => item.kind === "directory",
      isFile: () => item.kind === "file",
      isSymbolicLink: () => item.kind === "symlink"
    };
  };
  const handles = new Map();
  let nextHandle = 1;
  let generation = 0;
  const forbiddenRemoval = name => {
    events.push(["remove", name]);
    throw new Error("Migration must never remove its permanent barrier or old artifacts");
  };
  const fakeFs = {
    constants: fs.constants,
    existsSync: name => files.has(name),
    lstatSync: metadata,
    statSync(name, options) {
      assert.equal(options?.bigint, true);
      if (!files.has(name) && Object.hasOwn(canonicalPaths, name)) return { dev: 7n, ino: 9007199254740993n, isDirectory: () => true };
      return metadata(name);
    },
    realpathSync: Object.assign(name => canonicalPaths[name] ?? name, { native: name => canonicalPaths[name] ?? name }),
    readFileSync: name => entry(name).text,
    readdirSync: name => [...files.keys()].filter(key => path.posix.dirname(key) === name).map(key => path.posix.basename(key)),
    chmodSync(name) { events.push(["chmod", name]); },
    mkdirSync(name, options) {
      events.push(["mkdir", name]);
      if (files.has(name)) {
        if (options?.recursive && entry(name).kind === "directory") return;
        throw error("EEXIST");
      }
      files.set(name, { kind: "directory" });
    },
    writeFileSync(name, text, options) {
      name = handles.get(name) ?? name;
      events.push(["write", name]);
      if (failWrite) { failWrite = false; throw error("ENOSPC"); }
      if (name === marker && interrupt) {
        interrupt = false;
        throw new Error("injected marker interruption");
      }
      if (options?.flag === "wx" && files.has(name)) throw error("EEXIST");
      files.set(name, { kind: "file", text: String(text) });
    },
    renameSync(from, to) {
      events.push(["rename", from, to]);
      if (to === barrier || files.has(to)) throw new Error("Migration must not replace existing artifacts");
      files.set(to, entry(from));
      files.delete(from);
    },
    openSync(name, flags) {
      events.push(["open", name]);
      if (flags !== "wx" || files.has(name)) throw error("EEXIST");
      files.set(name, { kind: "file", text: "" });
      const handle = nextHandle++;
      handles.set(handle, name);
      return handle;
    },
    fsyncSync(handle) {
      events.push(["fsync", handles.get(handle)]);
      if (failSync) throw new Error("injected fsync failure");
    },
    closeSync(handle) {
      events.push(["close", handles.get(handle)]);
      handles.delete(handle);
    },
    linkSync(from, to) {
      events.push(["link", from, to]);
      if (interrupt) { interrupt = false; throw new Error("injected marker interruption"); }
      if (failLink) throw error("ENOTSUP");
      if (linkRace) {
        files.set(to, { kind: "file", text: JSON.stringify(linkRace) });
        linkRace = undefined;
        throw error("EEXIST");
      }
      if (files.has(to)) throw error("EEXIST");
      files.set(to, entry(from));
      if (failAfterLink) { failAfterLink = false; throw new Error("injected post-publication crash"); }
    },
    unlinkSync: forbiddenRemoval,
    rmSync: forbiddenRemoval,
    rmdirSync: forbiddenRemoval
  };
  const bound = new Set();
  const net = {
    createServer() {
      return {
        listening: false,
        on() { return this; }, unref() { return this; },
        listen(options) {
          this.name = options.path;
          if (nativeCapability && !bound.has(this.name)) {
            this.listening = true;
            bound.add(this.name);
            hooks.afterBind?.();
          }
          return this;
        },
        close() {
          if (this.listening) bound.delete(this.name);
          this.listening = false;
          return this;
        }
      };
    }
  };
  const context = vm.createContext({
    fs: fakeFs, path: { ...path.posix, win32: path.win32 }, createHash, randomUUID: () => `attempt-${++generation}`, net, types,
    os: { tmpdir: () => "/tmp", hostname: () => "same-hostname" },
    process: { platform, pid: 100, env: {}, versions: { node: "22.0.0" } },
    resolveWorkspaceRoot: value => value, isActiveJob: () => false,
    SharedArrayBuffer, Int32Array, Atomics, Buffer, performance,
    execFileSync(_file, _args, options) {
      events.push(["host-inspect", options.env.GROK_STATE_VOLUME_ROOT]);
      return JSON.stringify({ machineGuid, driveType, fileSystem, volumeGuid: "\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\", directoryIdentity: handleIdentity });
    }
  });
  vm.runInContext(source.replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, "").replace(/^export /gm, ""), context);
  vm.runInContext('resolveStateDir = () => "/state";', context);
  if (scopeMock && typeof context.inspectNativeStateLockScope === "function") {
    context.mockScope = () => {
      if (!hostId) throw new Error("Host identity is unavailable");
      return { hostId, directoryIdentity, volumeGuid };
    };
    vm.runInContext('inspectNativeStateLockScope = mockScope;', context);
  }
  // 拒否試験のassert.throwsが「API未実装」の例外を誤って受理しないよう外側で確認する。
  assert.equal(typeof context[requiredApi], "function", `Missing implementation: ${requiredApi}`);
  return {
    files, events, context, hooks,
    legacyAcquire() {
      fakeFs.writeFileSync(barrier, "legacy-owner\n", { flag: "wx" });
    },
    migrate(options = accepted) {
      return context.migrateStateLock("/workspace", options);
    },
    endpoint(directory) {
      return context.resolveNativeStateLockEndpoint(directory, { platform });
    },
    snapshot() {
      return context.withStateSnapshot("/workspace", () => "inspected");
    },
    assertOriginals() {
      assert.equal(JSON.stringify([...files].filter(([name]) => !name.startsWith(barrier))), before);
      assert.equal(events.some(([kind]) => kind === "remove"), false);
    }
  };
}

for (const options of [{}, { localOnly: true }, { offlineConfirmed: true }, { offlineConfirmed: "true", localOnly: true }]) {
  test(`migration refuses incomplete execution declarations: ${JSON.stringify(options)}`, () => {
    const f = fixture();
    assert.throws(() => f.migrate(options), /offline|local|host/i);
    assert.equal(f.files.has(barrier), false);
    f.assertOriginals();
  });
}

for (const kind of ["file", "symlink"]) {
  test(`migration never removes or replaces an existing ${kind} lock`, () => {
    const old = { kind, text: "unknown old owner\n" };
    const f = fixture({ initial: [[barrier, old]] });
    assert.throws(() => f.migrate(), /existing|legacy|symbolic|symlink|lock/i);
    assert.equal(f.files.get(barrier), old);
    assert.deepEqual(f.events, []);
    f.assertOriginals();
  });
}

test("explicit migration preserves JSON/jobs and installs a permanent protocol barrier", () => {
  const f = fixture();
  f.migrate();
  assert.equal(f.files.get(barrier)?.kind, "directory");
  const saved = JSON.parse(f.files.get(marker)?.text ?? "null");
  assert.equal(saved?.protocol, protocol);
  assert.equal(saved?.hostId, "host-a");
  assert.deepEqual(saved?.directoryIdentity, directoryIdentity);
  assert.equal(saved?.volumeGuid, volumeGuid.toLowerCase());
  const publication = f.events.findIndex(([event]) => event === "link");
  const synchronized = f.events.findIndex(([event]) => event === "fsync");
  const closed = f.events.findIndex(([event]) => event === "close");
  assert.ok(synchronized >= 0 && synchronized < closed && closed < publication);
  f.assertOriginals();
});

for (const expectedStateDir of ["", "relative/state", null, "C:/different-state"]) {
  test(`expected state directory is checked before scope lookup or mutation: ${JSON.stringify(expectedStateDir)}`, () => {
    const f = fixture({ initial: [["C:/different-state", { kind: "directory" }]] });
    f.context.inspectNativeStateLockScope = () => assert.fail("scope lookup must not run");
    assert.throws(() => f.migrate({ ...accepted, expectedStateDir }), /expected.*state.*absolute|expected.*state.*match/i);
    assert.deepEqual(f.events, []);
    f.assertOriginals();
  });
}

test("expected Windows state path accepts canonical aliases and case differences", () => {
  const expectedStateDir = "C:\\Alias\\STATE";
  const f = fixture({ initial: [[expectedStateDir, { kind: "directory" }]], canonicalPaths: {
    [expectedStateDir]: "c:\\data\\state", "/state": "C:\\Data\\State"
  } });
  const result = f.migrate({ ...accepted, expectedStateDir });
  assert.equal(result.stateDir, "/state");
  f.assertOriginals();
});

test("migration resolves state once and uses the verified directory for its barrier", () => {
  const f = fixture();
  let resolutions = 0;
  f.context.resolveStateDir = () => ++resolutions === 1 ? "/state" : "/different-state";
  const result = f.migrate();
  assert.equal(resolutions, 1);
  assert.equal(result.stateDir, "/state");
  assert.equal(f.files.get(barrier)?.kind, "directory");
  assert.equal(f.files.has("/different-state/state.lock"), false);
  f.assertOriginals();
});

test("interruption after barrier creation retains it and explicit rerun completes", () => {
  const f = fixture({ failMarker: true });
  assert.throws(() => f.migrate(), /injected marker interruption/);
  const retained = f.files.get(barrier);
  assert.equal(retained?.kind, "directory");
  f.assertOriginals();
  f.migrate();
  assert.equal(f.files.get(barrier), retained);
  assert.equal(JSON.parse(f.files.get(marker).text).protocol, protocol);
  f.assertOriginals();
});

for (const saved of [{ protocol: "future-protocol", localOnly: true, hostId: "host-a", directoryIdentity }, { protocol, localOnly: true, hostId: "host-b", directoryIdentity }]) {
  test(`migration refuses a foreign owner/protocol: ${JSON.stringify(saved)}`, () => {
    const originalMarker = { kind: "file", text: JSON.stringify(saved) };
    const f = fixture({ initial: [[barrier, { kind: "directory" }], [marker, originalMarker]] });
    assert.throws(() => f.migrate(), /host|protocol|unsupported|foreign/i);
    assert.equal(f.files.get(marker), originalMarker);
    assert.deepEqual(f.events, []);
    f.assertOriginals();
  });
}

test("unsupported OS is refused before creating a barrier", () => {
  const f = fixture({ platform: "freebsd" });
  assert.throws(() => f.migrate(), /unsupported|platform|freebsd/i);
  assert.equal(f.files.has(barrier), false);
  f.assertOriginals();
});

test("migration rerun with the same host and protocol is idempotent", () => {
  const f = fixture();
  f.migrate();
  const completed = JSON.stringify([...f.files]);
  f.migrate();
  assert.equal(JSON.stringify([...f.files]), completed);
  f.assertOriginals();
});

test("missing synchronous native capability is rejected before creating a barrier", () => {
  const f = fixture({ nativeCapability: false });
  assert.throws(() => f.migrate(), /native|synchronous|capability|unsupported/i);
  assert.equal(f.files.has(barrier), false);
  f.assertOriginals();
});

test("unavailable host identity is rejected before creating a barrier", () => {
  const f = fixture({ hostId: "" });
  assert.throws(() => f.migrate(), /host|identity|unavailable/i);
  assert.equal(f.files.has(barrier), false);
  f.assertOriginals();
});

for (const failure of ["failSync", "failLink"]) {
  test(`failed ${failure} keeps barrier and never publishes an incomplete marker`, () => {
    const f = fixture({ [failure]: true });
    assert.throws(() => f.migrate());
    assert.equal(f.files.get(barrier)?.kind, "directory");
    assert.equal(f.files.has(marker), false);
    f.assertOriginals();
  });
}

test("crash after atomic publication is recovered idempotently without rewriting linked data", () => {
  const f = fixture({ failAfterLink: true });
  assert.throws(() => f.migrate(), /post-publication crash/);
  const published = f.files.get(marker);
  assert.equal(JSON.parse(published.text).protocol, protocol);
  const writes = f.events.filter(([event]) => ["open", "write"].includes(event)).length;
  f.migrate();
  assert.equal(f.files.get(marker), published);
  assert.equal(f.events.filter(([event]) => ["open", "write"].includes(event)).length, writes);
  f.assertOriginals();
});

test("interrupted partial prepared artifacts are retained and never overwritten on retry", () => {
  const oldPrepared = { kind: "file", text: '{"incomplete":' };
  const f = fixture({ initial: [[barrier, { kind: "directory" }], [`${barrier}/prepared-old.json`, oldPrepared]] });
  f.migrate();
  assert.equal(f.files.get(`${barrier}/prepared-old.json`), oldPrepared);
  assert.equal(JSON.parse(f.files.get(marker).text).protocol, protocol);
  f.assertOriginals();
});

test("disk-full preparation retains its partial artifact and retries with a fresh unique name", () => {
  const f = fixture({ failWrite: true });
  assert.throws(() => f.migrate(), /ENOSPC/);
  const [name, partial] = [...f.files].find(([name]) => /prepared-/.test(name));
  f.migrate();
  assert.equal(f.files.get(name), partial);
  assert.equal(partial.text, "");
  assert.equal(JSON.parse(f.files.get(marker).text).protocol, protocol);
  f.assertOriginals();
});

for (const racingHost of ["host-a", "host-b"]) {
  test(`atomic publication EEXIST verifies the existing marker without replacement: ${racingHost}`, () => {
    const published = { protocol, localOnly: true, hostId: racingHost, directoryIdentity, volumeGuid };
    const f = fixture({ linkRace: published });
    if (racingHost === "host-a") assert.equal(f.migrate().hostId, racingHost);
    else assert.throws(() => f.migrate(), /different.*host/i);
    assert.equal(f.files.get(marker).text, JSON.stringify(published));
    assert.equal(f.events.filter(([event]) => event === "link").length, 1);
    f.assertOriginals();
  });
}

for (const initialMarker of [undefined, { kind: "file", text: "{partial" }, { kind: "symlink", text: "outside" }]) {
  test(`normal writes refuse an incomplete/invalid migration without legacy fallback: ${initialMarker?.kind ?? "missing"}`, () => {
    const initial = [[barrier, { kind: "directory" }]];
    if (initialMarker) initial.push([marker, initialMarker]);
    const f = fixture({ initial, requiredApi: "withStateSnapshot" });
    assert.throws(() => f.snapshot(), /protocol.*incomplete|invalid/i);
    assert.equal(f.events.some(([event]) => event === "write" || event === "remove"), false);
    f.assertOriginals();
  });
}

test("a completed migration routes normal snapshots through the native mutex", () => {
  const f = fixture();
  f.migrate();
  const published = f.files.get(marker);
  assert.equal(f.snapshot(), "inspected");
  assert.equal(f.files.get(marker), published);
  assert.equal(f.events.some(([event]) => event === "remove"), false);
  f.assertOriginals();
});

test("migrated barrier rejects old runtime wx attempts before, during and after a new snapshot", () => {
  const f = fixture();
  f.migrate();
  const before = JSON.stringify([...f.files]);
  const legacy = () => assert.throws(() => f.legacyAcquire(), { code: "EEXIST" });
  legacy();
  f.context.withStateSnapshot("/workspace", () => {
    legacy();
    assert.throws(() => f.context.withStateSnapshot("/workspace", () => assert.fail("parallel callback"), { timeoutMs: 0 }), /lock/i);
  });
  legacy();
  assert.equal(JSON.stringify([...f.files]), before);
  f.assertOriginals();
});

test("completed migration keeps original state when callback fails and releases the mutex", () => {
  const f = fixture();
  f.migrate();
  const failure = new Error("callback failed");
  assert.throws(() => f.context.updateState("/workspace", state => {
    state.jobs.length = 0;
    throw failure;
  }), error => error === failure);
  assert.equal(f.snapshot(), "inspected");
  f.assertOriginals();
});

for (const driveType of [0, 4]) {
  test(`Windows environment inspection rejects unknown/network drive type ${driveType}`, () => {
    const f = fixture({ scopeMock: false, driveType, canonicalPaths: { "/state": "C:\\Local\\State" } });
    assert.throws(() => f.migrate(), /fixed|shared|network|unknown/i);
    assert.equal(f.files.has(barrier), false);
    f.assertOriginals();
  });
}

test("Windows environment inspection refuses canonical UNC aliases before host lookup", () => {
  const f = fixture({ scopeMock: false, canonicalPaths: { "/state": "\\\\server\\share\\state" } });
  assert.throws(() => f.migrate(), /UNC|shared/i);
  assert.equal(f.events.some(([event]) => event === "host-inspect"), false);
  assert.equal(f.files.has(barrier), false);
  f.assertOriginals();
});

test("Windows environment inspection refuses absent MachineGuid and hashes a valid identity", () => {
  const unavailable = fixture({ scopeMock: false, machineGuid: "", canonicalPaths: { "/state": "C:\\Local\\State" } });
  assert.throws(() => unavailable.migrate(), /host identity/i);
  assert.equal(unavailable.files.has(barrier), false);
  const valid = fixture({ scopeMock: false, canonicalPaths: { "/state": "C:\\Local\\State" } });
  const result = valid.migrate();
  assert.match(result.hostId, /^[a-f0-9]{64}$/);
  assert.notEqual(result.hostId, "11111111-2222-3333-4444-555555555555");
  valid.assertOriginals();
});

test("unmigrated default operation refuses before any filesystem mutation", () => {
  const f = fixture({ requiredApi: "withStateSnapshot" });
  assert.throws(() => f.snapshot(), /migration/i);
  assert.deepEqual(f.events, []);
  assert.notEqual(f.files.get(barrier)?.kind, "directory");
  assert.equal(f.files.has(marker), false);
});

test("migration diagnostic treats shell metacharacters in the state path as data", () => {
  const stateDir = 'C:\\Data\\$(Write-Output injected)`marker\\state';
  const f = fixture();
  f.context.resolveStateDir = () => stateDir;
  assert.throws(() => f.snapshot(), error => {
    const lines = error.message.split("\n");
    assert.ok(lines.includes(`State directory (data): ${stateDir}`));
    const command = lines.find(line => line.startsWith("Run "));
    assert.ok(command, "Diagnostic must provide a separate command example");
    assert.match(command, /--expected-state-dir <absolute-state-directory>/);
    assert.equal(command.includes("$("), false);
    assert.equal(command.includes("`"), false);
    assert.equal(command.includes(stateDir), false);
    assert.match(error.message, /quot.*shell/i);
    return true;
  });
  assert.deepEqual(f.events, []);
});

// 必須移行の失敗条件: 空state、legacy file、壊れた/未完了marker、非対応OS。
// callback、jobs作成/chmod、旧lockの回収が一つでも起これば不合格。
for (const kind of ["empty", "missing", "legacy", "incomplete", "invalid", "unsupported", "foreign"]) {
  for (const api of ["updateState", "withStateSnapshot", "ensureStateDir", "saveState", "writeJobFile", "resolveJobFile", "resolveJobLogFile"]) {
    test(`${api} fails closed without mutations: ${kind}`, () => {
      const initial = kind === "legacy" ? [[barrier, { kind: "file", text: "old-owner" }]]
        : ["incomplete", "invalid", "unsupported", "foreign"].includes(kind) ? [[barrier, { kind: "directory" }]] : [];
      if (["invalid", "unsupported", "foreign"].includes(kind)) initial.push([marker, { kind: "file", text:
        kind === "invalid" ? "{partial" : JSON.stringify({ protocol: kind === "unsupported" ? "unknown" : protocol, localOnly: true, hostId: "foreign", directoryIdentity }) }]);
      const f = fixture({ initial, requiredApi: api });
      if (kind === "empty") f.files.clear();
      const before = JSON.stringify([...f.files]);
      const args = api === "ensureStateDir" ? [] : api === "saveState" ? [{ jobs: [] }]
        : ["writeJobFile", "resolveJobFile", "resolveJobLogFile"].includes(api) ? ["job", {}]
        : [() => assert.fail("callback entered")];
      if (api === "resolveJobFile") args.pop();
      assert.throws(() => f.context[api]("/workspace", ...args), /migration|protocol|host/i);
      assert.deepEqual(f.events, []);
      assert.equal(JSON.stringify([...f.files]), before);
    });
  }
}

for (const platform of ["linux", "darwin"]) {
  test(`normal POSIX writes require explicit migration before any mutation: ${platform}`, () => {
    const f = fixture({ platform });
    const before = JSON.stringify([...f.files]);
    for (const api of ["updateState", "withStateSnapshot", "ensureStateDir"]) {
      const args = api === "ensureStateDir" ? [] : [() => assert.fail("callback entered")];
      assert.throws(() => f.context[api]("/workspace", ...args), /requires explicit offline migration/i);
    }
    assert.deepEqual(f.events, []);
    assert.equal(JSON.stringify([...f.files]), before);
  });
}

test("pure state loads remain available before migration, including empty state", () => {
  const f = fixture();
  assert.equal(f.context.loadState("/workspace").jobs[0].id, "job");
  f.files.clear();
  assert.equal(f.context.loadState("/workspace").jobs.length, 0);
  assert.deepEqual(f.events, []);
});

test("Windows endpoint normalizes canonical aliases and case without embedding the state path", () => {
  const f = fixture({ requiredApi: "resolveNativeStateLockEndpoint", canonicalPaths: {
    "C:/alias/state": "C:\\Data\\State",
    "C:/other-alias/state": "c:\\data\\state"
  } });
  const first = f.endpoint("C:/alias/state");
  assert.equal(first, f.endpoint("C:/other-alias/state"));
  assert.match(first, /^\\\\\.\\pipe\\grok-state-v2-[a-f0-9]{64}$/);
});

// POSIXの旧abstract-UDS名はnamespaceごとに分裂するため、製品lockとして公開しない。
for (const platform of ["linux", "darwin"]) {
  test(`low-level endpoint rejects the former POSIX socket-lock backend: ${platform}`, () => {
    const f = fixture({ platform, requiredApi: "resolveNativeStateLockEndpoint" });
    const before = JSON.stringify([...f.files]);
    assert.throws(() => f.endpoint("/state"), /unsupported.*platform|Windows.only/i);
    assert.equal(JSON.stringify([...f.files]), before);
    assert.deepEqual(f.events, []);
  });
}

// v2の先行失敗条件: renameでのmutex分裂、取得後retarget、旧/別identity marker、
// 非BigInt・欠損・0・fileのidentityでの取得/I/O。実データの移行や削除はしない。
for (const fileSystem of [undefined, "", "FAT32", "ReFS"]) {
  test(`migration rejects actual handle filesystem before publishing a barrier: ${String(fileSystem)}`, () => {
    const f = fixture({ scopeMock: false, fileSystem: fileSystem ?? null, canonicalPaths: { "/state": "C:\\Local\\Mounted\\State" } });
    assert.throws(() => f.migrate(), /NTFS|filesystem/i);
    assert.equal(f.files.has(barrier), false);
    f.assertOriginals();
  });
}

test("mounted target is inspected by its directory handle and must match the Node BigInt identity", () => {
  const f = fixture({ scopeMock: false, handleIdentity: { dev: "8", ino: "9007199254740993" }, canonicalPaths: { "/state": "C:\\Local\\Mounted\\State" } });
  assert.throws(() => f.migrate(), /identity|changed/i);
  assert.equal(f.files.has(barrier), false);
  f.assertOriginals();
});

test("Windows endpoint follows the directory identity across rename and aliases without losing BigInt precision", () => {
  const f = fixture({ initial: [["/renamed", { kind: "directory" }], ["/other", { kind: "directory" }]] });
  const original = f.endpoint("/state");
  assert.equal(f.endpoint("/renamed"), original);
  f.files.get("/other").ino = 9007199254740992n;
  assert.notEqual(f.endpoint("/other"), original);
  assert.equal(f.events.length, 0);
});

for (const saved of [
  { protocol: "native-local-v1", localOnly: true, hostId: "host-a" },
  { protocol, localOnly: true, hostId: "host-a" },
  { protocol, localOnly: true, hostId: "host-a", directoryIdentity: { dev: "7", ino: "99" }, volumeGuid }
]) {
  test(`v2 refuses old/incomplete/foreign identity marker without changing it: ${JSON.stringify(saved)}`, () => {
    const f = fixture({ initial: [[barrier, { kind: "directory" }], [marker, { kind: "file", text: JSON.stringify(saved) }]] });
    assert.throws(() => f.snapshot(), /protocol|identity/i);
    assert.throws(() => f.migrate(), /protocol|identity/i);
    assert.equal(f.files.get(marker).text, JSON.stringify(saved));
    assert.deepEqual(f.events, []);
    f.assertOriginals();
  });
}

for (const field of ["dev", "ino"]) for (const value of [undefined, 0n, 1, "7"]) {
  test(`Windows native lock rejects invalid ${field}=${String(value)} before binding or callback`, () => {
    const f = fixture();
    f.files.get("/state")[field] = value;
    assert.throws(() => f.context.withNativeStateLock("/state", () => assert.fail("callback entered")), /identity/i);
    assert.deepEqual(f.events, []);
  });
}

test("Windows native lock rejects a non-directory before binding or callback", () => {
  const f = fixture(); f.files.get("/state").kind = "file";
  assert.throws(() => f.context.withNativeStateLock("/state", () => assert.fail("callback entered")), /identity/i);
  assert.deepEqual(f.events, []);
});

for (const platform of ["linux", "darwin"]) {
  test(`low-level native lock is Windows-only and never binds a POSIX socket: ${platform}`, () => {
    const f = fixture({ platform });
    let bound = false;
    f.hooks.afterBind = () => { bound = true; };
    const before = JSON.stringify([...f.files]);
    assert.throws(() => f.context.withNativeStateLock("/state", () => assert.fail("unsupported callback")), /unsupported.*platform|Windows.only/i);
    assert.equal(bound, false);
    assert.deepEqual(f.events, []);
    assert.equal(JSON.stringify([...f.files]), before);
  });
}

for (const platform of ["freebsd"]) {
  test(`low-level native lock refuses unsupported platform before binding: ${platform}`, () => {
    const f = fixture({ platform });
    let bound = false;
    f.hooks.afterBind = () => { bound = true; };
    assert.throws(() => f.context.withNativeStateLock("/state", () => assert.fail("unsupported callback")), /unsupported.*platform/i);
    assert.equal(bound, false);
    assert.deepEqual(f.events, []);
  });
}

for (const replaceMarker of [false, true]) {
  test(`acquired mutex identity is checked after path retarget even with a valid replacement marker: ${replaceMarker}`, () => {
    const f = fixture(); f.migrate(); f.events.length = 0;
    const original = f.files.get(marker).text;
    f.hooks.afterBind = () => {
      f.files.get("/state").ino = 101n;
      if (replaceMarker) f.files.set(marker, { kind: "file", text: JSON.stringify({ protocol, localOnly: true, hostId: "host-a", directoryIdentity: { dev: "7", ino: "101" }, volumeGuid }) });
    };
    assert.throws(() => f.snapshot(), /identity|changed/i);
    assert.deepEqual(f.events, []);
    if (!replaceMarker) assert.equal(f.files.get(marker).text, original);
  });
}

test("read-only migration scope is synchronous, expires after callback and never pretends to hold a mutex", () => {
  const f = fixture(); f.migrate();
  assert.equal(typeof f.context.withStateLockMigrationScope, "function");
  let lookups = 0;
  f.context.inspectNativeStateLockScope = () => { lookups++; return { hostId: "host-a", directoryIdentity, volumeGuid }; };
  let captured;
  assert.equal(f.context.withStateLockMigrationScope("/state", check => {
    captured = check; check(); check();
    assert.equal(lookups, 1);
    f.context.requireStateLockMigration("/state");
    assert.equal(lookups, 2, "Read-only scope must not create an owned-mutex context");
    return "checked";
  }), "checked");
  assert.throws(() => captured(), /expired|synchronous/i);
  assert.throws(() => f.context.withStateLockMigrationScope("/state", () => ({ then() {} })), /synchronous|thenable/i);
  assert.throws(() => captured(), /expired|synchronous/i);
});

for (const replacement of ["identity", "marker"]) {
  test(`read-only migration check binds its initial identity against a later ${replacement} replacement`, () => {
    const f = fixture(); f.migrate(); f.events.length = 0;
    assert.equal(typeof f.context.withStateLockMigrationScope, "function");
    let sideEffect = false;
    assert.throws(() => f.context.withStateLockMigrationScope("/state", check => {
      if (replacement === "identity") {
        f.files.get("/state").ino = 101n;
        f.files.set(marker, { kind: "file", text: JSON.stringify({ protocol, localOnly: true, hostId: "host-a", directoryIdentity: { dev: "7", ino: "101" }, volumeGuid }) });
      } else f.files.set(marker, { kind: "file", text: "{incomplete" });
      check();
      sideEffect = true;
    }), /identity|protocol/i);
    assert.equal(sideEffect, false);
    assert.deepEqual(f.events, []);
  });
}

for (const savedGuid of [undefined, "bad-guid", "\\\\?\\Volume{------------------------------------}\\", "\\\\?\\Volume{22222222-2222-2222-2222-222222222222}\\"]) {
  test(`same dev/ino cannot authorize a missing, malformed or different marker volume GUID: ${String(savedGuid)}`, () => {
    const saved = { protocol, localOnly: true, hostId: "host-a", directoryIdentity, volumeGuid: savedGuid };
    const f = fixture({ initial: [[barrier, { kind: "directory" }], [marker, { kind: "file", text: JSON.stringify(saved) }]] });
    assert.throws(() => f.snapshot(), /volume.*identity|volume.*guid/i);
    assert.throws(() => f.migrate(), /volume.*identity|volume.*guid/i);
    assert.equal(f.files.get(marker).text, JSON.stringify(saved));
    assert.deepEqual(f.events, []);
    f.assertOriginals();
  });
}

test("marker volume GUID comparison normalizes case", () => {
  const saved = { protocol, localOnly: true, hostId: "host-a", directoryIdentity, volumeGuid: volumeGuid.toUpperCase() };
  const f = fixture({ initial: [[barrier, { kind: "directory" }], [marker, { kind: "file", text: JSON.stringify(saved) }]] });
  assert.equal(f.snapshot(), "inspected");
  assert.equal(f.migrate().volumeGuid, saved.volumeGuid);
  assert.equal(f.files.get(marker).text, JSON.stringify(saved));
  f.assertOriginals();
});
