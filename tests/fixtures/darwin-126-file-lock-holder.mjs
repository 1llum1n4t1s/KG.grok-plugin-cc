import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// 配布 1.0.26 の state.mjs:189-232 の取得・解放手順を固定した fixture。
// テスト側は callback 中のこの直子を SIGKILL し、実際に保持中だった lock を残す。
const stateDir = process.argv[2];
if (process.platform !== "darwin" || !stateDir || !path.isAbsolute(stateDir) ||
    fs.realpathSync.native(stateDir) !== stateDir || !fs.lstatSync(stateDir).isDirectory()) {
  throw new Error("Legacy holder requires an isolated real Darwin state directory");
}
const STATE_LOCK_STALE_MS = 10000;
const STATE_LOCK_RETRY_LIMIT = 50;
const STATE_LOCK_RETRY_INTERVAL_MS = 10;
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
function ensureStateDir(cwd) { fs.mkdirSync(path.join(cwd, "jobs"), { recursive: true, mode: 0o700 }); }
function resolveStateLockFile(cwd) { return path.join(cwd, "state.lock"); }

function withStateLock(cwd, run) {
  ensureStateDir(cwd);
  const lockFile = resolveStateLockFile(cwd);
  let held = false;
  for (let attempt = 0; attempt < STATE_LOCK_RETRY_LIMIT && !held; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
      held = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") break;
    }
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > STATE_LOCK_STALE_MS) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
    } catch { continue; }
    Atomics.wait(SLEEP_SIGNAL, 0, 0, STATE_LOCK_RETRY_INTERVAL_MS);
  }
  if (!held) throw new Error(`Timed out acquiring Grok state lock: ${lockFile}`);
  try { return run(); }
  finally {
    if (held) {
      try { fs.rmSync(lockFile, { force: true }); }
      catch { /* 配布版と同じ best effort */ }
    }
  }
}

withStateLock(stateDir, () => {
  fs.writeSync(1, "LEGACY_LOCK_HELD\n");
  Atomics.wait(SLEEP_SIGNAL, 0, 0, 60000);
});
