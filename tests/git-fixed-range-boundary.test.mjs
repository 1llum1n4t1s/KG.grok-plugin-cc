import assert from "node:assert/strict";
import test from "node:test";
import { classifyShellCommand } from "../plugins/grok/scripts/lib/grok.mjs";
import { READ_ONLY_GIT_GLOBAL_ARGS } from "../plugins/grok/scripts/lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "../plugins/grok/scripts/lib/prompts.mjs";
import path from "node:path";

const prefix = `git ${READ_ONLY_GIT_GLOBAL_ARGS.join(" ")} diff --no-ext-diff --no-textconv`;
const range = `${"a".repeat(40)}..${"b".repeat(40)}`;

test("Fixed object range: exact SHA-1 and SHA-256 comparisons remain inspectable", () => {
  for (const oidLength of [40, 64]) {
    const target = `${"a".repeat(oidLength)}..${"b".repeat(oidLength)}`;
    for (const suffix of ["", " --stat", " --binary --no-renames", " --unified=5 -- src/app.js"]) {
      assert.equal(classifyShellCommand(`${prefix} ${target}${suffix}`).allowed, true, suffix);
    }
  }
});

test("Stop gate prompt: rendered Git examples use the same allowed runtime prefix", () => {
  const git = `git ${READ_ONLY_GIT_GLOBAL_ARGS.join(" ")}`;
  const template = loadPromptTemplate(path.resolve("plugins/grok"), "stop-review-gate");
  const prompt = interpolateTemplate(template, { READ_ONLY_GIT_PREFIX: git });
  const examples = prompt.split("\n").filter((line) => line.startsWith("git ") && line !== git);
  assert.ok(examples.length >= 2, "Stop review must include executable history and diff examples");
  for (const command of examples) {
    assert.ok(command.startsWith(git + " "));
    assert.equal(classifyShellCommand(command).allowed, true, command);
  }
});

test("Fixed object range: revisions, worktree modes and ambiguous paths fail closed", () => {
  for (const suffix of [
    "HEAD..main", `${"a".repeat(39)}..${"b".repeat(40)}`, `${"a".repeat(40)}..${"b".repeat(64)}`,
    `${range} HEAD`, `${range} src/app.js`, `${range} --no-index old new`,
    `${range} --cached`, `--stat ${range}`, `${range} --stat HEAD`,
    `${range} -S HEAD`, `${range} --submodule=diff`, `${range} --`,
    `${range} -- src/app.js --no-index`, `${range} -- :(attr:filter)`,
    `${range} --no-ext-diff --textconv`, `${range} -- -- ../outside`
  ]) assert.equal(classifyShellCommand(`${prefix} ${suffix}`).allowed, false, suffix);
});
