import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import {
  collectWorkingTreeSnapshot,
  collectReviewContext,
  getWorkingTreeFingerprint,
  getWorkingTreeState,
  resolveReviewTarget
} from "../plugins/grok/scripts/lib/git.mjs";

// snapshot の実装前に固定する失敗条件。実 Git、作業ファイル、削除は使わない。
// 外部変換、未対応の正規化、競合、gitlink、不完全な一覧を安全側へ閉じる。
const baseline = Buffer.from("base\n");
const oid = createHash("sha1").update(`blob ${baseline.length}\0`).update(baseline).digest("hex");
const ordinaryIndex = `100644 ${oid} 0\tapp.js\0`;
const cases = [
  { name: "implicit executable file mode", config: "" },
  { name: "enabled executable file mode", config: "core.filemode\ntrue\0" },
  { name: "clean filter", attributes: "app.js\0filter\0attack\0" },
  { name: "process filter", attributes: "app.js\0filter\0attack\0" },
  { name: "textconv driver", attributes: "app.js\0diff\0attack\0" },
  { name: "working-tree encoding", attributes: "app.js\0working-tree-encoding\0UTF-16\0" },
  { name: "ident substitution", attributes: "app.js\0ident\0set\0" },
  { name: "unmerged index", index: `100644 ${oid} 2\tapp.js\0` },
  { name: "submodule index", index: `160000 ${oid} 0\tchild\0` },
  { name: "sparse directory index", index: `040000 ${oid} 0\tsparse/\0` },
  { name: "malformed index", index: "unexpected\0" },
  { name: "truncated path listing", untracked: "notes.txt" },
  { name: "failed metadata lookup", metadataFailure: true }
];

const commands = new Set([
  "rev-parse", "branch", "symbolic-ref", "show-ref", "merge-base", "diff", "status",
  "ls-files", "ls-tree", "config", "check-attr", "cat-file", "hash-object"
]);

function installMemoryGit(t, fixture) {
  const systemRoot = process.env.SystemRoot;
  t.after(() => {
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  });
  // Windows readerのspawnはmockし、実ホストの環境変数に依存させない。
  process.env.SystemRoot = String.raw`C:\Windows`;
  const unsafe = [];
  let reads = 0;
  const indexContent = Buffer.from(fixture.indexContent ?? baseline);
  const indexOid = createHash("sha1").update(`blob ${indexContent.length}\0`).update(indexContent).digest("hex");
  const originalLstat = fs.lstatSync;
  const originalRead = fs.readFileSync;
  const app = path.join(process.cwd(), "app.js");
  const notes = path.join(process.cwd(), "notes.txt");
  t.mock.method(fs, "lstatSync", (file, ...args) => {
    if (file !== app && file !== notes) return originalLstat(file, ...args);
    if (fixture.deleted && file === app) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    const content = file === app ? Buffer.from(fixture.content ?? baseline) : Buffer.from("untracked\n");
    return {
      size: content.length, mode: 0o100644, mtimeMs: 1, ctimeMs: 1, ino: 1, dev: 1,
      isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false
    };
  });
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === app) {
      reads += 1;
      return Buffer.from(fixture.changeDuringRead && reads > 1 ? "race\n" : fixture.content ?? baseline);
    }
    if (file === notes) return Buffer.from("untracked\n");
    return originalRead(file, ...args);
  });
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    fixture.onSpawn?.(command, args, options);
    if (command.endsWith("\\powershell.exe")) {
      assert.equal(command, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
      assert.equal(options.shell, false);
      const request = JSON.parse(options.input);
      const files = request.paths.map((name) => {
        reads += 1;
        return { path: name, content: Buffer.from(name === "notes.txt" ? fixture.untrackedContent ?? "untracked\n" : fixture.changeDuringRead && reads > 1 ? "race\n" : fixture.content ?? baseline).toString("base64") };
      });
      return { status: 0, stdout: JSON.stringify({ version: 1, files }), stderr: "" };
    }
    assert.equal(command, "git");
    assert.equal(options.shell, false);
    const start = args.findIndex((arg) => commands.has(arg));
    assert.notEqual(start, -1, `Unexpected Git query: ${args.join(" ")}`);
    const [query, ...rest] = args.slice(start);
    if (query === "status" || (query === "diff" && !rest.includes("--cached") &&
        !rest.some((arg) => /^[a-f0-9]{40,64}\.\.[a-f0-9]{40,64}$/.test(arg)))) {
      unsafe.push([query, ...rest]);
      throw new Error("UNSAFE_WORKTREE_QUERY_REACHED");
    }
    if (query === "hash-object") {
      assert.ok(!rest.includes("-w") && !rest.includes("--filters") &&
        !rest.some((arg) => arg === "--path" || arg.startsWith("--path=")));
    }
    let stdout = "";
    if (query === "rev-parse") stdout = rest.includes("--show-toplevel") ? process.cwd() : rest.includes("--show-object-format") ? "sha1" : oid;
    if (query === "branch") stdout = "feature";
    if (query === "symbolic-ref") stdout = "refs/remotes/origin/main";
    if (query === "diff" && rest.includes("--cached") && rest.includes("--name-only")) {
      stdout = fixture.staged ?? "";
    }
    if (query === "config") stdout = fixture.config ?? "core.filemode\nfalse\0";
    if (query === "check-attr") stdout = fixture.attributes ?? "";
    if (query === "ls-files") {
      if (rest.includes("--stage") || rest.includes("-s")) stdout = fixture.indexText ?? `${fixture.indexFlag ?? "H"} ${fixture.index ?? `100644 ${indexOid} 0\tapp.js\0`}`;
      else if (rest.includes("--others")) stdout = fixture.untracked ?? "";
      else stdout = "H app.js\0";
    }
    if (query === "ls-tree") stdout = fixture.head ?? `100644 blob ${oid}\tapp.js\0`;
    if (query === "cat-file") {
      if (fixture.rejectBlobRead) throw new Error("UNEXPECTED_BLOB_READ_FOR_IDENTICAL_BYTES");
      stdout = (rest.at(-1) === indexOid ? indexContent : baseline).toString("utf8");
    }
    const status = fixture.metadataFailure && ["config", "check-attr", "ls-files"].includes(query) ? 1 : 0;
    return { status, stdout, stderr: status ? "metadata lookup failed" : "" };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return unsafe;
}

