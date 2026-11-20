import type { ProcessOptions } from "./process.mjs";
interface GitOptions extends ProcessOptions {
  deadline?: number;
  base?: string;
  scope?: string;
  changedFiles?: string[];
  comparison?: ReturnType<typeof buildBranchComparison>;
  diffOutput?: string;
  includeDiff?: boolean;
  maxInlineDiffBytes?: number;
  maxInlineFiles?: number;
  /** false のとき表示用 diff で core.quotePath=false を渡し、非 ASCII 名の八進引用を外す。 */
  quotePaths?: boolean;
}
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { t } from "./i18n.mjs";
import { formatCommandFailure, runCommand } from "./process.mjs";
import { windowsHelperPath } from "./windows-helper.mjs";

const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const MAX_REPO_LISTING_ENTRIES = 2000;
const MAX_FINGERPRINT_TOTAL_BYTES = 8 * 1024 * 1024;

function validateSnapshotPaths(relativePaths) {
  const incomplete = () => incompleteSnapshot("err.snapshot_unreadable");
  if (!Array.isArray(relativePaths) || relativePaths.length > MAX_REPO_LISTING_ENTRIES) throw incomplete();
  const names = new Set();
  for (const name of relativePaths) {
    if (typeof name !== "string" || !name || name.length > 30000 || /[\\:\x00-\x1f\x7f]/.test(name)) throw incomplete();
    if (name.split("/").some((part) => !part || part === "." || part === ".." ||
      /[. ]$/.test(part) || /^\.git$/i.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw incomplete();
    const key = name.toLowerCase();
    if (names.has(key)) throw incomplete();
    names.add(key);
  }
}

export function readWindowsWorkingTreeFiles(repoRoot, relativePaths, options: GitOptions = {}) {
  validateSnapshotPaths(relativePaths);
  const incomplete = () => incompleteSnapshot("err.snapshot_unreadable");
  const result = runCommand(windowsHelperPath(), ["git-snapshot"], {
    shell: false, input: JSON.stringify({ root: path.resolve(repoRoot), paths: relativePaths }),
    timeout: gitLookupTimeout(options, 15000), maxBuffer: 12 * 1024 * 1024
  });
  if (result.error || result.signal || result.status !== 0) throw incomplete();
  let response;
  try { response = JSON.parse(result.stdout); } catch { throw incomplete(); }
  if (response?.version !== 1 || !Array.isArray(response.files) || response.files.length !== relativePaths.length) throw incomplete();
  const files = new Map();
  let total = 0;
  for (let index = 0; index < relativePaths.length; index += 1) {
    const entry = response.files[index];
    if (entry?.path !== relativePaths[index]) throw incomplete();
    if (entry.missing === true && entry.content === undefined) { files.set(entry.path, null); continue; }
    if (typeof entry.content !== "string" || entry.missing !== undefined) throw incomplete();
    const bytes = Buffer.from(entry.content, "base64");
    total += bytes.length;
    if (bytes.toString("base64") !== entry.content || total > MAX_FINGERPRINT_TOTAL_BYTES) throw incomplete();
    files.set(entry.path, bytes);
  }
  return files;
}

// spawnSync の maxBuffer 既定は 1MiB しかなく、数万ファイルのリポジトリでは
// `git ls-files` の出力がそれを超えて ENOBUFS で監査ごと落ちる。
// 一覧は表示前に MAX_REPO_LISTING_ENTRIES で切るので、取得側は広めに取る。
const MAX_FILE_LISTING_BYTES = 64 * 1024 * 1024;

// 子 Git にも継承される -c と環境フラグで、設定由来の外部実行を抑える。
// --submodule=diff の子 diff は表示フラグを継承しないため、別途扱う必要がある。
export const READ_ONLY_GIT_GLOBAL_ARGS = Object.freeze([
  "--no-pager", "--no-optional-locks", "--no-lazy-fetch",
  "-c", "core.fsmonitor=false", "-c", "log.showSignature=false",
  "-c", "format.pretty=medium", "-c", "log.diffMerges=off", "-c", "diff.submodule=short"
]);

function readOnlyGitArgs(args, options: GitOptions = {}) {
  const [command, ...rest] = args;
  // status と作業ツリー比較は --no-textconv でも clean/process filter を実行する。
  // 設定の事前検査は TOCTOU を防げないため、危険な呼出し自体を開始しない。
  if (command === "status" || (command === "diff" &&
      !rest.includes("--cached") && !rest.some((arg) => /^[a-f0-9]{40,64}\.\.[a-f0-9]{40,64}$/.test(arg)))) {
    throw new Error(t("err.review_incomplete", { reason: t("err.review_worktree_filters") }));
  }
  if (rest.includes("--submodule=diff")) {
    throw new Error(t("err.review_incomplete", { reason: t("err.review_submodule_diff") }));
  }
  // object 間 / cached の比較は oid_valid な内容を読む。Git の
  // reuse_worktree_file(..., want_file=0) は would_convert_to_git 時に再利用を拒否する。
  // want_file=1 側へ進ませないため、外部 diff と textconv は常に無効にする。
  const diffFlags = ["diff", "show", "log", "whatchanged"].includes(command)
    ? ["--no-ext-diff", "--no-textconv"] : [];
  // 表示用の diff / --stat だけ引用を外す。-z の機械処理は生のバイト列のままにする。
  // core.quotePath=false でも C0 制御文字は Git が引用したまま残る。
  // 双方向制御などの書式文字は引用されないため、受け取ったあとで逃がす。
  const quoting = options.quotePaths === false ? ["-c", "core.quotePath=false"] : [];
  return [...READ_ONLY_GIT_GLOBAL_ARGS, ...quoting, command, ...diffFlags, ...rest];
}

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options: GitOptions = {}) {
  const { quotePaths, ...commandOptions } = options;
  const result = runCommand("git", readOnlyGitArgs(args, { quotePaths }), {
    cwd, ...commandOptions, timeout: gitLookupTimeout(options), env: { ...process.env, ...commandOptions.env, LC_ALL: "C" }, shell: false
  });
  assertGitStarted(result, cwd);
  if (result.status !== 0 && /unknown option[^\r\n]*--no-lazy-fetch/.test(result.stderr)) {
    assertReadOnlyGitSupport(cwd, options);
  }
  if (options.quotePaths === false && typeof result.stdout === "string") {
    result.stdout = escapeFormatControls(result.stdout);
  }
  return result;
}

/** 双方向制御やゼロ幅の書式文字を見える形にする。通常の非 ASCII 文字はそのまま残す。 */
function escapeFormatControls(text: string): string {
  return text.replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029\uFEFF]/g, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function gitChecked(cwd, args, options: GitOptions = {}) {
  const result = git(cwd, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(formatCommandFailure(result));
  return result;
}

function assertGitStarted(result, cwd) {
  if (result.error) {
    const code = "code" in result.error ? result.error.code : null;
    // 出力上限は呼出し元が軽量コンテキストへ切り替えるため、起動失敗にしない。
    if (code === "ENOBUFS") return;
    if (code === "ENOENT") {
      try {
        if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new Error(t("err.git_cwd_unavailable"));
      }
      throw new Error(t("err.git_not_installed"));
    }
    throw new Error(code ? t("err.git_start_failed_code", { code, detail: result.error.message }) : t("err.git_start_failed", { detail: result.error.message }));
  }
  if (result.signal) throw new Error(t("err.git_terminated", { signal: result.signal }));
}

function gitLookupTimeout(options, fallback = options.timeout) {
  if (options.deadline === undefined) return fallback;
  if (!Number.isFinite(options.deadline)) throw new TypeError("Git lookup deadline must be finite");
  const remaining = options.deadline - performance.now();
  if (remaining <= 0) throw new Error("Git lookup deadline expired");
  return Math.min(fallback ?? Infinity, Math.max(1, Math.ceil(remaining)));
}

function assertReadOnlyGitSupport(cwd, options: GitOptions = {}) {
  // 成功経路の追加 spawn と PATH/cwd をまたぐ能力キャッシュを避け、失敗時だけ
  // 同じ探索環境で実機能を調べる。repo/object を読まないため取得処理は起きない。
  const probe = runCommand("git", ["--no-pager", "--no-lazy-fetch", "--version"], {
    cwd, env: { ...process.env, ...options.env, LC_ALL: "C" }, shell: false, timeout: gitLookupTimeout(options, 10000)
  });
  assertGitStarted(probe, cwd);
  if (probe.status !== 0 && /unknown option[^\r\n]*--no-lazy-fetch/.test(probe.stderr)) {
    throw new Error(t("err.git_too_old"));
  }
  if (probe.error || probe.status !== 0 || !/^git version \S+/m.test(probe.stdout)) {
    throw new Error(t("err.git_capability_failed", { detail: formatCommandFailure(probe) }));
  }
}

/**
 * `git ... -z` のパス一覧を名前の配列にする。
 * -z なしだと core.quotePath=true（Git 既定）で非 ASCII が "\346..." と引用されるため -z で受け取る。
 * 名前の先頭・末尾の空白も保つよう、出力全体の trim はしない。
 * nulRecords は末尾 NUL を必須とする working-tree 用の厳格な検査なので、ここでは使わない。
 * UTF-8 として不正なバイト列の名前は U+FFFD に置き換わる（8 進引用のような可逆表現は失う）。
 * 一覧はレビューの参考情報で、Git への再入力には使わないため、失敗にはせず劣化表示として許容する。
 */
function splitNulPaths(output) {
  return String(output ?? "").split("\0").filter(Boolean);
}

/**
 * 表示用の一覧で使うパス表記。-z は改行・タブ等の引用も外すため、改行入りの名前で
 * 節見出し（`## ...`）を偽装できてしまう。制御文字を含む名前だけ JSON 文字列として
 * 再エスケープする（replacementPatch のヘッダーと同じ考え方）。件数と changedFiles は生の名前のまま扱う。
 */
function displayPath(name) {
  return /[\x00-\x1f\x7f]/.test(name) ? JSON.stringify(name) : name;
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function collectBoundedGitOutput(cwd, args, maxBytes, options: GitOptions = {}) {
  const result = git(cwd, args, { ...options, maxBuffer: maxBytes + 1 });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOBUFS") {
    // 途中で切れた出力は再利用せず、強制インライン時だけ従来の取得へ戻す。
    return { bytes: maxBytes + 1, stdout: null };
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return { bytes: Buffer.byteLength(result.stdout, "utf8"), stdout: result.stdout };
}

function buildBranchComparison(cwd, baseRef) {
  const head = gitChecked(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();
  const mergeBase = gitChecked(cwd, ["merge-base", head, baseRef]).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(head) || !/^[a-f0-9]{40,64}$/.test(mergeBase)) {
    throw new Error(t("err.review_incomplete", { reason: t("err.review_branch_objects") }));
  }
  return {
    mergeBase,
    commitRange: `${mergeBase}..${head}`,
    reviewRange: `${baseRef}...HEAD`
  };
}

function assertCompleteBranchComparison(cwd, comparison) {
  // raw の object 比較は内容変換を行わない。モード変更・削除も両側で検査する。
  const result = gitChecked(cwd, ["diff", "--raw", "--no-renames", "-z", comparison.commitRange], {
    maxBuffer: MAX_FILE_LISTING_BYTES
  });
  const records = result.stdout.split("\0");
  for (let index = 0; index < records.length; index += 2) {
    const record = records[index];
    if (!record) continue;
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ [A-Z][0-9]*$/.exec(record);
    if (!match || records[index + 1] === undefined || !records[index + 1]) {
      throw new Error(t("err.review_incomplete", { reason: t("err.review_branch_modes") }));
    }
    if (match[1] === "160000" || match[2] === "160000") {
      throw new Error(t("err.review_incomplete", { reason: t("err.review_branch_submodule") }));
    }
  }
}

export function ensureGitRepository(cwd, options: GitOptions = {}) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"], options);
  if (options.deadline !== undefined && performance.now() >= options.deadline) throw new Error("Git lookup deadline expired");
  if (result.error) throw new Error(t("err.git_lookup_failed", { detail: formatCommandFailure(result) }));
  if (result.status !== 0) {
    assertReadOnlyGitSupport(cwd, options);
    if (options.deadline !== undefined && performance.now() >= options.deadline) throw new Error("Git lookup deadline expired");
    if (/^fatal: not a git repository(?:[ (:]|$)/m.test(result.stderr)) {
      throw Object.assign(new Error(t("err.git_not_a_repository")), { code: "GROK_NOT_GIT_REPOSITORY" });
    }
    throw new Error(t("err.git_lookup_failed", { detail: formatCommandFailure(result) }));
  }
  return result.stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error(t(process.platform === "win32" ? "err.git_default_branch_undetected_win" : "err.git_default_branch_undetected"));
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  return collectWorkingTreeSnapshot(cwd).state;
}

// reason は辞書キー（err.snapshot_*）のリテラルを渡す。i18n テストの走査がキー参照を拾えるようにするため。
function incompleteSnapshot(reasonKey) {
  const guidance = process.platform === "win32" ? "" : ` ${t("err.snapshot_guidance_non_windows")}`;
  return new Error(`${t("err.review_incomplete", { reason: t(reasonKey) })}${guidance}`);
}

function nulRecords(output) {
  if (output && (!output.endsWith("\0") || output.includes("\ufffd"))) throw incompleteSnapshot("err.snapshot_path_metadata");
  return output ? output.slice(0, -1).split("\0") : [];
}

function workingTreeMetadata(repoRoot, options: GitOptions = {}) {
  const listing = { ...options, maxBuffer: MAX_FILE_LISTING_BYTES };
  const head = git(repoRoot, ["rev-parse", "--verify", "HEAD"], options);
  if (head.status !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head.stdout.trim())) throw incompleteSnapshot("err.snapshot_head_unavailable");
  const objectFormat = gitChecked(repoRoot, ["rev-parse", "--show-object-format"], options).stdout.trim();
  if (!["sha1", "sha256"].includes(objectFormat)) throw incompleteSnapshot("err.snapshot_object_format");
  const indexText = gitChecked(repoRoot, ["ls-files", "--stage", "-v", "-z"], listing).stdout;
  const headText = gitChecked(repoRoot, ["ls-tree", "-r", "-z", "HEAD"], listing).stdout;
  const untrackedText = gitChecked(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], listing).stdout;
  const config = git(repoRoot, ["config", "--null", "--get-regexp", "^core\\.(autocrlf|eol|filemode|symlinks|ignorestat)$"], listing);
  if (config.status !== 0 && !(config.status === 1 && !config.stdout && !config.stderr)) throw incompleteSnapshot("err.snapshot_config_lookup");
  let fileModeDisabled = false;
  let autoCrlf = false;
  for (const record of nulRecords(config.stdout)) {
    const [key, value, extra] = record.split("\n");
    if (extra !== undefined || value === undefined || !["core.autocrlf", "core.eol", "core.filemode", "core.symlinks", "core.ignorestat"].includes(key)) throw incompleteSnapshot("err.snapshot_config_invalid");
    if ((key === "core.autocrlf" && !["false", "true", "input"].includes(value)) ||
      (key === "core.eol" && value !== "lf") ||
      (["core.filemode", "core.ignorestat"].includes(key) && value !== "false")) throw incompleteSnapshot("err.snapshot_config_unsupported");
    if (key === "core.filemode" && value === "false") fileModeDisabled = true;
    if (key === "core.autocrlf") autoCrlf = value !== "false";
  }
  if (!fileModeDisabled) throw incompleteSnapshot("err.snapshot_filemode");
  const index = new Map();
  for (const record of nulRecords(indexText)) {
    const match = /^H (100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/.exec(record);
    if (!match || /^0+$/.test(match[2])) throw incompleteSnapshot("err.snapshot_index_entry");
    if (index.has(match[3])) throw incompleteSnapshot("err.snapshot_index_duplicate");
    index.set(match[3], { mode: match[1], oid: match[2] });
  }
  const headFiles = new Map();
  for (const record of nulRecords(headText)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(record);
    if (!match || headFiles.has(match[3])) throw incompleteSnapshot("err.snapshot_head_entry");
    headFiles.set(match[3], { mode: match[1], oid: match[2] });
  }
  const untracked = nulRecords(untrackedText);
  const paths = listUniqueFiles([...index.keys()], untracked);
  validateSnapshotPaths(listUniqueFiles([...headFiles.keys()], paths));
  if (paths.length > MAX_REPO_LISTING_ENTRIES || new Set(untracked).size !== untracked.length || untracked.some((name) => index.has(name))) throw incompleteSnapshot("err.snapshot_inventory");
  const attributes = gitChecked(repoRoot, ["check-attr", "--all", "-z", "--stdin"], {
    ...listing, input: paths.length ? `${paths.join("\0")}\0` : ""
  }).stdout;
  const attributeRecords = nulRecords(attributes);
  const rawPaths = new Set();
  if (attributeRecords.length % 3 !== 0) throw incompleteSnapshot("err.snapshot_attributes_invalid");
  for (let offset = 0; offset < attributeRecords.length; offset += 3) {
    if (["text", "crlf"].includes(attributeRecords[offset + 1]) && attributeRecords[offset + 2] === "unset") rawPaths.add(attributeRecords[offset]);
    if (["filter", "diff", "text", "eol", "crlf", "ident", "working-tree-encoding"].includes(attributeRecords[offset + 1]) &&
      !["unspecified", "unset"].includes(attributeRecords[offset + 2])) throw incompleteSnapshot("err.snapshot_attributes_unsupported");
  }
  return { head: head.stdout.trim(), objectFormat, index, headFiles, untracked, paths, autoCrlf, rawPaths,
    indexIdentity: JSON.stringify([head.stdout, objectFormat, indexText, headText, config.stdout, attributes]),
    identity: JSON.stringify([head.stdout, objectFormat, indexText, headText, untrackedText, config.stdout, attributes]) };
}

function immutableBlob(repoRoot, oid, objectFormat, cache, options: GitOptions = {}) {
  if (cache.entries.has(oid)) return cache.entries.get(oid);
  const content = Buffer.from(gitChecked(repoRoot, ["cat-file", "blob", oid], {
    ...options, maxBuffer: MAX_FINGERPRINT_TOTAL_BYTES + 1024
  }).stdout, "utf8");
  const actual = createHash(objectFormat).update(`blob ${content.length}\0`).update(content).digest("hex");
  if (actual !== oid) throw incompleteSnapshot("err.snapshot_blob_lossless");
  if (cache.totalBytes + content.length > MAX_FINGERPRINT_TOTAL_BYTES) throw incompleteSnapshot("err.snapshot_blob_size");
  cache.entries.set(oid, content);
  cache.totalBytes += content.length;
  return content;
}

function cleanOrdinaryAutoCrlf(bytes, indexedBytes) {
  // Git v2.55.0 convert.c: convert_attrs の AUTO、crlf_to_git、has_crlf_in_index。
  // UTF-8 の通常テキストだけを扱う。この範囲は gather_stats の nonprintable=0 なので
  // convert_is_binary=false と証明できる。混在改行・bare CR・index CRLF は未対応にする。
  const ordinaryText = (content) => {
    const text = content.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(content) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw incompleteSnapshot("err.snapshot_binary_conversion");
    return text;
  };
  const indexedText = ordinaryText(indexedBytes);
  if (indexedText.includes("\r")) throw incompleteSnapshot("err.snapshot_crlf_index");
  const text = ordinaryText(bytes);
  const withoutPairs = text.replace(/\r\n/g, "");
  if (withoutPairs.includes("\r") || (text.includes("\r\n") && withoutPairs.includes("\n"))) throw incompleteSnapshot("err.snapshot_mixed_eol");
  return text.includes("\r\n") ? Buffer.from(text.replace(/\r\n/g, "\n"), "utf8") : bytes;
}

function replacementPatch(name, before, after, oldMode = "100644", newMode = "100644") {
  if (before !== null && after !== null && before.equals(after) && oldMode === newMode) return "";
  for (const bytes of [before, after]) {
    if (bytes && (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))) throw incompleteSnapshot("err.snapshot_changed_binary");
  }
  const a = JSON.stringify(`a/${name}`);
  const b = JSON.stringify(`b/${name}`);
  const lines = [`diff --git ${a} ${b}`];
  if (before === null) lines.push(`new file mode ${newMode}`);
  else if (after === null) lines.push(`deleted file mode ${oldMode}`);
  else if (oldMode !== newMode) lines.push(`old mode ${oldMode}`, `new mode ${newMode}`);
  if (before !== null && after !== null && before.equals(after)) return `${lines.join("\n")}\n`;
  lines.push(`--- ${before === null ? "/dev/null" : a}`, `+++ ${after === null ? "/dev/null" : b}`);
  const contentLines = (bytes) => !bytes?.length ? [] : bytes.toString("utf8").replace(/\n$/, "").split("\n");
  const oldLines = contentLines(before);
  const newLines = contentLines(after);
  if (!oldLines.length && !newLines.length) return `${lines.slice(0, -2).join("\n")}\n`;
  lines.push(`@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`);
  for (const [prefix, contents, bytes] of [["-", oldLines, before], ["+", newLines, after]]) {
    for (const line of contents) lines.push(`${prefix}${line}`);
    if (contents.length && bytes.at(-1) !== 10) lines.push("\\ No newline at end of file");
  }
  return `${lines.join("\n")}\n`;
}

export function collectWorkingTreeSnapshot(cwd, options: GitOptions = {}) {
  const checkDeadline = () => { if (options.deadline !== undefined) gitLookupTimeout(options); };
  const repoRoot = ensureGitRepository(cwd, options);
  const metadata = workingTreeMetadata(repoRoot, options);
  const files = readWindowsWorkingTreeFiles(repoRoot, metadata.paths, options);
  const confirmation = readWindowsWorkingTreeFiles(repoRoot, metadata.paths, options);
  if (metadata.paths.some((name) => files.get(name) === null ? confirmation.get(name) !== null :
    confirmation.get(name) === null || !files.get(name).equals(confirmation.get(name))) || metadata.untracked.some((name) => files.get(name) === null) ||
    workingTreeMetadata(repoRoot, options).identity !== metadata.identity) throw incompleteSnapshot("err.snapshot_changed_during");
  const staged = [];
  const unstaged = [];
  const blobs = { entries: new Map(), totalBytes: 0 };
  const cleanFiles = new Map(files);
  for (const name of listUniqueFiles([...metadata.headFiles.keys()], [...metadata.index.keys()])) {
    checkDeadline();
    const previous = metadata.headFiles.get(name);
    const indexed = metadata.index.get(name);
    if (previous?.oid !== indexed?.oid || previous?.mode !== indexed?.mode) staged.push(name);
    if (indexed) {
      let bytes = files.get(name);
      const blobOid = (content) => content === null ? null : createHash(metadata.objectFormat).update(`blob ${content.length}\0`).update(content).digest("hex");
      let actual = blobOid(bytes);
      // AUTO では binary は変換されず、index に同じ CRLF があれば変換も抑止される。
      // raw OID の一致は全ての accepted AUTO 属性で clean と証明でき、blob の UTF-8 解釈も不要。
      if (actual !== indexed.oid && bytes !== null && metadata.autoCrlf && !metadata.rawPaths.has(name)) {
        bytes = cleanOrdinaryAutoCrlf(bytes, immutableBlob(repoRoot, indexed.oid, metadata.objectFormat, blobs, options));
        cleanFiles.set(name, bytes);
        actual = blobOid(bytes);
      }
      if (actual !== indexed.oid) unstaged.push(name);
    }
  }
  const state = { staged, unstaged, untracked: metadata.untracked, isDirty: Boolean(staged.length || unstaged.length || metadata.untracked.length) };
  const fingerprint = createHash("sha256").update(metadata.identity);
  const entries = metadata.paths.flatMap((name) => {
    checkDeadline();
    const bytes = files.get(name);
    if (bytes === null) { fingerprint.update(`\0${name}\0missing\0`); return []; }
    fingerprint.update(`\0${name}\0${bytes.length}\0`).update(bytes);
    return [{ path: name, mode: metadata.index.get(name)?.mode ?? "100644", content: bytes.toString("base64") }];
  });
  // state/fingerprint は binary を含め全 byte を観測する。patch は必要な呼出元だけが生成する。
  const buildDiffs = () => {
    let stagedDiff = "";
    let unstagedDiff = "";
    for (const name of staged) {
      const previous = metadata.headFiles.get(name);
      const indexed = metadata.index.get(name);
      stagedDiff += replacementPatch(name, previous ? immutableBlob(repoRoot, previous.oid, metadata.objectFormat, blobs, options) : null,
        indexed ? immutableBlob(repoRoot, indexed.oid, metadata.objectFormat, blobs, options) : null, previous?.mode, indexed?.mode);
    }
    for (const name of unstaged) {
      const indexed = metadata.index.get(name);
      unstagedDiff += replacementPatch(name, immutableBlob(repoRoot, indexed.oid, metadata.objectFormat, blobs, options), cleanFiles.get(name), indexed.mode, indexed.mode);
    }
    return { stagedDiff, unstagedDiff };
  };
  checkDeadline();
  return { version: 1, fingerprint: fingerprint.digest("hex"),
    indexFingerprint: createHash("sha256").update(metadata.indexIdentity).digest("hex"),
    head: metadata.head, files: entries, state, buildDiffs };
}

export function captureWorkingTreeReviewSnapshot(cwd, options: GitOptions = {}) {
  return buildWorkingTreeReviewSnapshot(collectWorkingTreeSnapshot(cwd), options);
}

/**
 * 取得済みの完全 snapshot からレビュー用の差分本文を組み立てる。
 * 取り直した snapshot でも再利用した snapshot でも、差分生成とサイズ上限の検査を必ず通す。
 */
function buildWorkingTreeReviewSnapshot(snapshot: ReturnType<typeof collectWorkingTreeSnapshot>, options: GitOptions = {}) {
  const { stagedDiff, unstagedDiff } = snapshot.buildDiffs();
  const untrackedPaths = new Set(snapshot.state.untracked);
  const untracked = snapshot.files.filter((file) => untrackedPaths.has(file.path)).map((file) =>
    replacementPatch(file.path, null, Buffer.from(file.content, "base64"), "100644", file.mode)).join("\n");
  const context = [formatSection("Staged Diff", stagedDiff), formatSection("Unstaged Diff", unstagedDiff),
    formatSection("Untracked Files", untracked)].join("\n");
  if (Buffer.byteLength(context) > normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes)) throw incompleteSnapshot("err.snapshot_inline_size");
  return { fingerprint: snapshot.fingerprint, context, complete: true, state: snapshot.state, files: snapshot.files };
}

