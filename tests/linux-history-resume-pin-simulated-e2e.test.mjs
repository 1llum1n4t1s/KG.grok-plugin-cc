import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";
import { makeTempDir, removeTempFixture } from "./helpers.mjs";

// 実 broker/CLI と Mac の子 process を通す。procfs/mount/flock は模擬であり、
// Linux kernel の namespace・寿命・durability を実証するものではない。
test("Linux preserves an in-flight broker resume source while another task changes the latest candidate", {
  skip: process.platform !== "darwin", timeout: 1800000
}, t => {
  const root = fs.realpathSync(makeTempDir("grok-linux-history-resume-pin-"));
  const data = path.join(root, "data"), workspace = path.join(root, "workspace");
  for (const dir of [data, workspace, path.join(root, "processes")]) fs.mkdirSync(dir, { mode: 0o700 });
  const prior = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  const preload = fileURLToPath(new URL("./fixtures/linux-cli-simulated-preload.mjs", import.meta.url));
  const scenario = fileURLToPath(new URL("./fixtures/linux-history-resume-scenario.mjs", import.meta.url));
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, GROK_LINUX_SIM_ROOT: root, GROK_LINUX_SIM_STATE_DIR: stateDir,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${JSON.stringify(preload)}`.trim() };
  delete env.PLUGIN_DATA;
  let verifiedDone = false;
  t.after(() => {
    try {
      if (verifiedDone) removeTempFixture(root, { recursive: true, force: true });
      else t.diagnostic(`Retained broker resume fixture: ${root}`);
    } finally {
      for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  const result = spawnSync(process.execPath, [scenario], { env, encoding: "utf8", timeout: 1750000 });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  verifiedDone = true;
});
