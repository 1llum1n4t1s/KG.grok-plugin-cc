import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MARKER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const ATTEMPT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const BROKER_TEMP = /^broker\.json\.[1-9][0-9]{0,19}\.[a-z0-9]{0,64}\.tmp$/;
const RECOVERY = "linux-epoch-recovery-v1";
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_RECORD = 8 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const TIMEOUT_MS = 10000;
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const DIR = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW;

function fail(message) { throw new Error(`Linux epoch recovery: ${message}`); }
function guard(context) {
  if (process.platform !== "linux" || !NOFOLLOW || typeof context?.check !== "function" ||
      !path.isAbsolute(context.stateDir ?? "") || !EPOCH.test(context.epoch ?? "") ||
      !context.directoryIdentity?.dev || !context.directoryIdentity?.ino || !context.hostId) fail("invalid state context");
  const deadline = performance.now() + TIMEOUT_MS;
  return () => { context.check(); if (performance.now() >= deadline) fail("time limit exceeded"); };
}
function at(fd, name) { return `/proc/self/fd/${fd}/${name}`; }
function id(s) { return { dev: String(s.dev), ino: String(s.ino), mode: String(s.mode), uid: String(s.uid), gid: String(s.gid) }; }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function fileId(s) { return { ...id(s), nlink: String(s.nlink), size: String(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs) }; }
function lstat(file) { try { return fs.lstatSync(file, { bigint: true }); } catch (e) { if (e?.code === "ENOENT") return null; throw e; } }
/** Linux の開いた fd に対し、一意な mount ID だけを返す。 */
export function fdMountId(fd) {
  let content;
  try { content = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"); }
  catch (error) { throw new Error("Linux epoch recovery: fd mount identity is unavailable", { cause: error }); }
  const lines = content.split("\n").filter(line => line.startsWith("mnt_id"));
  const match = lines.length === 1 ? /^mnt_id:[\t ]*([1-9][0-9]{0,19})[\t ]*$/.exec(lines[0]) : null;
  if (!match) fail("fd mount identity is invalid");
  return match[1];
}
function requireSameMount(parent, child) {
  if (fdMountId(parent) !== fdMountId(child)) fail("entry crosses a state mount boundary");
}
function requireSameDevice(parent, stat) {
  if (!stat || stat.dev !== fs.fstatSync(parent, { bigint: true }).dev) fail("entry crosses the state filesystem boundary");
}
function verifyDirectory(fd, file, expected, check) {
  check();
  const current = lstat(file), opened = fs.fstatSync(fd, { bigint: true });
  if (!current?.isDirectory() || current.isSymbolicLink() || !opened.isDirectory() ||
      !equal(id(current), expected) || !equal(id(opened), expected)) fail("directory identity changed");
  const named = fs.openSync(file, DIR);
  try {
    const namedStat = fs.fstatSync(named, { bigint: true });
    if (!namedStat.isDirectory() || !equal(id(namedStat), expected)) fail("directory identity changed");
    requireSameMount(fd, named);
  } finally { fs.closeSync(named); }
  check();
}
function root(context, check, run) {
  check();
  const before = lstat(context.stateDir);
  if (!before?.isDirectory() || before.isSymbolicLink() || String(before.dev) !== context.directoryIdentity.dev ||
      String(before.ino) !== context.directoryIdentity.ino) fail("state directory identity changed");
  const fd = fs.openSync(context.stateDir, DIR);
  try {
    const expected = id(before); verifyDirectory(fd, context.stateDir, expected, check);
    const result = run(fd);
    verifyDirectory(fd, context.stateDir, expected, check);
    return result;
  } finally { fs.closeSync(fd); }
}
function privateDirectory(stat) {
  return stat?.isDirectory() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid()) && (stat.mode & 0o7077n) === 0n;
}
function directory(parent, name, check, run, create = false, secure = false) {
  check();
  const file = at(parent, name);
  let before = lstat(file);
  if (!before && create) {
    fs.mkdirSync(file, { mode: 0o700 });
    fs.fsyncSync(parent);
    before = lstat(file);
  }
  if (!before) return null;
  if (!before.isDirectory() || before.isSymbolicLink()) fail(`invalid directory ${name}`);
  requireSameDevice(parent, before);
  if (secure && !privateDirectory(before)) fail(`recovery directory is not private ${name}`);
  const fd = fs.openSync(file, DIR);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    requireSameDevice(parent, opened);
    requireSameMount(parent, fd);
    if (secure && !privateDirectory(opened)) fail(`recovery directory is not private ${name}`);
    const expected = id(before); verifyDirectory(fd, file, expected, check);
    const result = run(fd, expected);
    verifyDirectory(fd, file, expected, check);
    return result;
  } finally { fs.closeSync(fd); }
}
function names(fd, max, check) {
  check();
  const list = [], dir = fs.opendirSync(`/proc/self/fd/${fd}`);
  try {
    for (;;) {
      check();
      const item = dir.readSync();
      if (!item) break;
      list.push(item.name);
      if (list.length > max) fail("directory entry limit exceeded");
    }
  } finally { dir.closeSync(); }
  return list.sort();
}
function verifyNamedFile(parent, name, expected) {
  const fd = fs.openSync(at(parent, name), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    requireSameDevice(parent, stat);
    requireSameMount(parent, fd);
    if (!stat.isFile() || !equal(fileId(stat), expected)) fail(`file identity changed ${name}`);
  } finally { fs.closeSync(fd); }
}
function readFile(parent, name, max, budget, check, sync = false, secure = false) {
  check();
  const file = at(parent, name), before = lstat(file);
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(max)) fail(`invalid file ${name}`);
  requireSameDevice(parent, before);
  if (secure && (before.uid !== BigInt(process.getuid()) || (before.mode & 0o7777n) !== 0o600n)) fail(`invalid recovery file owner or mode ${name}`);
  if (budget.bytes + Number(before.size) > MAX_BYTES) fail("byte limit exceeded");
  budget.bytes += Number(before.size);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW);
  try {
    const expected = fileId(before), opened = fs.fstatSync(fd, { bigint: true });
    requireSameDevice(parent, opened);
    requireSameMount(parent, fd);
    if (!opened.isFile() || !equal(fileId(opened), expected)) fail(`file changed ${name}`);
    const data = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < data.length) {
      check();
      const n = fs.readSync(fd, data, offset, Math.min(65536, data.length - offset), offset);
      if (!n) fail(`file truncated ${name}`);
      offset += n;
    }
    if (sync) fs.fsyncSync(fd);
    const after = fs.fstatSync(fd, { bigint: true }), current = lstat(file);
    if (!current?.isFile() || !equal(fileId(after), expected) || !equal(fileId(current), expected)) fail(`file changed ${name}`);
    verifyNamedFile(parent, name, expected);
    check();
    return { data, identity: expected };
  } finally { fs.closeSync(fd); }
}
function snapshot(context, check) {
  const entries = [], budget = { bytes: 0 }, counters = { epochs: 0, entries: 0 };
  const add = item => { if (++counters.entries > MAX_ENTRIES) fail("inventory entry limit exceeded"); entries.push(item); };
  const regular = (fd, name, rel, max) => {
    const r = readFile(fd, name, max, budget, check);
    add({ path: rel, type: "file", identity: r.identity, sha256: createHash("sha256").update(r.data).digest("hex") });
  };
  const knownDir = (parent, name, rel, kind) => {
    const result = directory(parent, name, check, (fd, identity) => {
      const before = fs.fstatSync(fd, { bigint: true });
      const oldIdentity = { ...identity, nlink: String(before.nlink), mtime: String(before.mtimeNs), ctime: String(before.ctimeNs) };
      add({ path: rel, type: "directory", identity: oldIdentity });
      const max = kind === "broker" ? 259 : 256;
      for (const item of names(fd, max, check)) {
        const valid = kind === "broker" ? ["broker.json", "broker.lock", "broker-admission.jsonl"].includes(item) || BROKER_TEMP.test(item) : MARKER.test(item);
        if (!valid) fail(`unknown legacy entry ${rel}/${item}`);
        const limit = kind === "direct" ? 24576 : item === "broker-admission.jsonl" ? 4 * 1024 * 1024 : 65536;
        regular(fd, item, `${rel}/${item}`, limit);
      }
      const after = fs.fstatSync(fd, { bigint: true });
      if (!equal(oldIdentity, { ...id(after), nlink: String(after.nlink), mtime: String(after.mtimeNs), ctime: String(after.ctimeNs) })) {
        fail(`legacy directory changed ${rel}`);
      }
      return true;
    });
    if (!result) add({ path: rel, type: "absent" });
    return Boolean(result);
  };
  return root(context, check, fd => {
    let hasLegacy = false;
    for (const name of ["broker.json", "broker.lock"]) {
      if (!lstat(at(fd, name))) add({ path: name, type: "absent" });
      else { regular(fd, name, name, 65536); hasLegacy = true; }
    }
    for (const name of names(fd, 4096, check)) {
      if (!/^broker\.json\..*\.tmp$/.test(name)) continue;
      if (!BROKER_TEMP.test(name)) fail(`unknown legacy entry ${name}`);
      regular(fd, name, name, 65536);
      hasLegacy = true;
    }
    for (const [name, kind] of [["broker-v2", "broker"], ["direct-start-v1", "direct"]]) {
      if (knownDir(fd, name, name, kind)) hasLegacy = true;
    }
    for (const [name, kind] of [["broker-v3", "broker"], ["direct-start-v2", "direct"]]) {
      const exists = directory(fd, name, check, (namespace, identity) => {
        const namespaceStat = fs.fstatSync(namespace, { bigint: true });
        const namespaceIdentity = { ...identity, nlink: String(namespaceStat.nlink), mtime: String(namespaceStat.mtimeNs), ctime: String(namespaceStat.ctimeNs) };
        add({ path: name, type: "namespace", identity: namespaceIdentity });
        const epochs = names(namespace, 65, check);
        for (const epoch of epochs) {
          if (!EPOCH.test(epoch)) fail(`unknown epoch ${name}/${epoch}`);
          if (epoch === context.epoch) continue;
          if (++counters.epochs > 64) fail("old epoch limit exceeded");
          if (!knownDir(namespace, epoch, `${name}/${epoch}`, kind)) fail("old epoch disappeared");
          hasLegacy = true;
        }
        const current = directory(namespace, context.epoch, check, (_fd, currentIdentity) => {
          add({ path: `${name}/${context.epoch}`, type: "current-epoch", identity: currentIdentity });
          return true;
        }, false, true);
        if (Boolean(current) !== epochs.includes(context.epoch)) fail("current epoch changed during inventory");
        if (!current) add({ path: `${name}/${context.epoch}`, type: "absent" });
        const after = fs.fstatSync(namespace, { bigint: true });
        if (!equal(namespaceIdentity, { ...id(after), nlink: String(after.nlink), mtime: String(after.mtimeNs), ctime: String(after.ctimeNs) })) {
          fail(`namespace changed during inventory ${name}`);
        }
        return true;
      }, false, true);
      if (!exists) {
        add({ path: name, type: "absent" });
        add({ path: `${name}/${context.epoch}`, type: "absent" });
      }
    }
    check();
    return { hasLegacy, entries };
  });
}
function owner(context) {
  return { stateDir: context.stateDir, directoryIdentity: { ...context.directoryIdentity }, hostId: context.hostId,
    volumeGuid: context.volumeGuid ?? null, epoch: context.epoch };
}
function sameOwner(saved, context) {
  // 記録時のパスは証跡として残す。同じ inode を別の親パスから開く場合も同一状態として扱う。
  return typeof saved?.stateDir === "string" && path.isAbsolute(saved.stateDir) &&
    saved.hostId === context.hostId && saved.volumeGuid === (context.volumeGuid ?? null) && saved.epoch === context.epoch &&
    saved.directoryIdentity?.dev === context.directoryIdentity.dev && saved.directoryIdentity?.ino === context.directoryIdentity.ino;
}
function matching(record, context, inventory) {
  const authorized = record?.kind === "initial" ? record.approved === true && !inventory.hasLegacy :
    record?.kind === "offline" && record.offlineConfirmed === true && record.localOnly === true && record.allOldProcessesStopped === true;
  return record?.version === 1 && authorized && sameOwner(record.owner, context) && equal(record.inventory, inventory);
}