/**
 * 自動スコープで dirty と判定した target に、判定に使った完全 snapshot を結び付ける。
 * collectReviewContext は target をそのまま戻り値へ含めるため、target の列挙可能プロパティに
 * すると最大 8MiB の内容が残ってしまう。target をキーにした WeakMap で保持し、取り出したら破棄する。
 */
const resolvedWorkingTreeSnapshots = new WeakMap<object, { repoRoot: string; snapshot: ReturnType<typeof collectWorkingTreeSnapshot> }>();

/** target に結び付いた snapshot を取り出して破棄する。repoRoot が一致するときだけ使う。 */
function takeResolvedWorkingTreeSnapshot(target, repoRoot) {
  if (!target || typeof target !== "object") return null;
  const held = resolvedWorkingTreeSnapshots.get(target);
  if (!held) return null;
  resolvedWorkingTreeSnapshots.delete(target);
  return held.repoRoot === repoRoot ? held.snapshot : null;
}

export function resolveReviewTarget(cwd, options: GitOptions = {}) {
  const repoRoot = ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const supportedScopes = new Set(["auto", "working-tree", "branch", "repo"]);

  if (requestedScope === "repo") {
    if (baseRef) {
      throw new Error(t("err.git_base_with_repo_scope"));
    }
    return {
      mode: "repo",
      label: "full repository",
      explicit: true
    };
  }

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(t("err.git_unsupported_scope", { scope: requestedScope }));
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  // getWorkingTreeState と同じ完全 snapshot を取り、dirty なら収集側で 1 回だけ再利用する。
  const snapshot = collectWorkingTreeSnapshot(cwd);
  if (snapshot.state.isDirty) {
    const target = {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
    resolvedWorkingTreeSnapshots.set(target, { repoRoot, snapshot });
    return target;
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body : "(none)", ""].join("\n");
}

// 唯一の呼出元 collectReviewContext が比較・変更一覧・現在のブランチを取得済みなので、
// ここでは取り直さない（Git の起動回数を増やさない）。
function collectBranchContext(cwd, baseRef, currentBranch, options: GitOptions & { comparison: ReturnType<typeof buildBranchComparison>; changedFiles: string[] }) {
  const includeDiff = options.includeDiff !== false;
  const { comparison, changedFiles } = options;
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange], { quotePaths: false }).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            options.diffOutput ?? gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=short", comparison.commitRange], { quotePaths: false }).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.map(displayPath).join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function formatCappedListing(entries) {
  if (entries.length <= MAX_REPO_LISTING_ENTRIES) {
    return entries.map(displayPath).join("\n");
  }
  const shown = entries.slice(0, MAX_REPO_LISTING_ENTRIES);
  return [...shown.map(displayPath), `(+${entries.length - shown.length} more files - run \`git ls-files\` for the full list)`].join("\n");
}

