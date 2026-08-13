import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 256 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const MAX_REPO_LISTING_ENTRIES = 2000;

// spawnSync の maxBuffer 既定は 1MiB しかなく、数万ファイルのリポジトリでは
// `git ls-files` の出力がそれを超えて ENOBUFS で監査ごと落ちる。
// 一覧は表示前に MAX_REPO_LISTING_ENTRIES で切るので、取得側は広めに取る。
const MAX_FILE_LISTING_BYTES = 64 * 1024 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
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

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
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

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"], {
    maxBuffer: MAX_FILE_LISTING_BYTES
  })
    .stdout.trim()
    .split("\n")
    .filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch", "repo"]);

  if (requestedScope === "repo") {
    if (baseRef) {
      throw new Error("--base does not apply to --scope repo. A repository audit reviews the whole source, not a diff.");
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
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, repo, or pass --base <ref>.`
    );
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

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
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
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath, remainingBytes) {
  const repoRoot = fs.realpathSync(cwd);
  const absolutePath = path.resolve(repoRoot, relativePath);
  const relativeToRoot = path.relative(repoRoot, absolutePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    return { text: `### ${relativePath}\n(skipped: path escapes repository)`, bytes: 0 };
  }
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return { text: `### ${relativePath}\n(skipped: unreadable file)`, bytes: 0 };
  }
  if (stat.isSymbolicLink()) {
    return { text: `### ${relativePath}\n(skipped: symbolic link)`, bytes: 0 };
  }
  if (stat.isDirectory()) {
    return { text: `### ${relativePath}\n(skipped: directory)`, bytes: 0 };
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return { text: `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`, bytes: 0 };
  }
  if (stat.size > remainingBytes) {
    return { text: `### ${relativePath}\n(skipped: aggregate untracked-file limit reached)`, bytes: 0 };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return { text: `### ${relativePath}\n(skipped: unreadable file)`, bytes: 0 };
  }
  if (buffer.length > MAX_UNTRACKED_BYTES || buffer.length > remainingBytes) {
    return { text: `### ${relativePath}\n(skipped: file grew beyond an untracked-file limit)`, bytes: 0 };
  }
  if (!isProbablyText(buffer)) {
    return { text: `### ${relativePath}\n(skipped: binary file)`, bytes: 0 };
  }

  return {
    text: [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n"),
    bytes: buffer.length
  };
}

function formatUntrackedFiles(cwd, relativePaths) {
  let includedBytes = 0;
  return relativePaths.map((relativePath) => {
    const formatted = formatUntrackedFile(cwd, relativePath, MAX_UNTRACKED_TOTAL_BYTES - includedBytes);
    includedBytes += formatted.bytes;
    return formatted.text;
  }).join("\n\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = formatUntrackedFiles(cwd, state.untracked);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = formatUntrackedFiles(cwd, state.untracked);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function formatCappedListing(entries) {
  if (entries.length <= MAX_REPO_LISTING_ENTRIES) {
    return entries.join("\n");
  }
  const shown = entries.slice(0, MAX_REPO_LISTING_ENTRIES);
  return [...shown, `(+${entries.length - shown.length} more files - run \`git ls-files\` for the full list)`].join("\n");
}

// リポジトリ監査は差分を渡さない。棚卸し（ファイル一覧と直近ログ）だけを渡し、
// 中身は Grok が read-only コマンドで自分で読む前提にする。
function collectRepoContext(cwd) {
  const listingOptions = { maxBuffer: MAX_FILE_LISTING_BYTES };
  const trackedFiles = gitChecked(cwd, ["ls-files"], listingOptions).stdout.trim().split("\n").filter(Boolean);
  const untrackedFiles = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"], listingOptions)
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
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

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
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
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}