/** 呼出し元は同一 state mutex の同期 callback 内に限る。 */
export function snapshotLegacyAdmission(context) { const check = guard(context); return snapshot(context, check); }

function prepareNamespaces(context, check) {
  root(context, check, state => {
    for (const name of ["broker-v3", "direct-start-v2"]) {
      directory(state, name, check, namespace => {
        directory(namespace, context.epoch, check, epoch => { fs.fsyncSync(epoch); return true; }, true, true);
        fs.fsyncSync(namespace);
        return true;
      }, true, true);
    }
    fs.fsyncSync(state);
    check();
  });
}

function writeNew(parent, name, data, check) {
  check();
  const fd = fs.openSync(at(parent, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  let identity;
  try {
    requireSameDevice(parent, fs.fstatSync(fd, { bigint: true }));
    requireSameMount(parent, fd);
    fs.fchmodSync(fd, 0o600);
    let offset = 0;
    while (offset < data.length) {
      check();
      const written = fs.writeSync(fd, data, offset, Math.min(65536, data.length - offset));
      if (!written) fail("recovery write stalled");
      offset += written;
    }
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd, { bigint: true });
    requireSameDevice(parent, stat);
    if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== 0o600n) fail("new recovery file is invalid");
    identity = fileId(stat);
  } finally { fs.closeSync(fd); }
  const checked = readFile(parent, name, Math.max(MAX_RECORD, data.length), { bytes: 0 }, check, false, true);
  if (!equal(checked.identity, identity) || !checked.data.equals(data)) fail("new recovery file changed");
  return checked;
}

