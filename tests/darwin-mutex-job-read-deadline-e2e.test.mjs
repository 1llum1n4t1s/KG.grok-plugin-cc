import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./helpers.mjs";
import { migrateStateLock, resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

// Real CLI and worker; fake Git delays only while the CLI owns the real state
// native lock. The fixture never signals a process it did not create.
const mac = { skip: process.platform !== "darwin", timeout: 45000 };
const cli = fileURLToPath(new URL("../plugins/grok/scripts/grok-companion.mjs", import.meta.url));
const preload = fileURLToPath(new URL("./fixtures/darwin-mutex-git-gate.cjs", import.meta.url));
for (const operation of ["status", "cancel"]) test(`Darwin ${operation} does not invoke Git while reading a job under the mutex`, mac, async t => {
  const previous = ["CLAUDE_PLUGIN_DATA", "PLUGIN_DATA"].map(key => [key, process.env[key]]);
  const root = fs.realpathSync(makeTempDir("grok-darwin-mutex-git-")), data = path.join(root, "data"), workspace = path.join(root, "workspace");
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(workspace, { mode: 0o700 });
  process.env.CLAUDE_PLUGIN_DATA = data; delete process.env.PLUGIN_DATA;
  const stateDir = resolveStateDir(workspace);
  migrateStateLock(workspace, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const job = { id: "mutex-git-job", workspaceRoot: workspace, jobClass: "review", title: "Review", sessionId: "git-test", grokPromptState: "not-sent" };
  const worker = fork(new URL("./fixtures/darwin-worker-lease-worker.mjs", import.meta.url), [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const closed = new Promise(resolve => worker.once("close", resolve));
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    await closed;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    t.diagnostic(`Mutex Git fixture retained: ${root}`);
  });
  worker.send({ job, syntheticStartKey: true });
  const [started] = await once(worker, "message"); assert.equal(started.type, "started", JSON.stringify(started));
  const bin = path.join(root, "bin"), git = path.join(bin, "git"), marker = path.join(root, "mutex"), blocked = path.join(root, "git-blocked");
  fs.mkdirSync(bin, { mode: 0o700 }); fs.writeFileSync(marker, "released\n", { flag: "wx", mode: 0o600 });
  fs.writeFileSync(git, `#!/bin/sh\nIFS= read -r state < "$GROK_TEST_MUTEX_MARKER"\nif [ "$state" = held ]; then printf blocked > "$GROK_TEST_GIT_BLOCKED"; /bin/sleep 3; exit 1; fi\nexec /usr/bin/git "$@"\n`, { flag: "wx", mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    GROK_TEST_MUTEX_MARKER: marker, GROK_TEST_GIT_BLOCKED: blocked, GROK_COMPANION_SESSION_ID: "git-test" };
  const args = operation === "status" ? ["status", "--cwd", workspace, "--json"] : ["cancel", "--cwd", workspace, "--json", job.id];
  const command = spawnSync(process.execPath, ["--require", preload, cli, ...args], { env, encoding: "utf8", timeout: 20000 });
  assert.ifError(command.error);
  if (operation === "status") assert.equal(command.status, 0, command.stderr);
  assert.equal(fs.existsSync(blocked), false, `Git was invoked while the state mutex was held: ${command.stderr}`);
});