const entryPoints = [
  ["state", () => getWorkingTreeState(process.cwd())],
  ["auto", () => resolveReviewTarget(process.cwd())],
  ["context", () => collectReviewContext(process.cwd(), { mode: "working-tree" })],
  ["fingerprint", () => getWorkingTreeFingerprint(process.cwd())]
];

for (const fixture of cases) {
  test(`Worktree snapshot failure boundary: ${fixture.name}`, (t) => {
    const unsafe = installMemoryGit(t, fixture);
    for (const [entry, invoke] of entryPoints) {
      assert.throws(invoke, (error) => {
        assert.doesNotMatch(error.message, /UNSAFE_WORKTREE_QUERY_REACHED/, entry);
        return /incomplete|cannot safely|metadata|unsupported|invalid|unmerged|submodule/i.test(error.message);
      }, entry);
    }
    assert.deepEqual(unsafe, []);
  });
}

// 正常系の受入条件。Git とファイル内容のどちらもメモリ上で検証する。
// 先行失敗条件: いずれかの Git / 2回の reader が共通期限を無視して無期限化する。
test("Worktree snapshot: every child shares the caller deadline", (t) => {
  const timeouts = [];
  installMemoryGit(t, { onSpawn: (_command, _args, options) => timeouts.push(options.timeout) });
  const snapshot = collectWorkingTreeSnapshot(process.cwd(), { deadline: performance.now() + 5000 });
  assert.ok(snapshot.fingerprint);
  assert.ok(timeouts.length > 4);
  assert.ok(timeouts.every(timeout => Number.isFinite(timeout) && timeout > 0 && timeout <= 5000));
});

test("Worktree snapshot recovery: ordinary clean repository remains usable", (t) => {
  const unsafe = installMemoryGit(t, {});
  assert.deepEqual(getWorkingTreeState(process.cwd()), {
    staged: [], unstaged: [], untracked: [], isDirty: false
  });
  assert.deepEqual(unsafe, []);
});

test("Worktree snapshot recovery: ordinary staged repository remains usable", (t) => {
  const unsafe = installMemoryGit(t, { staged: "app.js\0", indexContent: "staged\n", content: "staged\n" });
  assert.deepEqual(getWorkingTreeState(process.cwd()), {
    staged: ["app.js"], unstaged: [], untracked: [], isDirty: true
  });
  assert.deepEqual(unsafe, []);
});

test("Worktree snapshot recovery: ordinary repository has a stop fingerprint", (t) => {
  const unsafe = installMemoryGit(t, {});
  assert.match(getWorkingTreeFingerprint(process.cwd()), /^[a-f0-9]{64}$/);
  assert.deepEqual(unsafe, []);
});