// リポジトリ監査は差分を渡さない。棚卸し（ファイル一覧と直近ログ）だけを渡し、
// 中身は Grok が read-only コマンドで自分で読む前提にする。
function collectRepoContext(cwd) {
  const listingOptions = { maxBuffer: MAX_FILE_LISTING_BYTES };
  const trackedFiles = splitNulPaths(gitChecked(cwd, ["ls-files", "-z"], listingOptions).stdout);
  const untrackedFiles = splitNulPaths(gitChecked(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], listingOptions).stdout);
  const logOutput = git(cwd, ["log", "--oneline", "--decorate", "-n", "15"]).stdout.trim();

  return {
    mode: "repo",
    summary: `Auditing the full repository: ${trackedFiles.length} tracked and ${untrackedFiles.length} untracked file(s).`,
    content: [
      formatSection("Tracked Files", formatCappedListing(trackedFiles)),
      formatSection("Untracked Files", formatCappedListing(untrackedFiles)),
      formatSection("Recent Commits", logOutput)
    ].join("\n"),
    changedFiles: trackedFiles
  };
}

function buildAdversarialCollectionGuidance(options: GitOptions = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  const range = options.comparison?.commitRange;
  const command = range
    ? `git ${READ_ONLY_GIT_GLOBAL_ARGS.join(" ")} diff --no-ext-diff --no-textconv ${range}`
    : null;
  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings." +
    (command ? ` Use this fixed object comparison: ${command}. Put optional display flags after the range, and paths only after --. Do not substitute HEAD, branch names or extra revisions.` : "");
}

