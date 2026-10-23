import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { buildShellCommand } from "../plugins/grok/scripts/lib/process.mjs";

export function makeTempDir(prefix = "grok-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  const shell = options.shell ?? (process.platform === "win32" && !path.isAbsolute(command));
  return spawnSync(shell ? buildShellCommand(command, args) : command, shell ? [] : args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell,
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Grok Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

// Windows の Node.js 22 でも日本語パスを含むテスト用インストールを作成する。
export function copyTestDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTestDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}


// 許可rootの境界とリンクを検査してから標準APIへ渡す。
function assertCleanupPath(target, allowedRoot) {
  if (typeof target !== 'string' || !target || typeof allowedRoot !== 'string' || !allowedRoot || !path.isAbsolute(target) || !path.isAbsolute(allowedRoot)) throw new Error('Cleanup paths must be absolute');
  const resolved = path.resolve(target);
  const relative = path.relative(path.resolve(allowedRoot), resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Cleanup target is outside the allowed root');
  for (let current = resolved; ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Cleanup path contains a link'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
  const pending = [resolved];
  while (pending.length) {
    const current = pending.pop();
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Cleanup directory contains a link');
    if (stat.isDirectory()) for (const entry of fs.readdirSync(current)) pending.push(path.join(current, entry));
  }
  return resolved;
}

export function removeTempFixture(target, options) {
  return fs.rmSync(assertCleanupPath(target, path.resolve(os.tmpdir())), options);
}
