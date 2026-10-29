import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 旧ファイル名を維持するが、この E2E は実 Linux kernel の procfs/mount/flock、
// 実 broker/CLI と2個の実 task を使う。50件の履歴だけは合成 fixture。
// 履歴 prune transaction は未統合なので自動削除は検証しない。
for (const mode of ["changed", "unchanged"]) test(`Linux broker resume ${mode === "changed" ? "rejects a changed candidate" : "succeeds with the original candidate"} and preserves history`, {
  skip: process.platform !== "linux" ? "requires native Linux procfs, mount and flock" : false, timeout: 175000
}, t => {
  const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  let root = makeTempDir("grok-resume-"), rootIdentity, verifiedDone = false;
  t.after(() => {
    try {
      if (verifiedDone) {
        const current = fs.lstatSync(root, { bigint: true });
        assert.ok(current.isDirectory() && !current.isSymbolicLink() && fs.realpathSync(root) === root);
        assert.equal(current.dev, rootIdentity.dev); assert.equal(current.ino, rootIdentity.ino);
        removeTempFixture(root, { recursive: true, force: true });
      } else t.diagnostic(`Retained broker resume fixture: ${root}`);
    } catch (error) {
      t.diagnostic(`Retained broker resume fixture; cleanup failed: ${root}`);
      throw error;
    } finally {
      for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  root = fs.realpathSync(root);
  rootIdentity = fs.lstatSync(root, { bigint: true });
  assert.ok(rootIdentity.isDirectory() && !rootIdentity.isSymbolicLink());
  assert.ok([0xef53, 0x01021994].includes(Number(fs.statfsSync(root).type)), "native Linux E2E requires local ext4 or tmpfs");
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const preload = fileURLToPath(new URL("./fixtures/linux-history-resume-observer.mjs", import.meta.url));
  const scenario = fileURLToPath(new URL("./fixtures/linux-history-resume-scenario.mjs", import.meta.url));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    GROK_RESUME_CONTROL: mode === "unchanged" ? "1" : "0",
    NODE_OPTIONS: `--import ${JSON.stringify(preload)}` };
  delete env.PLUGIN_DATA;
  const result = spawnSync(process.execPath, [scenario], { env, encoding: "utf8", timeout: 155000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.kind, "history-resume-stopped-v1");
  assert.equal(proof.root, root); assert.equal(proof.rootDev, String(rootIdentity.dev)); assert.equal(proof.rootIno, String(rootIdentity.ino));
  assert.equal(proof.stateDir, stateDir);
  for (const key of ["resumeStopped", "brokerGroupStopped", "brokerAgentStopped", "directGroupStopped", "sentinelStopped"]) assert.equal(proof[key], true);
  const markerPath = path.join(stateDir, "state.lock", "protocol.json"), marker = fs.readFileSync(markerPath);
  const markerStat = fs.lstatSync(markerPath, { bigint: true });
  assert.ok(markerStat.isFile() && !markerStat.isSymbolicLink());
  assert.equal(proof.markerDev, String(markerStat.dev)); assert.equal(proof.markerIno, String(markerStat.ino));
  assert.equal(proof.markerSha256, createHash("sha256").update(marker).digest("hex"));
  assert.equal(JSON.parse(marker).epoch, proof.epoch);
  const spawnMarker = path.join(root, "direct-spawn-new-task");
  const attempt = JSON.parse(fs.readFileSync(`${spawnMarker}.attempt`, "utf8"));
  const spawned = JSON.parse(fs.readFileSync(spawnMarker, "utf8"));
  assert.ok(Number.isSafeInteger(spawned.pid) && spawned.pid > 0);
  assert.equal(spawned.group, spawned.pid);
  assert.ok(Number.isSafeInteger(spawned.owner) && spawned.owner > 0);
  assert.equal(attempt.owner, spawned.owner);
  assert.equal(fs.readFileSync(path.join(root, `marker-preload-ready-${spawned.owner}`), "utf8"), "ready");
  verifiedDone = true;
});
