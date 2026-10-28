import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { removeTempFixture } from "./helpers.mjs";

// 失敗条件: 偽 state capability や manifest getter の評価、保全資料や旧 lock の変更。
const darwin = { skip: process.platform !== "darwin", timeout: 90000 };
const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const holder = fileURLToPath(new URL("./fixtures/darwin-126-file-lock-holder.mjs", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/darwin-manifest-authorization-child.mjs", import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("preservation verifier rejects a forged state capability before reading manifest", darwin, async t => {
  const originalTemp = path.resolve(os.tmpdir()), parent = fs.realpathSync.native(originalTemp);
  const relative = path.relative(repository, parent);
  assert.ok(path.isAbsolute(parent) && (relative === ".." || relative.startsWith(`..${path.sep}`)));
  fs.accessSync(parent, fs.constants.W_OK);
  const root = fs.mkdtempSync(path.join(parent, "grok-manifest-auth-"));
  const cleanupTarget = path.join(originalTemp, path.basename(root)), stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  const children = new Set();
  let retain = false;
  t.after(async () => {
    for (const child of children) {
      retain = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.closed;
    }
    if (retain) t.diagnostic(`Preserved fixture for inspection: ${root}`);
    else removeTempFixture(cleanupTarget, { recursive: true, force: true });
  });
  function start(script) {
    const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
    const child = spawn(process.execPath, [script, stateDir], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { retain = true; child.kill("SIGKILL"); reject(new Error(`child timed out: ${stderr}`)); }, 35000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => { clearTimeout(timer); children.delete(child); resolve({ code, signal, stdout, stderr }); });
    });
    children.add(child);
    return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
  }
  const owner = start(holder), deadline = Date.now() + 25000;
  while (!owner.stdout.includes("LEGACY_LOCK_HELD\n")) {
    if (owner.child.exitCode !== null || owner.child.signalCode !== null || Date.now() >= deadline) throw new Error(`old writer did not hold lock: ${owner.stderr}`);
    await pause(20);
  }
  const lock = path.join(stateDir, "state.lock"), before = fs.lstatSync(lock, { bigint: true }), bytes = fs.readFileSync(lock);
  assert.equal(bytes.toString("utf8"), `${owner.child.pid}\n`);
  owner.child.kill("SIGKILL");
  assert.equal((await owner.child.closed).signal, "SIGKILL");
  const result = await start(probe).child.closed;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /FORGED_MANIFEST_REJECTED/);
  assert.deepEqual(fs.readFileSync(lock), bytes);
  assert.equal(fs.lstatSync(lock, { bigint: true }).ino, before.ino);
});
