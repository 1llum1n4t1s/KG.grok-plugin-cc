import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

test("direct startup cancellation persists never-started once before any spawn", { skip: process.platform === "win32" }, async t => {
  const configured = process.env.GROK_BEFORE_START_E2E_ROOT;
  const parent = fs.realpathSync.native(configured || os.tmpdir());
  assert.ok(path.isAbsolute(parent));
  if (configured) assert.equal(parent, configured, "fixture parent must be an absolute real path");
  assert.ok(fs.lstatSync(parent).isDirectory());
  fs.accessSync(parent, fs.constants.W_OK);
  const repository = fs.realpathSync.native(fileURLToPath(new URL("..", import.meta.url)));
  const relative = path.relative(repository, parent);
  assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`), "fixture parent must be outside the repository");
  const root = fs.mkdtempSync(path.join(parent, "before-start-"));
  const created = fs.lstatSync(root);
  t.after(() => {
    try {
      assert.equal(path.dirname(root), parent);
      const current = fs.lstatSync(root);
      assert.ok(current.isDirectory() && !current.isSymbolicLink());
      assert.equal(fs.realpathSync.native(root), root);
      assert.equal(current.dev, created.dev); assert.equal(current.ino, created.ino);
      fs.rmSync(root, { recursive: true });
      assert.equal(fs.existsSync(root), false);
    } catch (error) {
      t.diagnostic(`Fixture retained or cleanup failed: ${root}`);
      throw error;
    }
  });
  const cwd = path.join(root, "workspace"), data = path.join(root, "data");
  fs.mkdirSync(cwd); fs.mkdirSync(data);
  const oldData = process.env.CLAUDE_PLUGIN_DATA, oldPluginData = process.env.PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data; process.env.PLUGIN_DATA = data;

  const childProcess = createRequire(import.meta.url)("node:child_process");
  const originalSpawn = childProcess.spawn, children = [];
  childProcess.spawn = (...args) => { const child = originalSpawn(...args); children.push(child); return child; };
  syncBuiltinESMExports();
  try {
    const { GrokAcpClient } = await import("../plugins/grok/scripts/lib/acp.mjs");
    const proofs = [], closes = [];
    const connecting = GrokAcpClient.connect(cwd, { disableBroker: true, grokBin: process.execPath,
      directAgentStarting(owner) {
        closes.push(owner.close(), owner.close());
        return { async finish(proof) { proofs.push(proof); return true; } };
      }
    });
    await assert.rejects(connecting, /closed before startup/);
    assert.deepEqual(await Promise.all(closes), ["never-started", "never-started"]);
    assert.equal(children.length, 0, "the actual spawn must not be called");
    assert.deepEqual(proofs, ["never-started"]);
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = oldData;
    if (oldPluginData === undefined) delete process.env.PLUGIN_DATA; else process.env.PLUGIN_DATA = oldPluginData;
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => child.once("close", resolve))));
  }
});