function holdFile(parent, name, check, links = [1], max = 4096) {
  check();
  const file = at(parent, name), before = lstat(file);
  if (!before?.isFile() || before.isSymbolicLink() || !links.includes(Number(before.nlink)) ||
      before.uid !== BigInt(process.getuid()) || (before.mode & 0o7777n) !== 0o600n || before.size > BigInt(max)) fail(`invalid held file ${name}`);
  requireSameDevice(parent, before);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    requireSameDevice(parent, opened);
    requireSameMount(parent, fd);
    if (!opened.isFile() || !equal(fileId(opened), fileId(before))) fail(`held file changed ${name}`);
    const data = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < data.length) {
      check();
      const n = fs.readSync(fd, data, offset, Math.min(65536, data.length - offset), offset);
      if (!n) fail(`held file truncated ${name}`);
      offset += n;
    }
    const held = { fd, identity: fileId(opened), data };
    verifyHeld(parent, name, held, Number(opened.nlink), check);
    return held;
  } catch (error) { fs.closeSync(fd); throw error; }
}

function verifyHeld(parent, name, held, links, check, transition = false) {
  check();
  const current = lstat(at(parent, name)), stat = fs.fstatSync(held.fd, { bigint: true });
  requireSameDevice(parent, current);
  requireSameDevice(parent, stat);
  requireSameMount(parent, held.fd);
  if (!current?.isFile() || current.isSymbolicLink() || !stat.isFile() || Number(stat.nlink) !== links ||
      !equal(fileId(current), fileId(stat))) fail(`held file changed ${name}`);
  const now = fileId(stat), old = held.identity;
  verifyNamedFile(parent, name, now);
  if (!equal(id(stat), idFromFileIdentityBase(old)) || now.size !== old.size || now.mtime !== old.mtime ||
      (!transition && (now.ctime !== old.ctime || now.nlink !== old.nlink))) fail(`held file identity changed ${name}`);
  const data = Buffer.alloc(Number(stat.size));
  let offset = 0;
  while (offset < data.length) {
    check();
    const n = fs.readSync(held.fd, data, offset, Math.min(65536, data.length - offset), offset);
    if (!n) fail(`held file truncated ${name}`);
    offset += n;
  }
  const after = fs.fstatSync(held.fd, { bigint: true }), latest = lstat(at(parent, name));
  if (!latest || !equal(fileId(after), now) || !equal(fileId(latest), now) || !data.equals(held.data)) fail(`held file content changed ${name}`);
  verifyNamedFile(parent, name, now);
  held.identity = now;
  check();
}

