// Mac 上の実 Node 子プロセスと IPC を使う。以下の /proc、namespace、mount、
// flock は fixture であり、Linux カーネルの挙動を検証するものではない。
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";

const original = {
  open: fs.openSync, close: fs.closeSync, read: fs.readFileSync,
  readlink: fs.readlinkSync, spawn: childProcess.spawnSync
};
const opened = new Map();
let nextFlockFailure = false;
const procPath = value => {
  if (typeof value !== "string") return value;
  const match = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(value);
  if (!match) return value;
  const base = opened.get(Number(match[1]));
  if (!base) throw Object.assign(new Error("fixture FD is unavailable"), { code: "ENOENT" });
  return path.join(base, match[2] ?? "");
};
Object.defineProperty(process, "platform", { value: "linux" });
fs.openSync = function (target, ...args) {
  const actual = procPath(target);
  const fd = original.open.call(this, actual, ...args);
  if (typeof actual === "string") opened.set(fd, actual);
  return fd;
};
fs.closeSync = function (fd) { opened.delete(fd); return original.close.call(this, fd); };
for (const method of ["statSync", "lstatSync", "readdirSync"]) {
  const real = fs[method];
  fs[method] = function (target, ...args) { return real.call(this, procPath(target), ...args); };
}
fs.readFileSync = function (target, ...args) {
  if (typeof target === "string" && /^\/proc\/(self|\d+)\/fdinfo\/\d+$/.test(target)) return "mnt_id:\t41\n";
  if (target === "/proc/sys/kernel/random/boot_id") return "fixture-boot-id\n";
  if (typeof target === "string" && /^\/proc\/\d+\/stat$/.test(target)) return `${process.pid} (fixture) S ${Array(19).fill("123456").join(" ")}\n`;
  return original.read.call(this, procPath(target), ...args);
};
fs.readlinkSync = function (target, ...args) {
  if (typeof target === "string" && /^\/proc\/(self|\d+)\/ns\//.test(target)) return `fixture-${path.basename(target)}`;
  return original.readlink.call(this, procPath(target), ...args);
};
childProcess.spawnSync = function (command, args, options) {
  if (path.basename(command) === "flock") {
    if (nextFlockFailure) {
      nextFlockFailure = false;
      return { status: 1, signal: null };
    }
    // Mac lockf は Linux flock の代用品。FD の競合を模擬するだけである。
    const result = original.spawn.call(this, "/usr/bin/lockf", ["-s", "-t", "0", "3"], options);
    if (result.status === 75) result.status = 200; // lockf の競合を fixture の専用競合値に対応させる。
    return result;
  }
  return original.spawn.call(this, command, args, options);
};
syncBuiltinESMExports();

const { acquireLinuxWorkerLease, validateOwnedLinuxWorkerLease, releaseLinuxWorkerLease, withAvailableLinuxLease } = await import("../../plugins/grok/scripts/lib/linux-worker-lease.mjs");
const claimToken = "33333333-3333-4333-8333-333333333333";
const identity = directory => {
  const stat = fs.lstatSync(directory, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino) };
};
// 実際の mutex・sentinel・protocol 検証はここでは模擬する。root FD と
// epoch directory の inode は実 filesystem のものを使う。
const context = (directory, stateGeneration, rootFd, lease) => ({
  stateDir: directory, directoryIdentity: identity(directory), rootFd,
  expectedDirectoryIdentity: identity(lease ? path.dirname(lease.path) : path.join(directory, "worker-leases-v1", stateGeneration)),
  epoch: stateGeneration, protocol: "posix-linux-worker-lease-v6", check() {}
});
const probe = ({ directory, stateGeneration, lease, contend }) => {
  let callbackCount = 0, nested;
  const rootFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
  const result = withAvailableLinuxLease(lease, context(directory, stateGeneration, rootFd, lease), () => {
    callbackCount++;
    if (contend) {
      const input = Buffer.from(JSON.stringify({ directory, stateGeneration, lease })).toString("base64url");
      const child = childProcess.spawnSync(process.execPath, [process.argv[1], "probe", input], { encoding: "utf8", timeout: 5000 });
      if (child.error || child.status !== 0) throw new Error(`nested probe failed: ${child.error ?? child.stderr}`);
      nested = JSON.parse(child.stdout);
    }
    return "committed";
  });
  return { result, callbackCount, nested };
  } finally { fs.closeSync(rootFd); }
};
if (process.argv[2] === "probe") {
  process.stdout.write(JSON.stringify(probe(JSON.parse(Buffer.from(process.argv[3], "base64url")))));
} else {
  const [request] = await once(process, "message");
  try {
    if (request.action === "probe") {
      process.send(probe(request), () => process.disconnect());
    } else if (request.action === "async-check") {
      const rootFd = fs.openSync(request.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      const ctx = context(request.directory, request.stateGeneration, rootFd, request.lease);
      ctx.check = () => Promise.reject(new Error("fixture check rejection"));
      let unhandled = false, callbackCount = 0;
      const onUnhandled = () => { unhandled = true; };
      process.on("unhandledRejection", onUnhandled);
      const result = withAvailableLinuxLease(request.lease, ctx, () => { callbackCount++; });
      await new Promise(resolve => setImmediate(resolve));
      process.off("unhandledRejection", onUnhandled);
      fs.closeSync(rootFd);
      process.send({ type: "async-check-result", result, callbackCount, unhandled }, () => process.disconnect());
    } else if (request.action === "reject-thenable") {
      const rootFd = fs.openSync(request.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      let message, unhandled = false;
      const onUnhandled = () => { unhandled = true; };
      process.on("unhandledRejection", onUnhandled);
      try {
        withAvailableLinuxLease(request.lease, context(request.directory, request.stateGeneration, rootFd, request.lease), () => Promise.reject(new Error("fixture rejection")));
      } catch (error) { message = error.message; }
      await new Promise(resolve => setImmediate(resolve));
      process.off("unhandledRejection", onUnhandled);
      fs.closeSync(rootFd);
      process.send({ type: "thenable-result", message, unhandled }, () => process.disconnect());
    } else if (["forged-fd", "reused-fd"].includes(request.action)) {
      const rootFd = fs.openSync(request.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      const ctx = context(request.directory, request.stateGeneration, rootFd);
      const owner = acquireLinuxWorkerLease({ context: ctx, slot: 0, claimToken });
      let fd, sameNumber = false, accepted = false;
      // fixture の open interception で事故を注入する。製品 API は FD を公開しない。
      const ownerFd = [...opened.entries()].find(([, file]) => file === owner.lease.path)?.[0];
      if (!Number.isInteger(ownerFd)) throw new Error("fixture could not locate owner FD");
      const fillers = [];
      if (request.action === "reused-fd") {
        fs.closeSync(ownerFd);
        do {
          fd = fs.openSync(owner.lease.path, fs.constants.O_RDONLY);
          if (fd < ownerFd) fillers.push(fd);
        } while (fd < ownerFd);
      } else fd = fs.openSync(owner.lease.path, fs.constants.O_RDONLY);
      sameNumber = fd === ownerFd;
      try { accepted = validateOwnedLinuxWorkerLease({ ...(request.action === "reused-fd" ? { owner: owner.owner } : { fd }), lease: owner.lease, context: ctx, claimToken }) === true; }
      catch { /* 所有していない FD は受理しない。 */ }
      fs.closeSync(fd);
      for (const filler of fillers) fs.closeSync(filler);
      if (request.action !== "reused-fd") releaseLinuxWorkerLease(owner.owner);
      fs.closeSync(rootFd);
      process.send({ type: "ownership-result", accepted, sameNumber }, () => process.disconnect());
    } else if (request.action === "owner-lifecycle") {
      const rootFd = fs.openSync(request.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      const ctx = context(request.directory, request.stateGeneration, rootFd);
      let acceptedV4 = false, acceptedV5 = false;
      try { acquireLinuxWorkerLease({ context: { ...ctx, protocol: "posix-linux-worker-lease-v4" }, slot: 1, claimToken }); acceptedV4 = true; } catch {}
      try { acquireLinuxWorkerLease({ context: { ...ctx, protocol: "posix-linux-worker-lease-v5" }, slot: 2, claimToken }); acceptedV5 = true; } catch {}
      const owned = acquireLinuxWorkerLease({ context: ctx, slot: 0, claimToken });
      const valid = validateOwnedLinuxWorkerLease({ owner: owned.owner, lease: owned.lease, context: ctx, claimToken });
      let forged = false, wrongEpoch = false, wrongClaim = false, afterRelease = false;
      try { validateOwnedLinuxWorkerLease({ owner: {}, lease: owned.lease, context: ctx, claimToken }); forged = true; } catch {}
      try { validateOwnedLinuxWorkerLease({ owner: owned.owner, lease: owned.lease, context: { ...ctx, epoch: "22222222-2222-4222-8222-222222222222" }, claimToken }); wrongEpoch = true; } catch {}
      try { validateOwnedLinuxWorkerLease({ owner: owned.owner, lease: owned.lease, context: ctx, claimToken: "44444444-4444-4444-8444-444444444444" }); wrongClaim = true; } catch {}
      const released = releaseLinuxWorkerLease(owned.owner);
      try { validateOwnedLinuxWorkerLease({ owner: owned.owner, lease: owned.lease, context: ctx, claimToken }); afterRelease = true; } catch {}
      const releasedAgain = releaseLinuxWorkerLease(owned.owner);
      fs.closeSync(rootFd);
      process.send({ type: "lifecycle-result", fdExposed: Object.hasOwn(owned, "fd"), valid, forged, wrongEpoch, wrongClaim, acceptedV4, acceptedV5, released, afterRelease, releasedAgain }, () => process.disconnect());
    } else if (request.action === "flock-error") {
      const rootFd = fs.openSync(request.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      const ctx = context(request.directory, request.stateGeneration, rootFd);
      const owned = acquireLinuxWorkerLease({ context: ctx, slot: 0, claimToken });
      nextFlockFailure = true;
      let accepted = false;
      try { accepted = validateOwnedLinuxWorkerLease({ owner: owned.owner, lease: owned.lease, context: ctx, claimToken }); } catch {}
      fs.closeSync(rootFd);
      process.send({ type: "flock-error-result", accepted }, () => process.disconnect());
    } else {
      const { directory, stateGeneration, slot = 0, descendantMarker } = request;
      const rootFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      const owner = acquireLinuxWorkerLease({ context: context(directory, stateGeneration, rootFd), slot, claimToken });
      if (descendantMarker) childProcess.spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'done'), 3000)", descendantMarker], { stdio: "ignore" });
      process.send({ type: "acquired", lease: owner.lease });
      await once(process, "message");
      releaseLinuxWorkerLease(owner.owner);
      fs.closeSync(rootFd);
      process.disconnect();
    }
  } catch (error) {
    process.send({ type: "error", message: error.stack ?? String(error) }, () => process.disconnect());
  }
}
