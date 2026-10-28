// テスト用 OS 境界 gate。製品には試験専用 hook を追加しない。
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const open = fs.openSync;
const close = fs.closeSync;
const sync = fs.fsyncSync;
const unlink = fs.unlinkSync;
const rename = fs.renameSync;
const paths = new Map();
let gated = false;
let pendingDirectory;
let pendingUnlinkDirectory;
let observedBinding;
let pendingDetailDirectory;
let pendingIndexDirectory;
let pendingLedgerSource;
let pendingLedgerDirectory;

function pause(name, binding) {
  gated = true;
  fs.writeFileSync(process.env.GROK_SWEEP_TEST_READY, JSON.stringify({ name, binding }), { mode: 0o600 });
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(process.env.GROK_SWEEP_TEST_RELEASE) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!fs.existsSync(process.env.GROK_SWEEP_TEST_RELEASE)) throw new Error("binding fsync gate timed out");
}

fs.openSync = function (name, ...args) {
  const fd = open.call(this, name, ...args);
  if (typeof name === "string") paths.set(fd, path.resolve(name));
  return fd;
};
fs.closeSync = function (fd) {
  try { return close.call(this, fd); } finally { paths.delete(fd); }
};
fs.unlinkSync = function (name, ...args) {
  const result = unlink.call(this, name, ...args);
  if (["fail-unlink-directory-sync", "kill-before-unlink-directory-sync"].includes(process.env.GROK_SWEEP_TEST_MODE)
      && typeof name === "string" && path.resolve(name) === process.env.GROK_SWEEP_TEST_UNLINK) {
    pendingUnlinkDirectory = path.dirname(path.resolve(name));
  }
  return result;
};
fs.renameSync = function (from, to, ...args) {
  const result = rename.call(this, from, to, ...args);
  if (!gated && pendingLedgerSource && typeof from === "string" && typeof to === "string"
      && path.resolve(from) === pendingLedgerSource) pendingLedgerDirectory = path.dirname(path.resolve(to));
  if (!gated && process.env.GROK_SWEEP_TEST_MODE === "pause-after-queued-index-sync" && observedBinding && typeof to === "string"
      && path.basename(to) === "state.json") {
    try {
      const state = JSON.parse(fs.readFileSync(to, "utf8"));
      if (state.jobs?.some(job => job.id === observedBinding.binding.jobId && job.claimToken === observedBinding.binding.claimToken
          && job.status === "queued")) pendingIndexDirectory = path.dirname(path.resolve(to));
    } catch { /* state 以外の rename。 */ }
  }
  if (!gated && process.env.GROK_SWEEP_TEST_MODE === "kill-after-detail-sync" && observedBinding && typeof to === "string") {
    try {
      const detail = JSON.parse(fs.readFileSync(to, "utf8"));
      if (detail.id === observedBinding.binding.jobId && detail.claimToken === observedBinding.binding.claimToken
          && detail.workerLease?.ino === observedBinding.binding.lease.ino) pendingDetailDirectory = path.dirname(path.resolve(to));
    } catch { /* detail 以外の rename。 */ }
  }
  return result;
};
fs.fsyncSync = function (fd) {
  const name = paths.get(fd);
  if (!gated && pendingIndexDirectory && name === pendingIndexDirectory) {
    sync.call(this, fd);
    pause(observedBinding.name, observedBinding.binding);
    return;
  }
  if (!gated && pendingLedgerDirectory && name === pendingLedgerDirectory) {
    sync.call(this, fd);
    pause(observedBinding.name, observedBinding.binding);
    return;
  }
  if (!gated && process.env.GROK_SWEEP_TEST_MODE === "fail-reader-sync" && name === process.env.GROK_SWEEP_TEST_DIRECTORY) {
    gated = true;
    fs.writeFileSync(process.env.GROK_SWEEP_TEST_READY, JSON.stringify({ name }), { mode: 0o600 });
    const error = new Error("injected reader directory fsync failure");
    error.code = "EIO";
    throw error;
  }
  if (!gated && pendingDetailDirectory && name === pendingDetailDirectory) {
    sync.call(this, fd);
    pause(observedBinding.name, observedBinding.binding);
    return;
  }
  if (!gated && pendingUnlinkDirectory && name === pendingUnlinkDirectory) {
    if (process.env.GROK_SWEEP_TEST_MODE === "kill-before-unlink-directory-sync") {
      pause(name, null);
      return;
    }
    gated = true;
    fs.writeFileSync(process.env.GROK_SWEEP_TEST_READY, JSON.stringify({ name }), { mode: 0o600 });
    const error = new Error("injected unlink directory fsync failure");
    error.code = "EIO";
    throw error;
  }
  if (!gated && pendingDirectory && name === path.dirname(pendingDirectory.name)) {
    sync.call(this, fd);
    pause(pendingDirectory.name, pendingDirectory.binding);
    return;
  }
  let binding;
  if (!gated && name && path.relative(process.env.GROK_SWEEP_TEST_ROOT, name)
      && !path.relative(process.env.GROK_SWEEP_TEST_ROOT, name).startsWith(`..${path.sep}`)) {
    try {
      const stat = fs.lstatSync(name);
      if (stat.isFile() && stat.size < 65536) binding = JSON.parse(fs.readFileSync(name, "utf8"));
    } catch { /* binding 以外の fsync は通常どおり実行する。 */ }
  }
  if (!gated && process.env.GROK_SWEEP_TEST_MODE === "kill-after-reserved-identity" && observedBinding
      && binding?.protocol === "darwin-lease-ledger-v1" && Array.isArray(binding.slots)) {
    const slot = binding.slots.find(item => item.jobId === observedBinding.binding.jobId);
    const bindingStat = fs.lstatSync(observedBinding.name, { bigint: true });
    const bindingInode = slot?.binding?.ino ?? slot?.bindingIno;
    if (slot?.state === "reserved" && slot.claimToken === observedBinding.binding.claimToken
        && binding.epoch === observedBinding.binding.epoch && slot.slot === observedBinding.binding.slot
        && ["id", "path", "dev", "ino", "stateGeneration"].every(key => slot.lease?.[key] === observedBinding.binding.lease[key])
        && String(bindingInode) === String(bindingStat.ino) && String(bindingStat.dev) === slot.lease.dev) {
      sync.call(this, fd);
      pendingLedgerSource = name;
      return;
    }
  }
  if (binding && binding.jobId === process.env.GROK_SWEEP_TEST_JOB && binding.claimToken
      && binding.epoch && binding.lease?.path && binding.lease?.dev && binding.lease?.ino) {
    if (process.env.GROK_SWEEP_TEST_MODE === "pause-after-queued-index-sync") {
      sync.call(this, fd);
      observedBinding = { name, binding };
      return;
    }
    if (process.env.GROK_SWEEP_TEST_MODE === "kill-after-reserved-identity") {
      sync.call(this, fd);
      observedBinding = { name, binding };
      return;
    }
    if (process.env.GROK_SWEEP_TEST_MODE === "kill-after-detail-sync") {
      sync.call(this, fd);
      observedBinding = { name, binding };
      return;
    }
    if (process.env.GROK_SWEEP_TEST_MODE === "kill-after-directory-sync") {
      sync.call(this, fd);
      pendingDirectory = { name, binding };
      return;
    }
    if (process.env.GROK_SWEEP_TEST_MODE === "kill-after-file-sync") sync.call(this, fd);
    if (process.env.GROK_SWEEP_TEST_MODE === "fail-file-sync") {
      gated = true;
      fs.writeFileSync(process.env.GROK_SWEEP_TEST_READY, JSON.stringify({ name, binding }), { mode: 0o600 });
      const error = new Error("injected binding fsync failure");
      error.code = "EIO";
      throw error;
    }
    pause(name, binding);
    return;
  }
  return sync.call(this, fd);
};
syncBuiltinESMExports();