function idFromFileIdentityBase(value) {
  return { dev: value.dev, ino: value.ino, mode: value.mode, uid: value.uid, gid: value.gid };
}

function verifyCopy(parent, name, copy, data, check, sync = false) {
  const current = readFile(parent, name, 4096, { bytes: 0 }, check, sync, true);
  if (!equal(current.identity, copy.identity) || !current.data.equals(data)) fail("archive changed");
}

function pointerOriginalName(held) {
  return `pointer-original-${held.identity.dev}-${held.identity.ino}.json`;
}

function pointerPair(parent, held, temporary, check) {
  const candidates = [...new Set([temporary, pointerOriginalName(held)].filter(Boolean))];
  const present = candidates.filter(name => lstat(at(parent, name)));
  if (present.length !== 1) fail("linked pointer has no unique known pair");
  verifyHeld(parent, present[0], held, 2, check);
  return present[0];
}

function preservePointer(parent, held, pair, check) {
  const name = `pointer-archive-${randomUUID()}.json`;
  const copy = writeNew(parent, name, held.data, check);
  if (copy.identity.dev === held.identity.dev && copy.identity.ino === held.identity.ino) fail("pointer archive inode is not independent");
  fs.fsyncSync(parent);
  verifyCopy(parent, name, copy, held.data, check);
  verifyHeld(parent, "current.json", held, Number(held.identity.nlink), check);
  if (held.identity.nlink === "1") {
    pair = pointerOriginalName(held);
    if (lstat(at(parent, pair))) fail("pointer preservation name already exists");
    check();
    fs.linkSync(at(parent, "current.json"), at(parent, pair));
    verifyHeld(parent, "current.json", held, 2, check, true);
  }
  verifyHeld(parent, pair, held, 2, check);
  fs.fsyncSync(held.fd);
  fs.fsyncSync(parent);
  verifyHeld(parent, "current.json", held, 2, check);
  verifyHeld(parent, pair, held, 2, check);
  verifyCopy(parent, name, copy, held.data, check);
  return { name, copy, pair };
}

