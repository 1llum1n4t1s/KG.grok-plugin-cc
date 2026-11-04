#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceDirectories = ["plugins/grok/scripts", "scripts", "tests"];

// Git の改行変換を許容し、生成内容そのものを比較する。
function readNormalized(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

export function compareGeneratedFiles(repositoryRoot: string, outputRoot: string, emittedFiles: string[]): string[] {
  const differences: string[] = [];
  for (const generated of emittedFiles) {
    const relative = path.relative(outputRoot, generated);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unexpected compiler output: ${generated}`);
    const committed = path.join(repositoryRoot, relative);
    if (!fs.existsSync(committed) || readNormalized(committed) !== readNormalized(generated)) differences.push(relative);
  }
  return differences;
}

function main(): void {
  const outputRoot = path.join(root, "plugins/grok/.generated/check");
  const require = createRequire(import.meta.url);
  const compiler = path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc");
  const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.acp.json", "--outDir", outputRoot, "--listEmittedFiles", "--pretty", "false"], {
    cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout + result.stderr || `TypeScript exited with ${result.status ?? result.signal}`);
  const emittedFiles = result.stdout.split(/\r?\n/).filter(line => line.startsWith("TSFILE: ")).map(line => line.slice(8));
  if (!emittedFiles.length) throw new Error("TypeScript emitted no files.");
  const differences = compareGeneratedFiles(root, outputRoot, emittedFiles);
  for (const directory of sourceDirectories) {
    const absolute = path.join(root, directory);
    for (const file of fs.readdirSync(absolute, { recursive: true, encoding: "utf8" })) {
      if (file.endsWith(".mjs") && !fs.existsSync(path.join(absolute, file.slice(0, -4) + ".mts"))) differences.push(path.join(directory, file));
    }
  }
  if (differences.length) throw new Error(`Generated JavaScript is out of sync. Run pnpm build and include the generated files:\n${differences.join("\n")}`);
  console.log(`All ${emittedFiles.length} generated JavaScript files match TypeScript.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
