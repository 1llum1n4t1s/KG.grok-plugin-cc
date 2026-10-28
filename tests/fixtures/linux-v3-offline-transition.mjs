// Mac 模擬 E2E 専用 orchestrator。旧 CLI は fixture のコピー、すべての
// 移動・書込みは孤立した state directory 内だけ。意図的な process exit を注入する。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [oldCli, newCli, workspace, stateDir, stage] = process.argv.slice(2);
const root = process.env.GROK_LINUX_SIM_ROOT;
if (!root || !stateDir.startsWith(`${root}${path.sep}`) || !oldCli.startsWith(`${root}${path.sep}`) ||
    !["stop", "backup", "marker", "normal", "after-stop", "after-backup", "after-marker"].includes(stage)) throw new Error("unsafe transition fixture paths");
const args = ["--offline-confirmed", "--local-only", "--expected-state-dir", stateDir, "--cwd", workspace];
const run = (cli, operation, env = process.env) => spawnSync(process.execPath, [cli, "state-lock", operation, ...args], { env, encoding: "utf8", timeout: 15000 });
const syncDir = dir => { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
if (!["after-stop", "after-backup", "after-marker"].includes(stage)) {
  const stopped = run(oldCli, "stop-sentinel");
  if (stopped.status !== 0) throw new Error(`old sentinel stop failed: ${stopped.stderr}`);
}
if (stage === "stop") process.exit(73);
const barrier = path.join(stateDir, "state.lock"), backup = path.join(stateDir, "v3-barrier-backup"), saved = path.join(backup, "state.lock");
const preserve = (source, destination) => {
  const before = fs.lstatSync(source, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("barrier is not a directory");
  // 排他的に作った専用親を使う。Linux RENAME_NOREPLACE の実証ではない。
  fs.mkdirSync(destination, { mode: 0o700 }); syncDir(stateDir);
  const target = path.join(destination, "state.lock");
  if (fs.existsSync(target)) throw new Error("backup target exists");
  fs.renameSync(source, target); syncDir(destination); syncDir(stateDir);
  const after = fs.lstatSync(target, { bigint: true });
  if (fs.existsSync(source) || before.dev !== after.dev || before.ino !== after.ino) throw new Error("barrier preservation failed");
};
if (stage === "after-marker") {
  if (!fs.existsSync(saved)) throw new Error("old barrier backup is unavailable");
  preserve(barrier, path.join(stateDir, "interrupted-barrier-backup"));
} else if (stage === "after-backup") {
  if (!fs.existsSync(saved) || fs.existsSync(barrier)) throw new Error("old barrier backup state is invalid");
} else preserve(barrier, backup);
if (stage === "backup") process.exit(73);
const migrated = run(newCli, "migrate", stage === "marker" ? { ...process.env, GROK_LINUX_SIM_ABORT_MARKER: "1" } : process.env);
if (stage === "marker") {
  if (migrated.status === 0) throw new Error("marker interruption did not fail");
  process.exit(73);
}
if (migrated.status !== 0) throw new Error(`new migration failed: ${migrated.stderr}`);
process.stdout.write("complete\n");