function beginIntent(context, check, state, recovery, attempts, heldFiles) {
  const pending = "pending.json", oldStat = lstat(at(attempts, pending));
  const data = Buffer.from(`${JSON.stringify({ version: 1, epoch: context.epoch, nonce: randomUUID() })}\n`);
  let old = null, archive = null, preserved = null;
  if (oldStat) {
    old = holdFile(attempts, pending, check, [1, 2]);
    heldFiles.push(old);
    const archiveName = `pending-archive-${randomUUID()}.json`;
    const copied = writeNew(attempts, archiveName, old.data, check);
    if (copied.identity.dev === old.identity.dev && copied.identity.ino === old.identity.ino) fail("intent archive inode is not independent");
    fs.fsyncSync(attempts);
    verifyCopy(attempts, archiveName, copied, old.data, check);
    verifyHeld(attempts, pending, old, Number(old.identity.nlink), check);
    preserved = `pending-original-${old.identity.dev}-${old.identity.ino}.json`;
    if (old.identity.nlink === "1") {
      if (lstat(at(attempts, preserved))) fail("intent preservation name already exists");
      check();
      fs.linkSync(at(attempts, pending), at(attempts, preserved));
      verifyHeld(attempts, pending, old, 2, check, true);
    } else if (old.identity.nlink !== "2") fail("invalid intent links");
    verifyHeld(attempts, preserved, old, 2, check);
    fs.fsyncSync(old.fd);
    fs.fsyncSync(attempts);
    verifyHeld(attempts, pending, old, 2, check);
    verifyHeld(attempts, preserved, old, 2, check);
    verifyCopy(attempts, archiveName, copied, old.data, check);
    archive = { name: archiveName, copy: copied, held: old, preserved };
  }
  let next;
  if (old) {
    const temporary = `pending-new-${randomUUID()}.tmp`;
    const staged = writeNew(attempts, temporary, data, check);
    verifyHeld(attempts, pending, old, 2, check);
    verifyHeld(attempts, preserved, old, 2, check);
    check();
    fs.renameSync(at(attempts, temporary), at(attempts, pending));
    fs.fsyncSync(attempts);
    next = readFile(attempts, pending, 4096, { bytes: 0 }, check, false, true);
    if (!next.data.equals(data) || !equal(idFromFileIdentity(next.identity), idFromFileIdentity(staged.identity))) fail("new intent changed");
    verifyHeld(attempts, preserved, old, 1, check, true);
    verifyCopy(attempts, archive.name, archive.copy, old.data, check);
  } else {
    next = writeNew(attempts, pending, data, check);
    fs.fsyncSync(attempts);
  }
  fs.fsyncSync(recovery);
  fs.fsyncSync(state);
  check();
  return { identity: next.identity, data, archive };
}

