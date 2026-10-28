import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// The owner/device mismatch cases inject stat values; they do not prove an
// actual mount boundary. The CLI and real macOS filesystem remain isolated.
const mac = { skip: process.platform !== "darwin", timeout: 45000 };
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/darwin-jobs-identity-preload.cjs", import.meta.url));
const loader = fileURLToPath(new URL("./fixtures/darwin-state-fs-loader.mjs", import.meta.url));
for (const fault of ["mode", "dev", "uid", "no-follow", "nonblock"]) test(`Darwin task rejects jobs directory ${fault} mismatch`, mac, t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-darwin-jobs-safety-")), data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } t.diagnostic(`Jobs safety fixture retained: ${root}`); });
  const stateDir = resolveStateDir(workspace);
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const jobs = path.join(stateDir, "jobs"); fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
  if (fault === "mode") fs.chmodSync(jobs, 0o755);
  const index = path.join(stateDir, "state.json"), before = fs.readFileSync(index), originalMode = fs.lstatSync(jobs).mode & 0o777;
  const marker = path.join(root, "agent-started"), wrapper = path.join(root, "fake-grok");
  fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ] || [ "$1" = "--help" ]; then echo fixture; exit 0; fi\nprintf started > "$GROK_TEST_AGENT_MARKER"\nexit 1\n`, { flag: "wx", mode: 0o700 });
  const env = { ...process.env, GROK_BIN: wrapper, XAI_API_KEY: "test-only", GROK_COMPANION_DISABLE_BROKER: "1",
    GROK_TEST_AGENT_MARKER: marker, GROK_TEST_JOBS_PATH: jobs, GROK_TEST_JOBS_IDENTITY: fault, GROK_TEST_MISSING_FLAG: fault };
  const args = fault === "mode" ? [cli] : ["no-follow", "nonblock"].includes(fault)
    ? ["--experimental-loader", loader, cli] : ["--require", preload, cli];
  const result = spawnSync(process.execPath, [...args, "task", "--cwd", workspace, "--json", "test"], { env, encoding: "utf8", timeout: 20000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /directory|mount|filesystem|identity|ownership|permission|no.follow|nonblock/i);
  assert.equal(fs.existsSync(marker), false, "agent started with an unsafe jobs directory");
  assert.deepEqual(fs.readFileSync(index), before);
  assert.equal(fs.lstatSync(jobs).mode & 0o777, originalMode, "unsafe jobs mode was changed");
});

for (const race of ["safe", "unsafe"]) test(`Darwin task revalidates a ${race} jobs mkdir race`, mac, t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-darwin-jobs-race-")), data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } t.diagnostic(`Jobs race fixture retained: ${root}`); });
  const stateDir = resolveStateDir(workspace);
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const jobs = path.join(stateDir, "jobs"); assert.equal(fs.existsSync(jobs), false, "fixture must begin before jobs creation");
  const marker = path.join(root, "agent-started"), wrapper = path.join(root, "fake-grok");
  fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ] || [ "$1" = "--help" ]; then echo fixture; exit 0; fi\nprintf started > "$GROK_TEST_AGENT_MARKER"\nexit 1\n`, { flag: "wx", mode: 0o700 });
  const env = { ...process.env, GROK_BIN: wrapper, XAI_API_KEY: "test-only", GROK_COMPANION_DISABLE_BROKER: "1",
    GROK_TEST_AGENT_MARKER: marker, GROK_TEST_JOBS_PATH: jobs, GROK_TEST_MKDIR_RACE: race };
  const result = spawnSync(process.execPath, ["--require", preload, cli, "task", "--cwd", workspace, "--json", "test"], { env, encoding: "utf8", timeout: 20000 });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(marker), race === "safe", `jobs mkdir race handling was incorrect: ${result.stderr}`);
  assert.equal(fs.lstatSync(jobs).mode & 0o777, race === "safe" ? 0o700 : 0o755);
});