test("Worktree snapshot recovery: tracked changes and untracked additions are detected", (t) => {
  const unsafe = installMemoryGit(t, { content: "changed\n", untracked: "notes.txt\0" });
  assert.deepEqual(getWorkingTreeState(process.cwd()), {
    staged: [], unstaged: ["app.js"], untracked: ["notes.txt"], isDirty: true
  });
  assert.deepEqual(unsafe, []);
});

// 全行hunkの別実装による適用検証。Gitを起動せず、削除側の一致と追加後の内容を確認する。
function applyReplacementPatch(before, patch) {
  const lines = patch.split("\n");
  const start = lines.findIndex((line) => line.startsWith("@@ "));
  assert.notEqual(start, -1, patch);
  const removed = [];
  const added = [];
  let previous = null;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("-")) { removed.push(line.slice(1) + "\n"); previous = removed; }
    else if (line.startsWith("+")) { added.push(line.slice(1) + "\n"); previous = added; }
    else if (line === "\\ No newline at end of file") {
      assert.ok(previous?.length);
      previous[previous.length - 1] = previous.at(-1).slice(0, -1);
    } else if (line !== "") break;
  }
  assert.equal(removed.join(""), before);
  return added.join("");
}

for (const content of ["changed\n", "changed", "", "変化\n2行\n"]) {
  test(`Worktree snapshot recovery: text patch applies exactly (${JSON.stringify(content)})`, (t) => {
    installMemoryGit(t, { content });
    const context = collectReviewContext(process.cwd(), { mode: "working-tree" });
    assert.equal(context.inputMode, "inline-diff");
    const patch = context.content.split("## Unstaged Diff\n\n")[1].split("\n## Untracked Files")[0];
    assert.equal(applyReplacementPatch(baseline.toString("utf8"), patch), content);
  });
}

test("Worktree snapshot recovery: incomplete large context cannot fall back to unsafe self collection", (t) => {
  const unsafe = installMemoryGit(t, { content: "changed\n" });
  assert.throws(() => collectReviewContext(process.cwd(), { mode: "working-tree" }, {
    maxInlineDiffBytes: 1
  }), /incomplete/i);
  assert.deepEqual(unsafe, []);
});

test("Worktree snapshot recovery: staged patch uses immutable blob content", (t) => {
  installMemoryGit(t, { staged: "app.js\0", indexContent: "staged\n", content: "staged\n" });
  const context = collectReviewContext(process.cwd(), { mode: "working-tree" });
  const patch = context.content.split("## Staged Diff\n\n")[1].split("\n## Unstaged Diff")[0];
  assert.equal(applyReplacementPatch("base\n", patch), "staged\n");
});

test("Worktree snapshot failure boundary: skip-worktree index", (t) => {
  const unsafe = installMemoryGit(t, { indexFlag: "S" });
  assert.throws(() => getWorkingTreeState(process.cwd()), /incomplete/i);
  assert.deepEqual(unsafe, []);
});

test("Worktree snapshot failure boundary: changing contents are refused", (t) => {
  installMemoryGit(t, { changeDuringRead: true });
  assert.throws(() => getWorkingTreeFingerprint(process.cwd()), /incomplete/i);
});

for (const content of [Buffer.from([0xff, 0xfe]), Buffer.from("binary\0data"), Buffer.from("a".repeat(5000) + "\0tail")]) {
  test(`Worktree snapshot failure boundary: unsupported changed bytes (${content.length})`, (t) => {
    installMemoryGit(t, { content });
    assert.throws(() => collectReviewContext(process.cwd(), { mode: "working-tree" }), /incomplete/i);
  });
}

test("Worktree snapshot recovery: fingerprint includes the entire file content", (t) => {
  const fixture = { content: "a".repeat(600000) };
  installMemoryGit(t, fixture);
  const first = getWorkingTreeFingerprint(process.cwd());
  fixture.content = "a".repeat(300000) + "b" + "a".repeat(299999);
  assert.notEqual(getWorkingTreeFingerprint(process.cwd()), first);
});