function verifyIntent(attempts, intent, check, sync = false) {
  const current = readFile(attempts, "pending.json", 4096, { bytes: 0 }, check, sync, true);
  if (!equal(current.identity, intent.identity) || !current.data.equals(intent.data)) fail("active intent changed");
  if (intent.archive) {
    const { held, preserved, name, copy } = intent.archive;
    verifyHeld(attempts, preserved, held, 1, check);
    if (sync) fs.fsyncSync(held.fd);
    verifyCopy(attempts, name, copy, held.data, check, sync);
    verifyHeld(attempts, preserved, held, 1, check);
  }
}

function publish(context, check, inventory, record, initial) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  if (bytes.length > MAX_RECORD) fail("recovery record exceeds size limit");
  root(context, check, state => {
    directory(state, RECOVERY, check, recovery => {
      directory(recovery, context.epoch, check, attempts => {
        const heldFiles = [];
        try {
          const previousStat = lstat(at(attempts, "current.json"));
          if (initial && previousStat) fail("initial recovery pointer already exists");
          let previous = null, oldTemp = null, oldPair = false, pointerArchive = null;
          if (previousStat) {
            previous = holdFile(attempts, "current.json", check, [1, 2]);
            heldFiles.push(previous);
            let reference;
            try { reference = JSON.parse(previous.data.toString("utf8")); } catch { reference = null; }
            if (reference?.attempt && ATTEMPT.test(reference.attempt)) {
              oldTemp = `pointer-${reference.attempt.slice(0, -5)}.tmp`;
            }
            if (previous.identity.nlink === "2") {
              oldTemp = pointerPair(attempts, previous, oldTemp, check);
              oldPair = true;
            } else if (oldTemp && lstat(at(attempts, oldTemp))) {
              fail("unexpected pointer temp");
            }
          }
          const intent = beginIntent(context, check, state, recovery, attempts, heldFiles);
          if (previous) {
            pointerArchive = preservePointer(attempts, previous, oldPair ? oldTemp : null, check);
            oldTemp = pointerArchive.pair;
            oldPair = true;
          }
          const name = `${randomUUID()}.json`;
          const attempt = writeNew(attempts, name, bytes, check);
          fs.fsyncSync(attempts);
          check();
          if (!equal(snapshot(context, check), inventory)) fail("legacy inventory changed during confirmation");
          const pointer = Buffer.from(`${JSON.stringify({ version: 1, attempt: name,
            sha256: createHash("sha256").update(bytes).digest("hex"), identity: attempt.identity })}\n`);
          let published;
          const temporary = `pointer-${name.slice(0, -5)}.tmp`;
          const written = writeNew(attempts, temporary, pointer, check);
          if (initial) {
            check();
            fs.linkSync(at(attempts, temporary), at(attempts, "current.json"));
            fs.fsyncSync(attempts);
            check();
            const temporaryStat = lstat(at(attempts, temporary));
            const publishedStat = lstat(at(attempts, "current.json"));
            if (!temporaryStat?.isFile() || !publishedStat?.isFile() || temporaryStat.isSymbolicLink() || publishedStat.isSymbolicLink() ||
                temporaryStat.nlink !== 2n || publishedStat.nlink !== 2n || !equal(id(temporaryStat), id(publishedStat)) ||
                !equal({ ...id(temporaryStat), nlink: String(temporaryStat.nlink) }, { ...idFromFileIdentity(written.identity), nlink: "2" })) fail("initial pointer link changed");
            check();
            fs.unlinkSync(at(attempts, temporary));
            fs.fsyncSync(attempts);
            published = readFile(attempts, "current.json", 4096, { bytes: 0 }, check, false, true);
            if (!published.data.equals(pointer) || !equal(idFromFileIdentity(published.identity), idFromFileIdentity(written.identity))) fail("initial pointer changed");
          } else {
            if (previous) {
              verifyHeld(attempts, "current.json", previous, Number(previous.identity.nlink), check);
              if (previous.identity.nlink === "2") verifyHeld(attempts, oldTemp, previous, 2, check);
              fs.fsyncSync(previous.fd);
              fs.fsyncSync(attempts);
              verifyHeld(attempts, "current.json", previous, Number(previous.identity.nlink), check);
              if (previous.identity.nlink === "2") verifyHeld(attempts, oldTemp, previous, 2, check);
            } else if (lstat(at(attempts, "current.json"))) fail("recovery pointer appeared");
            verifyIntent(attempts, intent, check, true);
            check();
            fs.renameSync(at(attempts, temporary), at(attempts, "current.json"));
            if (oldPair) {
              verifyHeld(attempts, oldTemp, previous, 1, check, true);
              verifyCopy(attempts, pointerArchive.name, pointerArchive.copy, previous.data, check);
            }
            published = readFile(attempts, "current.json", 4096, { bytes: 0 }, check, true, true);
            if (!published.data.equals(pointer) || !equal(idFromFileIdentity(published.identity), idFromFileIdentity(written.identity))) fail("published pointer changed");
          }
          fs.fsyncSync(attempts);
          const finalPointer = readFile(attempts, "current.json", 4096, { bytes: 0 }, check, true, true);
          const finalAttempt = readFile(attempts, name, MAX_RECORD, { bytes: 0 }, check, true, true);
          if (!equal(finalPointer.identity, published.identity) || !finalPointer.data.equals(pointer) ||
              !equal(finalAttempt.identity, attempt.identity) || !finalAttempt.data.equals(bytes)) fail("published recovery changed");
          if (!equal(snapshot(context, check), inventory)) fail("legacy inventory changed after confirmation");
          if (oldPair) {
            verifyHeld(attempts, oldTemp, previous, 1, check);
            fs.fsyncSync(previous.fd);
            verifyHeld(attempts, oldTemp, previous, 1, check);
            verifyCopy(attempts, pointerArchive.name, pointerArchive.copy, previous.data, check, true);
          }
          verifyIntent(attempts, intent, check, true);
          fs.fsyncSync(attempts);
          fs.fsyncSync(recovery);
          fs.fsyncSync(state);
          check();
          verifyIntent(attempts, intent, check);
          const readyPointer = readFile(attempts, "current.json", 4096, { bytes: 0 }, check, false, true);
          const readyAttempt = readFile(attempts, name, MAX_RECORD, { bytes: 0 }, check, false, true);
          if (!equal(readyPointer.identity, published.identity) || !readyPointer.data.equals(pointer) ||
              !equal(readyAttempt.identity, attempt.identity) || !readyAttempt.data.equals(bytes)) fail("recovery changed before intent release");
          if (!equal(snapshot(context, check), inventory)) fail("legacy inventory changed before intent release");
          if (oldPair) {
            verifyHeld(attempts, oldTemp, previous, 1, check);
            verifyCopy(attempts, pointerArchive.name, pointerArchive.copy, previous.data, check);
          }
          verifyIntent(attempts, intent, check);
          fs.unlinkSync(at(attempts, "pending.json"));
          fs.fsyncSync(attempts);
          return true;
        } finally {
          for (const held of heldFiles) fs.closeSync(held.fd);
        }
      }, true, true);
      fs.fsyncSync(recovery);
      return true;
    }, true, true);
    fs.fsyncSync(state);
    check();
  });
  if (!equal(snapshot(context, check), inventory)) fail("legacy inventory changed after confirmation");
  check();
}

