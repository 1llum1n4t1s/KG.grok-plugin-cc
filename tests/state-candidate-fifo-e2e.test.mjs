import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const stateModule = pathToFileURL(fileURLToPath(new URL("../plugins/grok/scripts/lib/state.mjs", import.meta.url))).href;

// lstat の結果を返す直前に同じパスを FIFO に差し替え、競合を確実に再現する。
const readerChild = `
  import fs from "node:fs";
  import path from "node:path";
  import { execFileSync } from "node:child_process";
  import { createStateJobReader, migrateStateLock, resolveStateDir, updateState, writeJobFile } from ${JSON.stringify(stateModule)};
  const root = process.env.FIFO_FIXTURE_ROOT;
  const cwd = path.join(root, "workspace");
  const stateDir = resolveStateDir(cwd);
  const relative = path.relative(root, stateDir);
  if (!path.isAbsolute(root) || !relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("State directory escaped fixture");
  migrateStateLock(cwd, { offlineConfirmed: true, localOnly: true, expectedStateDir: stateDir });
  const jobsDir = path.join(stateDir, "jobs");
  const stateFile = path.join(stateDir, "state.json");
  const jobFile = path.join(jobsDir, "fixture.json");
  updateState(cwd, state => {
    const job = { id: "fixture" };
    writeJobFile(cwd, job.id, job);
    state.jobs.push(job);
  });
  const reader = createStateJobReader(cwd, "fixture");
  const target = process.env.FIFO_FIXTURE_RECORD === "state" ? stateFile : jobFile;
  const originalLstat = fs.lstatSync;
  let replaced = false;
  fs.lstatSync = function(candidate, ...args) {
    const result = originalLstat.call(this, candidate, ...args);
    const isTarget = candidate === target || (process.platform === "linux" &&
      typeof candidate === "string" && path.basename(candidate) === path.basename(target) &&
      fs.realpathSync.native(candidate) === target);
    if (!replaced && isTarget) {
      replaced = true;
      fs.renameSync(target, target + ".original");
      execFileSync("mkfifo", [target]);
      process.stdout.write("FIFO_SWAPPED\\n");
    }
    return result;
  };
  try {
    reader.read();
    process.stderr.write("candidate reader unexpectedly accepted FIFO\\n");
    process.exitCode = 1;
  } catch (error) {
    if (!replaced || !/candidate record is corrupt or unavailable/i.test(error.message)) throw error;
    process.stdout.write("CANDIDATE_REJECTED\\n");
  }
`;

for (const record of ["state", "job"]) {
  test(`candidate reader rejects a ${record} record replaced by a FIFO during open`, {
    skip: process.platform === "win32",
    timeout: 25000
  }, async t => {
    const parent = fs.realpathSync.native(os.tmpdir());
    const repository = fs.realpathSync.native(fileURLToPath(new URL("..", import.meta.url)));
    const relative = path.relative(repository, parent);
    assert.ok(path.isAbsolute(parent) && (relative === ".." || relative.startsWith(`..${path.sep}`)));
    const root = fs.mkdtempSync(path.join(parent, "candidate-fifo-"));
    const created = fs.lstatSync(root);
    fs.mkdirSync(path.join(root, "workspace"));
    fs.mkdirSync(path.join(root, "data"));
    t.after(() => {
      const current = fs.lstatSync(root);
      assert.equal(path.dirname(root), parent);
      assert.equal(fs.realpathSync.native(root), root);
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(current.dev, created.dev);
      assert.equal(current.ino, created.ino);
      fs.rmSync(root, { recursive: true, force: true });
    });

    const child = spawn(process.execPath, ["--input-type=module", "--eval", readerChild], {
      cwd: path.join(root, "workspace"),
      env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(root, "data"), PLUGIN_DATA: "", FIFO_FIXTURE_ROOT: root, FIFO_FIXTURE_RECORD: record },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 15000);
    let result;
    try { result = await closed; } finally { clearTimeout(timer); }
    assert.match(stdout, /FIFO_SWAPPED/, `FIFO replacement was not reached: ${stderr}`);
    assert.equal(timedOut, false, `candidate reader blocked on the replacement FIFO: ${stderr}`);
    assert.equal(result.code, 0, `candidate reader failed: ${stderr}`);
    assert.match(stdout, /CANDIDATE_REJECTED/);
  });
}
