import fs from "node:fs";
import path from "node:path";

// 出荷済み 1.0.26 の state.mjs と同じ file-lock / 既定 state / 原子的な保存を再現する。
// この版は broker-admission を生成しない。混在 journal は呼出側が明示的に合成する。
const stateDir = process.argv[2];
const retainLock = process.argv[3] === "retain-lock";
if (process.platform !== "darwin" || !stateDir || !path.isAbsolute(stateDir) ||
    fs.realpathSync.native(stateDir) !== stateDir || !fs.lstatSync(stateDir).isDirectory()) {
  throw new Error("Legacy fixture requires an isolated real Darwin state directory");
}
const jobsDir = path.join(stateDir, "jobs"), lockFile = path.join(stateDir, "state.lock");
const stateFile = path.join(stateDir, "state.json");
const temporary = `${stateFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
try {
  const state = { version: 1, config: { stopReviewGate: false }, jobs: [], reviewGateSessions: [] };
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, stateFile);
  try { fs.chmodSync(stateFile, 0o600); } catch { /* 同版と同じ best effort */ }
} finally {
  if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  // 旧 writer が lock 保持中に終了した状態を、子プロセスが終了する直前に再現する。
  if (!retainLock) fs.rmSync(lockFile, { force: true });
}