function idFromFileIdentity(value) {
  return { dev: value.dev, ino: value.ino, mode: value.mode, uid: value.uid, gid: value.gid, nlink: value.nlink };
}

/** 新規 marker の初回確定中にのみ呼ぶ。既存 marker から初期化を再試行しない。 */
export function initializeLinuxEpochRecovery(context) {
  const check = guard(context);
  snapshot(context, check);
  prepareNamespaces(context, check);
  const inventory = snapshot(context, check);
  const record = { version: 1, kind: "initial", approved: !inventory.hasLegacy, owner: owner(context), inventory };
  publish(context, check, inventory, record, true);
  return { epoch: context.epoch, approved: record.approved };
}

/** 全旧プロセス停止を本人が確認した操作だけが新しい attempt を追加できる。
 * @param {any} context
 * @param {{ offlineConfirmed?: boolean, localOnly?: boolean, expectedStateDir?: string, allOldProcessesStopped?: boolean }} options
 */
export function createLinuxEpochRecovery(context, options = {}) {
  const check = guard(context);
  if (options.offlineConfirmed !== true || options.localOnly !== true || options.allOldProcessesStopped !== true ||
      options.expectedStateDir !== context.stateDir) fail("explicit offline confirmation and exact state directory are required");
  snapshot(context, check);
  prepareNamespaces(context, check);
  const inventory = snapshot(context, check);
  const record = { version: 1, kind: "offline", offlineConfirmed: true, localOnly: true, allOldProcessesStopped: true,
    owner: owner(context), inventory };
  publish(context, check, inventory, record, false);
  return { epoch: context.epoch };
}