export function collectReviewContext(cwd, target, options: GitOptions = {}) {
  const repoRoot = ensureGitRepository(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "repo") {
    const repoDetails = collectRepoContext(repoRoot);
    return {
      cwd: repoRoot,
      repoRoot,
      branch: currentBranch,
      target,
      fileCount: repoDetails.changedFiles.length,
      diffBytes: 0,
      inputMode: "self-collect",
      collectionGuidance:
        "The repository context below is only a file inventory. Ignore the current uncommitted diff entirely and audit the source as it exists on disk, reading files yourself with read-only commands.",
      ...repoDetails
    };
  }

  if (target.mode === "working-tree") {
    // 自動スコープの resolve 時に取った snapshot があれば取り直さない。明示 --scope working-tree や
    // 手組みの target では snapshot が無いので、従来どおりここで取得する。
    const resolved = takeResolvedWorkingTreeSnapshot(target, repoRoot);
    const snapshot = resolved
      ? buildWorkingTreeReviewSnapshot(resolved, { maxInlineDiffBytes })
      : captureWorkingTreeReviewSnapshot(repoRoot, { maxInlineDiffBytes });
    const state = snapshot.state;
    diffBytes = Buffer.byteLength(snapshot.context);
    includeDiff = true;
    details = {
      mode: "working-tree", fingerprint: snapshot.fingerprint,
      summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
      content: snapshot.context, changedFiles: listUniqueFiles(state.staged, state.unstaged, state.untracked)
    };
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    assertCompleteBranchComparison(repoRoot, comparison);
    const changedFiles = splitNulPaths(gitChecked(repoRoot, ["diff", "--name-only", "-z", comparison.commitRange]).stdout);
    // ファイル数だけで軽量表示に決まる場合は、diff 本文（最大 256KiB）を取得しない。
    // このとき diffBytes は未計測として null を返す（companion は diffBytes を使わない）。
    const tooManyFiles = options.includeDiff == null && changedFiles.length > maxInlineFiles;
    const diffOutput = tooManyFiles
      ? { bytes: null, stdout: undefined }
      : collectBoundedGitOutput(
        repoRoot,
        ["diff", "--binary", "--no-ext-diff", "--submodule=short", comparison.commitRange],
        maxInlineDiffBytes,
        { quotePaths: false }
      );
    diffBytes = diffOutput.bytes;
    includeDiff = options.includeDiff ?? (!tooManyFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, currentBranch, { includeDiff, comparison, changedFiles, diffOutput: diffOutput.stdout });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff, comparison: details.comparison }),
    ...details
  };
}
