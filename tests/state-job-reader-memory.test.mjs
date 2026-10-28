import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url), "utf8");
function fixture({ native = false } = {}) {
  const start = source.indexOf("export function createStateJobReader");
  assert.notEqual(start, -1, "Missing official fixed-path candidate reader");
  const body = source.slice(start, source.indexOf("function writeJsonAtomic", start)).replace(/^export /, "");
  const root = path.resolve("virtual-canonical-state");
  const jobs = path.join(root, "jobs");
  const stateFile = path.join(root, "state.json");
  const jobFile = path.join(jobs, "job.json");
  let resolves = 0, rootIno = 1n, jobsIno = 2n, host = "this-host", markerHost = "this-host", denied = false;
  let rootLink = false;
  const files = new Map([[stateFile, { ino: 3n, text: '{"jobs":[{"id":"job","generation":"old"}]}' }],
    [jobFile, { ino: 4n, text: '{"id":"job","generation":"old"}' }]]);
  const handles = new Map();
  let serial = 10;
  const stat = (ino, directory = false, symbolic = false, size = 1n) => ({ dev: 7n, ino, size, mtimeNs: 5n,
    isDirectory: () => directory, isSymbolicLink: () => symbolic, isFile: () => !directory && !symbolic });
  const context = vm.createContext({ path, process: { platform: "linux" }, STATE_FILE_NAME: "state.json", JOBS_DIR_NAME: "jobs", STATE_LOCK_FILE_NAME: "state.lock",
    resolveStateDir: () => { resolves += 1; return path.resolve("virtual-alias-state"); },
    inspectNativeStateLockScope: () => ({ hostId: host }),
    readStateLockProtocol: (_root, scope) => { if (markerHost !== scope.hostId) throw Error("different host"); return {
      protocol: "native-local-v2", epoch: "epoch", leaseDirectoryIdentity: { dev: "7", ino: "8" } }; },
    linuxSame: (left, right) => Boolean(left && right && left.dev === right.dev && left.ino === right.ino),
    // The reader delegates Linux record validation to these helpers; the
    // synthetic filesystem still exercises replacement and read errors.
    withLinuxRoot: (_root, run) => run(root),
    withLinuxJobs: (_root, run) => run(jobs),
    linuxReadRecord: (directory, name) => {
      const target = path.join(directory, name);
      if (denied) throw Object.assign(Error("denied"), { code: "EACCES" });
      const file = files.get(target);
      if (!file) throw Object.assign(Error("missing"), { code: "ENOENT" });
      const fd = context.fs.openSync(target, context.fs.constants.O_RDONLY | context.fs.constants.O_NONBLOCK | context.fs.constants.O_NOFOLLOW);
      try {
        assert.equal(context.fs.fstatSync(fd).ino, file.ino);
        return context.fs.readFileSync(fd);
      } finally { context.fs.closeSync(fd); }
    },
    fs: {
      constants: { O_RDONLY: 0, O_NONBLOCK: 2048, O_NOFOLLOW: 131072 },
      realpathSync: { native: () => root },
      lstatSync: target => {
        if (denied) throw Object.assign(Error("denied"), { code: "EACCES" });
        if (target === root) return stat(rootIno, true, rootLink);
        if (target === jobs) return stat(jobsIno, true);
        if (target === path.join(root, "state.lock") && native) return stat(9n, true);
        const file = files.get(target);
        if (file) return stat(file.ino, false, false, BigInt(file.text.length));
        throw Object.assign(Error("missing"), { code: "ENOENT" });
      },
      openSync: (target, flags) => {
        assert.equal(flags, 2048 | 131072, "read must use nonblocking and no-follow flags");
        const fd = serial++; handles.set(fd, { ...files.get(target) }); return fd;
      },
      fstatSync: fd => { const file = handles.get(fd); return stat(file.ino, false, false, BigInt(file.text.length)); },
      readFileSync: fd => { assert.equal(typeof fd, "number", "read must use the validated file handle"); return handles.get(fd).text; },
      closeSync: fd => handles.delete(fd)
    }
  });
  vm.runInContext(body + ";globalThis.create=createStateJobReader;", context);
  return { create: id => context.create("mock-workspace", id), resolves: () => resolves, handles: () => handles.size,
    replace: () => { files.set(stateFile, { ino: 30n, text: '{"jobs":[{"id":"job","generation":"new"}]}' }); files.set(jobFile, { ino: 40n, text: '{"id":"job","generation":"new"}' }); },
    corrupt: kind => { files.get(kind === "state" ? stateFile : jobFile).text = kind === "wrong-id" ? '{"id":"another"}' : '{broken'; },
    replaceRoot: () => { rootIno = 100n; }, replaceJobs: () => { jobsIno = 200n; }, linkRoot: () => { rootLink = true; },
    deny: () => { denied = true; }, foreignHost: () => { markerHost = "foreign-host"; }, root };
}

test("fixed candidate reader resolves aliases once and follows atomic file replacements without Git or writes", () => {
  const f = fixture(); const reader = f.create("job");
  assert.equal(reader.stateDir, f.root);
  assert.equal(reader.read().stored.generation, "old");
  f.replace();
  assert.equal(reader.read().indexed.generation, "new");
  assert.equal(reader.read().stored.generation, "new");
  assert.equal(f.resolves(), 1);
  assert.equal(f.handles(), 0);
});

for (const failure of ["replaceRoot", "replaceJobs", "linkRoot", "deny"]) {
  test(`fixed candidate reader refuses ${failure} instead of producing ACK evidence`, () => {
    const f = fixture(); const reader = f.create("job"); f[failure]();
    assert.throws(() => reader.read()); assert.equal(f.handles(), 0);
  });
}

for (const failure of ["state", "job", "wrong-id"]) {
  test(`fixed candidate reader preserves parse errors for ${failure}`, () => {
    const f = fixture(); const reader = f.create("job"); f.corrupt(failure);
    assert.throws(() => reader.read(), /corrupt|candidate|record/i); assert.equal(f.handles(), 0);
  });
}

test("fixed candidate reader revalidates native-local host evidence on every read", () => {
  const f = fixture({ native: true }); const reader = f.create("job");
  assert.equal(reader.read().stored.id, "job"); f.foreignHost();
  assert.throws(() => reader.read(), /host/); assert.equal(f.resolves(), 1);
});

test("fixed candidate readers do not share job identity or accept path traversal", () => {
  const f = fixture(); assert.throws(() => f.create("../job"), /job|identifier|path/i);
});