/** 可視な attempt を信頼せず、読取り後の fsync と旧 inventory の再照合を必須にする。 */
export function requireLinuxEpochRecovery(context) {
  const check = guard(context), inventory = snapshot(context, check);
  const found = root(context, check, fd => {
    const result = directory(fd, RECOVERY, check, recovery => {
      const attempt = directory(recovery, context.epoch, check, attempts => {
        if (lstat(at(attempts, "pending.json"))) fail("recovery intent is pending");
        const pointer = readFile(attempts, "current.json", 4096, { bytes: 0 }, check, false, true);
        let reference;
        try { reference = JSON.parse(pointer.data.toString("utf8")); } catch { fail("invalid recovery pointer"); }
        if (reference?.version !== 1 || !ATTEMPT.test(reference.attempt ?? "") || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? "")) fail("invalid recovery pointer");
        const selected = readFile(attempts, reference.attempt, MAX_RECORD, { bytes: 0 }, check, true, true);
        if (!equal(selected.identity, reference.identity) || createHash("sha256").update(selected.data).digest("hex") !== reference.sha256) fail("recovery attempt changed");
        let record;
        try { record = JSON.parse(selected.data.toString("utf8")); } catch { fail("invalid recovery attempt"); }
        if (!matching(record, context, inventory)) fail("explicit offline recovery is required");
        const syncedPointer = readFile(attempts, "current.json", 4096, { bytes: 0 }, check, true, true);
        if (!equal(syncedPointer.identity, pointer.identity) || !syncedPointer.data.equals(pointer.data)) fail("recovery pointer changed");
        fs.fsyncSync(attempts);
        check();
        const finalPointer = readFile(attempts, "current.json", 4096, { bytes: 0 }, check, false, true);
        const finalAttempt = readFile(attempts, reference.attempt, MAX_RECORD, { bytes: 0 }, check, false, true);
        if (!equal(finalPointer.identity, pointer.identity) || !finalPointer.data.equals(pointer.data) ||
            !equal(finalAttempt.identity, selected.identity) || !finalAttempt.data.equals(selected.data)) fail("recovery changed after sync");
        return true;
      }, false, true);
      if (attempt) fs.fsyncSync(recovery);
      return attempt;
    }, false, true);
    if (result) fs.fsyncSync(fd);
    return result;
  });
  if (!found) fail("explicit offline recovery is required");
  if (!equal(snapshot(context, check), inventory)) fail("legacy inventory changed after confirmation");
  const clear = root(context, check, state => directory(state, RECOVERY, check, recovery =>
    directory(recovery, context.epoch, check, attempts => {
      if (lstat(at(attempts, "pending.json"))) fail("recovery intent is pending");
      return true;
    }, false, true), false, true));
  if (!clear) fail("recovery directory is unavailable");
  check();
}
