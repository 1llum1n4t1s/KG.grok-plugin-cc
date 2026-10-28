import assert from "node:assert/strict";
import test from "node:test";
import { classifyShellCommand } from "../plugins/grok/scripts/lib/grok.mjs";
import { READ_ONLY_GIT_GLOBAL_ARGS } from "../plugins/grok/scripts/lib/git.mjs";

const git = `git ${READ_ONLY_GIT_GLOBAL_ARGS.join(" ")}`;
const diff = `${git} diff --no-ext-diff --no-textconv`;

// 文字列の分類のみ。Git の実行や、攻撃用設定・ファイルの作成は行わない。
for (const command of [
  `${git} status --porcelain`,
  diff,
  `${diff} HEAD`,
  `${diff} auth.js`,
  `${diff} --cached --no-index old new`,
  `${diff} --cached --submodule=diff`,
  `${git} grep -n needle -- src`,
  `${git} grep --cached --no-index needle -- src`,
  `${git} ls-files --modified`,
  `${git} ls-files -m`,
  `${git} blame --no-textconv auth.js`,
  `${git} blame --no-textconv HEAD -- auth.js`
]) {
  test(`Git shell boundary rejects unproven worktree execution: ${command}`, () => {
    assert.equal(classifyShellCommand(command).allowed, false);
  });
}

for (const command of [
  `${diff} --cached`,
  `${diff} --cached -- auth.js`,
  `${git} grep --cached -n needle -- src`,
  `${git} rev-parse --show-toplevel`,
  `${git} ls-files`,
  `${git} log --no-ext-diff --no-textconv --oneline -5`
]) {
  test(`Git shell boundary preserves supported object and inventory queries: ${command}`, () => {
    assert.equal(classifyShellCommand(command).allowed, true);
  });
}