for (const autocrlf of ["true", "input"]) {
  const config = `core.filemode\nfalse\0core.autocrlf\n${autocrlf}\0`;
  for (const content of ["base\n", "base\r\n", "base"]) {
    test(`Auto CRLF ${autocrlf}: ordinary LF/CRLF uses the Git clean form ${JSON.stringify(content)}`, (t) => {
      const unsafe = installMemoryGit(t, { config, content });
      const state = getWorkingTreeState(process.cwd());
      assert.deepEqual(state.unstaged, content === "base" ? ["app.js"] : []);
      assert.deepEqual(unsafe, []);
    });
  }
  test(`Auto CRLF ${autocrlf}: changed patch applies to the immutable LF blob`, (t) => {
    const unsafe = installMemoryGit(t, { config, content: "変更\r\nsecond\r\n" });
    const context = collectReviewContext(process.cwd(), { mode: "working-tree" });
    const patch = context.content.split("## Unstaged Diff\n\n")[1].split("\n## Untracked Files")[0];
    assert.equal(applyReplacementPatch("base\n", patch), "変更\nsecond\n");
    assert.deepEqual(unsafe, []);
  });
  test(`Auto CRLF ${autocrlf}: newly indexed ordinary file compares to its own LF blob`, (t) => {
    installMemoryGit(t, { config, head: "", content: "base\r\n" });
    assert.deepEqual(getWorkingTreeState(process.cwd()), { staged: ["app.js"], unstaged: [], untracked: [], isDirty: true });
  });
  test(`Auto CRLF ${autocrlf}: untracked content has no index normalization`, (t) => {
    installMemoryGit(t, { config, head: "", indexText: "", untracked: "notes.txt\0", untrackedContent: "new\r\n" });
    const context = collectReviewContext(process.cwd(), { mode: "working-tree" });
    assert.match(context.content, /\+new\r\n/);
  });
  test(`Auto CRLF ${autocrlf}: unset eol does not disable automatic text normalization`, (t) => {
    installMemoryGit(t, { config, content: "base\r\n", attributes: "app.js\0eol\0unset\0" });
    assert.equal(getWorkingTreeState(process.cwd()).isDirty, false);
  });
  for (const attribute of ["text", "crlf"]) {
    test(`Auto CRLF ${autocrlf}: -${attribute} retains raw CRLF`, (t) => {
      installMemoryGit(t, { config, content: "base\r\n", attributes: `app.js\0${attribute}\0unset\0` });
      const context = collectReviewContext(process.cwd(), { mode: "working-tree" });
      const patch = context.content.split("## Unstaged Diff\n\n")[1].split("\n## Untracked Files")[0];
      assert.equal(applyReplacementPatch("base\n", patch), "base\r\n");
    });
  }
  test(`Auto CRLF ${autocrlf}: fingerprints retain raw line endings`, (t) => {
    const fixture = { config, content: "base\n" };
    installMemoryGit(t, fixture);
    const first = getWorkingTreeFingerprint(process.cwd());
    fixture.content = "base\r\n";
    assert.notEqual(getWorkingTreeFingerprint(process.cwd()), first);
  });
  for (const content of [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]), Buffer.from("base\r\n"), Buffer.from("日本語\n")]) {
    test(`Auto CRLF ${autocrlf}: raw-identical index bytes prove clean without conversion ${content.toString("base64")}`, (t) => {
      const sameOid = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
      const unsafe = installMemoryGit(t, { config, head: `100644 blob ${sameOid}\tapp.js\0`, indexContent: content, content, rejectBlobRead: true });
      assert.equal(getWorkingTreeState(process.cwd()).isDirty, false);
      assert.match(getWorkingTreeFingerprint(process.cwd()), /^[a-f0-9]{64}$/);
      assert.equal(collectReviewContext(process.cwd(), { mode: "working-tree" }).inputMode, "inline-diff");
      assert.deepEqual(unsafe, []);
    });
  }
  test(`Auto CRLF ${autocrlf}: a changed PNG remains incomplete`, (t) => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    const sameOid = createHash("sha1").update(`blob ${png.length}\0`).update(png).digest("hex");
    installMemoryGit(t, { config, head: `100644 blob ${sameOid}\tapp.js\0`, indexContent: png, content: Buffer.concat([png, Buffer.from([1])]) });
    for (const [, invoke] of entryPoints) assert.throws(invoke, /incomplete/i);
  });
  for (const fixture of [
    { content: "mixed\r\nsecond\n" }, { content: "bare\rCR" },
    { content: "binary\0bytes\r\n" }, { content: Buffer.from([255, 254]) },
    { content: "\x01\x02\r\n" }, { indexContent: "base\r\n", content: "changed\r\n" }
  ]) {
    test(`Auto CRLF ${autocrlf}: uncertain input fails closed ${JSON.stringify(fixture)}`, (t) => {
      const unsafe = installMemoryGit(t, { config, ...fixture });
      for (const [, invoke] of entryPoints) assert.throws(invoke, /incomplete|unsupported/i);
      assert.deepEqual(unsafe, []);
    });
  }
}
