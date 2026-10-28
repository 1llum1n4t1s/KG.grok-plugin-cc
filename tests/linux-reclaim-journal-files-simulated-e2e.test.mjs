import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as nodeModule from "node:module";
import test from "node:test";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 故障条件: 別 mount・置換・リンク・権限・サイズ/hash の変化や、
// 到達不能な index/detail の組合せを正しい snapshot とみなす。
// 実 Mac FD と fs を使い procfs/mount を模擬する。Linux kernel は未検証。
for (const mode of ["old", "detail-post", "both-post", "digest", "source-changed", "source-replaced",
  "symlink", "hardlink", "mode", "mount", "named-jobs-mount", "named-journal-mount",
  "post-named-jobs-mount", "post-named-journal-mount", "post-named-namespace-mount",
  "flag-O_DIRECTORY-missing", "flag-O_DIRECTORY-zero", "flag-O_NOFOLLOW-missing", "flag-O_NOFOLLOW-zero",
  "flag-O_NONBLOCK-missing", "flag-O_NONBLOCK-zero",
  "budget", "deadline", "journal-not-directory", "index-post-first"]) {
  test(`Linux reclaim snapshot files: ${mode}`, {
    skip: process.platform !== "darwin" || (mode.startsWith("flag-") && typeof nodeModule.registerHooks !== "function"), timeout: 30000
  }, t => {
    const root = fs.realpathSync(makeTempDir("grok-linux-reclaim-files-"));
    const state = path.join(root, "state");
    fs.mkdirSync(state, { mode: 0o700 }); fs.mkdirSync(path.join(root, "processes"), { mode: 0o700 });
    const fixture = fileURLToPath(new URL("./fixtures/linux-reclaim-journal-files-simulated.mjs", import.meta.url));
    const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
    const flagPreload = fileURLToPath(new URL("./fixtures/linux-reclaim-open-flags-preload.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", preload, ...(mode.startsWith("flag-") ? ["--import", flagPreload] : []), fixture, mode], {
      env: { ...process.env, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: state,
        ...(mode.startsWith("flag-") ? { GROK_RECLAIM_FLAG_FAULT: mode } : {}),
        ...(mode === "mount" ? { GROK_LINUX_SIM_RECORD_FAULT: "jobs-mount" } : {}) }, encoding: "utf8", timeout: 20000
    });
    if (result.status !== 0) t.diagnostic(`Retained fixture: ${root}`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `verified ${mode}`);
    if (mode === "symlink") t.diagnostic(`Retained link fixture: ${root}`);
    else removeTempFixture(root, { recursive: true, force: true });
  });
}
