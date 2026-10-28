/**
 * Grok Build を ACP 越しに動かすランタイム層。
 *
 * 本家 codex-plugin-cc の lib/codex.mjs に対応する。移植にあたっての主な差分:
 *
 *   - Codex の `thread/*` を ACP の `session/*` へ置き換えた。用語も thread → session
 *     に統一している（外向けの戻り値キーは sessionId）。
 *   - Codex には `review/start` という専用 API があったが、Grok には無い。
 *     レビューは通常の `session/prompt` にレビュー指示と JSON Schema を載せて行い、
 *     読み取り専用の担保は ACP の権限応答側（書き込み系ツールを拒否）で取る。
 *   - Codex 版は `turn/start` が即座に返り、通知の流れから完了を推測して
 *     タイマーで打ち切っていた。ACP の `session/prompt` はターン終了時に
 *     stopReason を伴って解決するため、その推測機構は不要になり削除した。
 *   - `externalAgentConfig/import`（Claude セッションの取り込み）に相当する
 *     機能が Grok に無いため、importExternalAgentSession は移植していない。
 *
 * @typedef {import("./acp-protocol").AcpNotification} AcpNotification
 * @typedef {import("./acp-protocol").SessionUpdate} SessionUpdate
 * @typedef {import("./acp-protocol").StopReason} StopReason
 * @typedef {((update: string | { message: string, phase: string | null, sessionId?: string | null, grokSessionId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { readJsonFile } from "./fs.mjs";
import { READ_ONLY_GIT_GLOBAL_ARGS } from "./git.mjs";
import {
  BROKER_ENDPOINT_ENV,
  GrokAcpClient,
  getAcpPromptFailureEvidence,
  getAcpPromptSuccessEvidence,
  getBrokerUnsentRejection,
  quoteIfNeeded,
  createAllowAllPermissionResponder,
  createReadOnlyPermissionResponder
} from "./acp.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";
import { looksLikeVerificationCommand } from "./job-status.mjs";
import { shortenText } from "./text.mjs";

const TASK_SESSION_PREFIX = "Grok Companion Task";
// client ごとの送信監視を runPrompt の enqueue closure と共有する。
const brokerRequests = new WeakMap();
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";

/**
 * レビューに使う既定モデル。
 *
 * API キー認証だと `session/new` の既定が `grok-4.20-0309-non-reasoning` になり、
 * 推論なしモデルではレビュー品質が落ちる。明示的に推論可能な最上位を指す。
 * 環境変数 GROK_PLUGIN_MODEL で上書きできる。
 */
const DEFAULT_REVIEW_MODEL = "grok-4.7";

/**
 * ツール名だけで書き込みと判定できるもの。
 *
 * シェル実行系（run_terminal_command 等）はここに入れない。レビュー中の Grok は
 * `git diff` や `git show` のような読み取り専用コマンドを普通に使うため、
 * 名前で一律に拒否するとレビューそのものが中断してしまう。
 * シェルは classifyShellCommand が中身を見て可否を決める。
 */
const MUTATING_TOOL_PATTERN = /(write|edit|create|delete|remove|rename|patch|apply_|multi_edit|str_replace)/i;

/**
 * 読み取り専用として許可するコマンド。
 * git はサブコマンドまで見て、履歴や作業ツリーを変えないものだけ通す。
 */
/**
 * 汎用インタプリタ（node / python など）は載せない。
 * `-e` や `-c` の引数一つで任意の書き込みができてしまい、
 * コマンド名だけでは読み取り専用を保証できないため。
 * ack / ag の pager と tree の出力ファイル指定も同じ理由で載せない。
 * 情報を取りたいときは Grok 自身のファイル読み取りツールを使わせる。
 */
const READ_ONLY_COMMANDS = new Set([
  "cat", "head", "tail", "type",
  "ls", "dir", "pwd", "find", "stat", "file", "wc",
  "rg", "grep", "egrep", "fgrep",
  "echo", "which", "where", "basename", "dirname", "realpath",
  "jq", "cut", "sed", "tr", "diff"
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "diff", "show", "log", "status", "blame", "ls-files", "ls-tree", "rev-parse",
  "describe", "cat-file", "shortlog", "grep", "whatchanged"
]);
// 同じ綴りでも別サブコマンドでは危険な一意省略になり得る（cat-file --text）。
// 完全名を所有するサブコマンドだけで許可し、共通の長名許可リストを使わない。
const SAFE_GIT_DIFF_OPTIONS = [
  "--no-ext-diff", "--no-textconv", "--stat", "--shortstat", "--numstat",
  "--name-only", "--name-status", "--raw", "--patch", "--no-patch", "--binary",
  "--cached", "--staged", "--check", "--summary", "--compact-summary",
  "--full-index", "--no-renames", "--find-renames", "--find-copies",
  "--ignore-all-space", "--ignore-space-change", "--ignore-space-at-eol",
  "--ignore-cr-at-eol", "--ignore-blank-lines", "--no-color", "--relative",
  "--exit-code", "--quiet", "--text"
];
const SAFE_GIT_REVISION_OPTIONS = [
  "--all", "--branches", "--tags", "--remotes", "--first-parent", "--no-merges",
  "--merges", "--reverse", "--topo-order", "--date-order", "--parents",
  "--children", "--left-right", "--boundary", "--graph", "--cherry-pick",
  "--cherry-mark", "--follow", "--abbrev-commit", "--no-abbrev-commit", "--count"
];
const SAFE_GIT_HISTORY_OPTIONS = new Set([
  ...SAFE_GIT_DIFF_OPTIONS, ...SAFE_GIT_REVISION_OPTIONS, "--oneline", "--decorate", "--no-decorate"
]);
const SAFE_GIT_LONG_OPTIONS_BY_SUBCOMMAND = new Map([
  ["diff", new Set([...SAFE_GIT_DIFF_OPTIONS, "--no-index"])],
  ["log", SAFE_GIT_HISTORY_OPTIONS], ["show", SAFE_GIT_HISTORY_OPTIONS],
  ["whatchanged", SAFE_GIT_HISTORY_OPTIONS],
  ["blame", new Set([
    ...SAFE_GIT_DIFF_OPTIONS, ...SAFE_GIT_REVISION_OPTIONS,
    "--porcelain", "--line-porcelain", "--incremental", "--long"
  ])],
  ["status", new Set(["--short", "--porcelain", "--long", "--branch", "--show-stash", "--ignored", "--no-renames", "--find-renames"])],
  ["ls-files", new Set(["--cached", "--stage", "--unmerged", "--deleted", "--modified", "--others", "--ignored", "--exclude-standard", "--full-name", "--error-unmatch"])],
  ["ls-tree", new Set(["--name-only", "--name-status", "--long", "--full-name", "--full-tree"])],
  ["rev-parse", new Set([
    "--all", "--branches", "--tags", "--remotes", "--show-toplevel", "--show-prefix", "--show-cdup",
    "--is-inside-work-tree", "--is-bare-repository", "--git-dir", "--git-common-dir", "--verify",
    "--symbolic", "--symbolic-full-name", "--abbrev-ref", "--short", "--quiet"
  ])],
  ["describe", new Set(["--all", "--tags", "--contains", "--long", "--always", "--exact-match"])],
  ["cat-file", new Set()],
  ["shortlog", new Set([...SAFE_GIT_REVISION_OPTIONS, "--numbered", "--summary"])],
  ["grep", new Set([
    "--cached", "--no-index", "--no-recurse-submodules", "--no-textconv", "--no-color", "--full-name",
    "--count", "--quiet", "--ignore-case", "--fixed-strings", "--extended-regexp", "--basic-regexp",
    "--perl-regexp", "--line-number", "--files-with-matches", "--files-without-match",
    "--invert-match", "--word-regexp", "--text"
  ])]
]);

function isSafeGitOption(token, sub) {
  if (!token.startsWith("-")) return true;
  // 単独の短名と検証済み数値形式だけを認め、短名の組合せは認めない。
  if (/^-(?:[0-9]+|[pnzburwtlvaHIEFqsmSLneAfBt]|[UMC][0-9]*|n[0-9]+)$/.test(token)) return true;
  if (SAFE_GIT_LONG_OPTIONS_BY_SUBCOMMAND.get(sub)?.has(token)) return true;
  const diff = ["diff", "log", "show", "whatchanged", "blame"].includes(sub);
  const history = ["log", "show", "whatchanged", "blame", "shortlog"].includes(sub);
  if (diff && /^--unified=[0-9]+$/.test(token)) return true;
  if (sub === "log" && /^--since=[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(token)) return true;
  if (history && /^--(?:max-count|skip)=[0-9]+$/.test(token)) return true;
  if (["diff", "log", "show", "whatchanged", "blame", "ls-tree", "describe"].includes(sub) && /^--abbrev=[0-9]+$/.test(token)) return true;
  if (sub === "status" && /^(?:--porcelain=(?:v1|v2|1|2)|--untracked-files=(?:no|normal|all))$/.test(token)) return true;
  if (["diff", "log", "show", "whatchanged"].includes(sub) && /^--submodule=(?:short|log)$/.test(token)) return true;
  if ((diff || sub === "grep") && /^--color=(?:never|auto)$/.test(token)) return true;
  if (["log", "show", "whatchanged", "shortlog"].includes(sub) && /^--(?:pretty|format)=(?:oneline|short|medium|full|fuller|reference|raw)$/.test(token)) return true;
  return ["log", "show", "whatchanged"].includes(sub) && /^--diff-merges=(?:off|none|first-parent|separate|combined|dense-combined)$/.test(token);
}

function isSafeFixedObjectDiff(args) {
  if (!/^(?:[a-f0-9]{40}\.\.[a-f0-9]{40}|[a-f0-9]{64}\.\.[a-f0-9]{64})$/.test(args[2] ?? "")) return false;
  const separator = args.indexOf("--", 3);
  const options = separator < 0 ? args.slice(3) : args.slice(3, separator);
  const simpleOptions = new Set([
    "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--raw",
    "--patch", "--no-patch", "--binary", "--check", "--summary", "--compact-summary",
    "--full-index", "--no-renames", "--ignore-all-space", "--ignore-space-change",
    "--ignore-space-at-eol", "--ignore-cr-at-eol", "--ignore-blank-lines", "--no-color",
    "--exit-code", "--quiet", "--text", "--submodule=short", "-p", "-u", "-w", "-b", "-z"
  ]);
  if (options.some((arg) => !simpleOptions.has(arg) && !/^--(?:unified|abbrev)=[0-9]+$/.test(arg))) return false;
  // 追加 revision や暗黙の path を認めず、path は -- の後だけで明示する。
  if (separator >= 0 && (separator === args.length - 1 ||
      args.slice(separator + 1).some((arg) => !arg || arg.startsWith("-") || arg.includes(":")))) return false;
  return true;
}

/** ファイルへ書き出すリダイレクトと、その場編集を示す痕跡。 */
const WRITE_SIDE_EFFECT_PATTERN = /(^|\s)(>>?|\btee\b)(\s|$)|(^|\s)-i(\s|$)/;

/**
 * コマンド置換。`git log $(rm -rf .)` のように、許可コマンドの引数へ
 * 埋め込むだけで別のコマンドが先に走るため、中身を見ずに一律で拒否する。
 */
const COMMAND_SUBSTITUTION_PATTERN = /\$\(|\$\{|`/;
const UNSAFE_SHELL_SYNTAX_PATTERN = /[\r\n{}]|(?<!&)&(?!&)|[<>]|\^|%[^%]+%|![A-Za-z_][A-Za-z0-9_]*!|\$[A-Za-z_]/;
const OUTSIDE_PATH_PATTERN = /(^|[\s"'=\\/])(?:\.\.(?:[\\/]|$)|~(?:[\\/]|$)|[A-Za-z]:|[\\/]{2}|\/(?!dev\/null\b))/;

/**
 * 許可コマンドの中でも、引数次第でシェルへ抜けたり書き込んだりできるもの。
 * `git` と同じく、名前だけでなく引数まで見て判定する。
 */
const UNSAFE_FIND_ARGUMENTS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprintf", "-fprint0"]);

/** sed は行番号を指定した表示だけ許可する。任意の sed スクリプトには実行・書き込み命令がある。 */
function isSafeSedPrint(tokens) {
  const args = tokens.slice(1);
  return args[0] === "-n" &&
    /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(args[1] ?? "") &&
    args.slice(2).every((arg) => arg && !arg.startsWith("-"));
}

function cleanGrokStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^\s*(WARNING|warning): proceeding/.test(line))
    .join("\n");
}

function buildTaskSessionName(prompt) {
  const excerpt = shortenText(prompt, 56);
  return excerpt ? `${TASK_SESSION_PREFIX}: ${excerpt}` : TASK_SESSION_PREFIX;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (typeof onProgress !== "function") {
    return;
  }
  // job保存用の正規キーへそろえる。sessionIdは既存callbackとの互換用に残す。
  onProgress({ message, phase, ...extra, ...(extra.sessionId ? { grokSessionId: extra.sessionId } : {}) });
}

function emitLogEvent(onProgress, options = {}) {
  if (typeof onProgress !== "function") {
    return;
  }
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

/**
 * シェルコマンドが読み取り専用かどうかを判定する。
 *
 * `&&` `||` `;` `|` で区切った各セグメントの先頭コマンドを見て、すべてが
 * 許可リストに載っていて、かつファイルへの書き出しを含まない場合だけ許可する。
 * 判断できないものは拒否側に倒す。
 *
 * @returns {{ allowed: boolean, reason: string | null }}
 */
/**
 * コマンド行を語へ分ける。引用符で囲まれた部分は 1 語として扱う。
 * Windows の `"C:\Program Files\Git\bin\git.exe" diff` を素の空白分割で壊さないため。
 */
function tokenizeCommand(segment) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let previousEnd = 0;
  let match;
  while ((match = pattern.exec(segment)) !== null) {
    // 日付に限定した Git 履歴の値だけは、両シェルで等価な二重引用を認める。
    const quotedSince = /^(--since=)"([0-9]{4}-[0-9]{2}-[0-9]{2})"$/.exec(match[3] ?? "");
    // 引用部分と通常文字が隣接する語は shell では 1 語に連結される。
    // この簡易 tokenizer で同じ解釈を保証できないため拒否する。
    if ((tokens.length > 0 && match.index === previousEnd) || (/["']/.test(match[3] ?? "") && !quotedSince)) {
      return null;
    }
    tokens.push(quotedSince ? quotedSince[1] + quotedSince[2] : match[1] ?? match[2] ?? match[3]);
    previousEnd = pattern.lastIndex;
  }
  return tokens;
}

function isWithinPath(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Test-Path の単一パスを作業領域内へ閉じ込める。存在しない末尾は既存の祖先まで検査する。 */
function isSafeTestPath(target, cwd) {
  const nativeDrivePath = process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(target) &&
    target.indexOf(":", 2) === -1;
  if (!target || !cwd || target.startsWith("~") ||
      (target.includes(":") && !nativeDrivePath) ||
      target.split(/[\\/]/).some((part) => /[. ]$/.test(part))) {
    return false;
  }
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, target);
  if (!isWithinPath(root, resolved)) {
    return false;
  }

  try {
    const realRoot = fs.realpathSync.native(root);
    let existing = resolved;
    while (true) {
      try {
        fs.lstatSync(existing);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") return false;
        const parent = path.dirname(existing);
        if (parent === existing) return false;
        existing = parent;
      }
    }
    return isWithinPath(realRoot, fs.realpathSync.native(existing));
  } catch {
    return false;
  }
}

export function classifyShellCommand(command, cwd = null) {
  const text = String(command ?? "").trim();
  if (!text) {
    return { allowed: false, reason: "empty command" };
  }

  if (WRITE_SIDE_EFFECT_PATTERN.test(text)) {
    return { allowed: false, reason: "writes to a file or edits in place" };
  }

  // 置換の中身は先頭トークンの判定が届かないので、セグメント分割より前に弾く。
  if (COMMAND_SUBSTITUTION_PATTERN.test(text)) {
    return { allowed: false, reason: "uses command substitution" };
  }

  if (UNSAFE_SHELL_SYNTAX_PATTERN.test(text)) {
    return { allowed: false, reason: "uses unsupported shell control or expansion syntax" };
  }

  const segments = text.split(/\|\||&&|[;|]/).map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    const tokens = tokenizeCommand(segment);
    if (!tokens) {
      return { allowed: false, reason: "uses unsupported shell quoting" };
    }
    // 環境変数で Git や検索ツールの実行内容を変えられるため、前置きは許可しない。
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) {
      return { allowed: false, reason: "sets an environment variable" };
    }
    // パス付き実行ファイルは任意の同名バイナリへ差し替えられる。
    if (/[\\/]/.test(tokens[0] ?? "") || /^[A-Za-z]:/.test(tokens[0] ?? "")) {
      return { allowed: false, reason: "uses an executable path outside the command allowlist" };
    }
    const head = (tokens[0] ?? "").replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
    if (!head) {
      return { allowed: false, reason: `could not parse "${segment}"` };
    }
    if (tokens[0].toLowerCase() === "test-path") {
      if (tokens.length !== 3 || tokens[1].toLowerCase() !== "-literalpath" ||
          !isSafeTestPath(tokens[2], cwd)) {
        return { allowed: false, reason: "Test-Path requires one literal path within the repository" };
      }
      continue;
    }
    if (tokens.slice(1).some((token) => OUTSIDE_PATH_PATTERN.test(` ${token}`))) {
      return { allowed: false, reason: "uses an absolute path or a path that may leave the repository" };
    }

    if (head === "git") {
      if (!READ_ONLY_GIT_GLOBAL_ARGS.every((arg, index) => tokens[index + 1] === arg)) {
        return { allowed: false, reason: "git requires the explicit read-only global options shown in the review instructions" };
      }
      const subIndex = READ_ONLY_GIT_GLOBAL_ARGS.length + 1;
      const sub = tokens[subIndex] ?? "";
      if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
        return { allowed: false, reason: `git ${sub || "(no subcommand)"} is not read-only` };
      }
      const args = tokens.slice(subIndex + 1);
      const separator = args.indexOf("--");
      const options = separator < 0 ? args : args.slice(0, separator);
      // Git は作業ツリー照合中に clean/process filter を起動し得る。
      // インデックス上のデータに限定できない呼び出しは許可しない。
      if (sub === "status" || sub === "blame") {
        return { allowed: false, reason: `git ${sub} cannot be safely restricted to repository objects` };
      }
      if (sub === "diff" && ((!["--cached", "--staged"].includes(args[2]) && !isSafeFixedObjectDiff(args)) || options.includes("--no-index"))) {
        return { allowed: false, reason: "git diff requires --cached, --staged or an exact OID..OID range immediately after the read-only diff options; fixed ranges require explicit -- before paths" };
      }
      if (sub === "grep" && (args[0] !== "--cached" || options.includes("--no-index"))) {
        return { allowed: false, reason: "git grep requires --cached as its first argument" };
      }
      if (sub === "ls-files" && options.some((arg) => arg === "--modified" || arg === "-m")) {
        return { allowed: false, reason: "git ls-files modified checks may invoke worktree filters" };
      }
      if (["diff", "show", "log", "whatchanged"].includes(sub) &&
          !(args.slice(0, 2).includes("--no-ext-diff") && args.slice(0, 2).includes("--no-textconv"))) {
        // -S 等の値に消費された同名トークンを、安全オプションとして数えない。
        return { allowed: false, reason: "git diff/log/show/whatchanged require --no-ext-diff and --no-textconv as the first two subcommand arguments" };
      }
      if (sub === "blame" && args[0] !== "--no-textconv") {
        return { allowed: false, reason: "git blame requires --no-textconv as its first subcommand argument" };
      }
      if (options.some((arg) => !isSafeGitOption(arg, sub))) {
        return { allowed: false, reason: "git uses an unsupported option, abbreviation or short-option combination" };
      }
      continue;
    }

    if (!READ_ONLY_COMMANDS.has(head)) {
      return { allowed: false, reason: `${head} is not on the read-only allowlist` };
    }

    if (head === "sed" && !isSafeSedPrint(tokens)) {
      return { allowed: false, reason: "sed script is not a line-range print" };
    }
    if (head === "rg" && tokens.slice(1).some((token) => /^--pre(?:-glob)?(?:=|$)/.test(token))) {
      return { allowed: false, reason: "rg uses an external preprocessor" };
    }

    if (head === "find" && tokens.slice(1).some((token) => UNSAFE_FIND_ARGUMENTS.has(token))) {
      return { allowed: false, reason: `${head} is being used in a way that can write or run other commands` };
    }
  }

  return { allowed: true, reason: null };
}

/**
 * 権限要求を読み取り専用の観点で判定する。
 *
 * @returns {{ allowed: boolean, reason: string | null }}
 */
function classifyToolCall(params, cwd) {
  const call = params?.toolCall ?? {};
  const rawInput = call.rawInput ?? {};

  // Grok 組み込み WebFetch は URL の内容だけを返す。表示名や read_only フラグだけでは許可しない。
  if (call.kind === "fetch" && rawInput?.variant === "WebFetch") {
    if (Object.keys(rawInput).some((key) => !["variant", "url"].includes(key)) ||
        typeof rawInput.url !== "string") {
      return { allowed: false, reason: "WebFetch requires only a URL" };
    }
    try {
      const url = new URL(rawInput.url);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) {
        return { allowed: true, reason: null };
      }
    } catch {
      // 不正な URL は許可しない。
    }
    return { allowed: false, reason: "WebFetch requires an HTTP(S) URL without credentials" };
  }

  const command = typeof rawInput === "object" && rawInput ? rawInput.command ?? rawInput.cmd : null;
  if (typeof command === "string") {
    return classifyShellCommand(command, cwd);
  }

  const name = [call.title, call.kind].filter(Boolean).join(" ");
  if (MUTATING_TOOL_PATTERN.test(name)) {
    return { allowed: false, reason: "the tool modifies files" };
  }

  return { allowed: false, reason: "the tool is not explicitly known to be read-only" };
}

/**
 * 読み取り専用セッション用の権限応答器。
 *
 * ACP では読み取り系ツールがそもそも問い合わせてこない（実測: list_dir /
 * read_file は自動解決される）が、WebFetch は問い合わせる。明示的に許可した
 * 読み取り専用の要求だけを 1 回許可し、未知の要求は拒否する。
 */
function createReviewPermissionHandler(cwd, onProgress, onDenied = (_reason) => {}) {
  const readOnly = createReadOnlyPermissionResponder();
  return (params) => {
    const verdict = classifyToolCall(params, cwd);
    const permissionOptions = Array.isArray(params?.options) ? params.options : [];
    if (verdict.allowed && permissionOptions.some((option) => option?.kind === "allow_once")) {
      return readOnly(params);
    }

    const reason = verdict.reason ?? "no one-time read-only permission option is available";
    const denial = `${reason}: ${shortenText(params?.toolCall?.title ?? "unknown tool", 60)}`;
    onDenied(denial);
    emitProgress(
      onProgress,
      `Denied during read-only review (${reason}): ${shortenText(params?.toolCall?.title ?? "unknown tool", 60)}`,
      "running"
    );

    const options = Array.isArray(params?.options) ? params.options : [];
    const reject = options.find((option) => ["reject_once", "reject_always"].includes(option?.kind));
    // reject_once を返せばモデルは別の手段へ切り替えられる。cancelled を返すと
    // ターンごと終了してしまうので、選べる拒否肢が無いときの最後の手段にする。
    return reject
      ? { outcome: { outcome: "selected", optionId: reject.optionId } }
      : { outcome: { outcome: "cancelled" } };
  };
}

/**
 * ターン中に流れてくる session/update を集約する。
 *
 * Grok 版の TurnCaptureState に相当するが、完了判定を stopReason に委ねられる
 * ぶん単純化してある。
 */
function createTurnCollector(sessionId, options = {}) {
  const state = {
    sessionId,
    onProgress: options.onProgress ?? null,
    /** エージェントの最終回答本文（チャンクを連結したもの）。 */
    agentMessage: "",
    /**
     * 思考サマリの生バッファ。
     * agent_thought_chunk はトークン単位の断片で届くため、ここへ連結してから
     * 段落へ切り出す。断片をそのまま配列へ積むと 1 単語 1 項目になってしまう。
     */
    reasoningBuffer: "",
    /** 段落へ整形した思考サマリ。finalize で埋める。 */
    reasoning: [],
    /** ツール呼び出しの記録。toolCallId をキーにする。 */
    toolCalls: new Map(),
    /** 変更が入ったファイルのパス。 */
    touchedFiles: new Set(),
    /** 検証コマンドらしき実行の記録。 */
    commandExecutions: [],
    title: null,
    usage: null,
    stopReason: null
  };

  const handle = (message) => {
    const method = message?.method;

    // xAI 独自通知。使用量だけ拾い、他は無視する。
    if (method === "_x.ai/session_notification") {
      const update = message.params?.update;
      if (update?.sessionUpdate === "response_completed" && update.usage) {
        state.usage = update.usage;
      }
      return;
    }

    if (method !== "session/update") {
      return;
    }

    const update = message.params?.update;
    if (!update) {
      return;
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = update.content?.text ?? "";
        state.agentMessage += text;
        return;
      }
      case "agent_thought_chunk": {
        state.reasoningBuffer += update.content?.text ?? "";
        return;
      }
      case "tool_call": {
        const title = update.title ?? update.toolCallId;
        state.toolCalls.set(update.toolCallId, { title, status: update.status ?? "pending" });
        emitProgress(state.onProgress, `Tool: ${shortenText(title, 60)}`, "running", { sessionId });
        return;
      }
      case "tool_call_update": {
        const existing = state.toolCalls.get(update.toolCallId) ?? {};
        const merged = {
          title: update.title ?? existing.title ?? update.toolCallId,
          status: update.status ?? existing.status ?? "pending"
        };
        state.toolCalls.set(update.toolCallId, merged);

        for (const location of update.locations ?? []) {
          if (location?.path) {
            state.touchedFiles.add(location.path);
          }
        }

        const command =
          typeof update.rawInput === "object" && update.rawInput
            ? update.rawInput.command ?? update.rawInput.cmd ?? null
            : null;
        if (command && looksLikeVerificationCommand(String(command))) {
          state.commandExecutions.push({ command: String(command), status: merged.status });
        }
        return;
      }
      case "session_info_update": {
        if (update.title) {
          state.title = update.title;
        }
        return;
      }
      default:
        return;
    }
  };

  /** ターン終了後に、連結済みバッファを読める単位へ切り出す。 */
  const finalize = () => {
    state.reasoning = splitReasoningSections(state.reasoningBuffer);
    return state;
  };

  return { state, handle, finalize };
}

/**
 * 連結した思考テキストを段落へ分ける。
 * 空行区切りを優先し、区切りが無ければ 1 段落として扱う。
 */
function splitReasoningSections(buffer) {
  const text = String(buffer ?? "").trim();
  if (!text) {
    return [];
  }
  return text
    .split(/\n{2,}/)
    .map((section) => section.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * ACP クライアントを開いて処理を実行し、必ず閉じる。
 *
 * ブローカーが他ジョブで埋まっている場合は、ブローカーを介さず
 * 直接 `grok agent stdio` を起動する経路へ落とす（本家と同じ考え方）。
 */
async function withGrok(cwd, handler, options = {}) {
  // 共有ブローカーを使わず、毎回自前で grok を起動する逃げ道。
  // ブローカー由来の不具合を切り分けるときと、プロセスの後始末を
  // 呼び出し側で完結させたいとき（統合テスト）に使う。
  const brokerDisabled =
    options.disableBroker || ["1", "true", "yes"].includes(String((options.env ?? process.env).GROK_COMPANION_DISABLE_BROKER ?? "").toLowerCase());
  const resuming = Boolean(options.resumeSessionId);
  if (resuming && brokerDisabled) {
    throw new Error("Cannot resume a Grok session with the broker disabled: the previous turn stop cannot be verified. Start a fresh session instead.");
  }
  // 新規接続はprompt未送信でもagentが起動し得る。brokerOnly再開は起動を伴わず、
  // 今回jobはprompt入場までnot-sentのまま保つ（旧sessionの終了証拠とは別）。
  if (!resuming) options.prepareConnection?.();
  // session/loadを別agentへ逃がすと、切断後も続く同一sessionを二重実行する。
  const connectOptions = { ...options, disableBroker: brokerDisabled,
    ...(resuming ? { brokerOnly: true, reuseExistingBroker: true } : {}) };
  const connectionObservers = new Map();
  const trackBrokerRequests = connected => {
    if (connected.transport !== "broker" || typeof connected.request !== "function") return;
    const request = connected.request.bind(connected);
    const tracker = { sequence: 0, prompts: 0, rejection: null, sealed: false, lateEnqueue: false };
    brokerRequests.set(connected, tracker);
    connected.request = (method, ...args) => {
      if (tracker.sealed) {
        const rejected = Promise.reject(new Error("Broker request was not sent because the connection is closing."));
        // disposer が戻り値を使わない場合も未処理 rejection にしない。
        void rejected.catch(() => {});
        return rejected;
      }
      const sequence = ++tracker.sequence;
      const requestId = connected.nextId;
      if (method === "session/prompt") tracker.prompts += 1;
      const pending = request(method, ...args);
      return Promise.resolve(pending).catch(error => {
        const evidence = getBrokerUnsentRejection(error, connected);
        if (evidence && evidence.method === method && evidence.requestId === requestId) {
          tracker.rejection = { error, evidence, sequence, prompts: tracker.prompts };
        }
        throw error;
      });
    };
  };
  const closeClient = async (connected) => {
    const tracker = brokerRequests.get(connected);
    if (tracker) tracker.sealed = true;
    const dispose = connectionObservers.get(connected);
    connectionObservers.delete(connected);
    try { dispose?.(); } finally { await connected.close(); }
  };
  const openClient = async (connectionOptions) => {
    const connected = await GrokAcpClient.connect(cwd, connectionOptions);
    trackBrokerRequests(connected);
    try {
      const dispose = options.connectionEstablished?.({ transport: connected.transport,
        brokerGeneration: connected.transport === "broker" ? connected.initializeResult?._meta?.grokBrokerGeneration ?? null : null,
        ...(connected.transport === "broker" ? { close: () => {
          // このworkerのsocketだけを破棄する。共有broker/agentの終了とは区別する。
          if ("socket" in connected) connected.socket?.destroy();
          return connected.close();
        } } : {}) });
      if (typeof dispose === "function") connectionObservers.set(connected, dispose);
      return connected;
    } catch (error) {
      try { await closeClient(connected); } catch { connected.closeStopUnconfirmed = true; }
      if (connected.transport === "direct" && connected.closeStopUnconfirmed) error.turnStopUnconfirmed = true;
      throw error;
    }
  };
  const openDirectClient = () => {
    // 旧brokerの未送信証拠は新たに起動するagentには使えない。
    options.prepareConnection?.();
    return openClient({ ...options, disableBroker: true });
  };

  let client = await openClient(connectOptions);

  if (resuming && client.transport !== "broker") {
    await closeClient(client);
    throw new Error("Cannot resume a Grok session through a direct connection; the previous broker turn may still be running.");
  }

  // 旧brokerは実行世代を識別できず、遅延cancelが次のresumeを止め得る。
  if (options.requireScopedCancellation && client.transport === "broker" &&
      (client.initializeResult?._meta?.grokScopedCancellation !== true ||
       client.initializeResult?._meta?.grokExecutionLedger !== true ||
       typeof client.initializeResult?._meta?.grokBrokerGeneration !== "string" ||
       !client.initializeResult._meta.grokBrokerGeneration ||
       client.initializeResult?._meta?.grokPromptAdmission === false)) {
    await closeClient(client);
    if (resuming) {
      throw new Error("Cannot resume through a broker without execution tracking or prompt capacity. Direct and older-version session history cannot be resumed safely; start a fresh session instead.");
    }
    client = await openDirectClient();
  }

  let completedResult;
  let handlerFailure;
  let handlerFailed = false;
  try {
    return completedResult = await handler(client);
  } catch (error) {
    handlerFailure = error;
    handlerFailed = true;
    // 公開された Error や options の getter が broker に再入する可能性がある。
    // 外部由来の値を先に読み、最後に内部 tracker と固定された応答証拠を照合する。
    let stopUnconfirmed, allowCapacityFallback, brokerTransport;
    try {
      stopUnconfirmed = error?.turnStopUnconfirmed === true;
      allowCapacityFallback = options.allowCapacityFallback;
      brokerTransport = client.transport === "broker";
    } catch (inspectionError) {
      const tracker = brokerRequests.get(client);
      if (tracker) tracker.sealed = true;
      const evidence = getBrokerUnsentRejection(error, client);
      const unconfirmed = Boolean(tracker && evidence &&
        (tracker.lateEnqueue || tracker.prompts > (evidence.method === "session/prompt" ? 1 : 0)));
      let inspectionMessage = "unknown inspection error";
      try { inspectionMessage = inspectionError instanceof Error ? inspectionError.message : String(inspectionError); } catch { /* 原因 object を AggregateError に保持する。 */ }
      /** @type {AggregateError & { turnStopUnconfirmed?: boolean }} */
      const failure = new AggregateError([error, inspectionError], `Broker rejection inspection failed: ${inspectionMessage}`, { cause: error });
      if (unconfirmed) failure.turnStopUnconfirmed = true;
      handlerFailure = failure;
      throw failure;
    }
    const tracker = brokerRequests.get(client);
    const rejection = tracker?.rejection;
    const evidence = getBrokerUnsentRejection(error, client);
    const stillUnsent = () => evidence && tracker && !tracker.lateEnqueue && rejection?.error === error && tracker.rejection === rejection &&
      rejection.sequence === tracker.sequence &&
      rejection.evidence.requestId === evidence.requestId && rejection.evidence.method === evidence.method &&
      rejection.prompts === tracker.prompts && tracker.prompts === (evidence.method === "session/prompt" ? 1 : 0);
    const permitted = !resuming && brokerTransport && !stopUnconfirmed && evidence && tracker && stillUnsent() &&
      (evidence.reason === "busy" || (evidence.reason === "capacity" && allowCapacityFallback));
    if (!permitted || !tracker) {
      // 未送信の元エラーを再送出しても、その後に別 prompt が発行されていれば
      // 同じ未送信証拠を追加 prompt の停止確認に流用できない。
      if (tracker && rejection && evidence && (tracker.lateEnqueue || tracker.prompts > (evidence.method === "session/prompt" ? 1 : 0))) {
        tracker.sealed = true;
        const pending = Object.assign(new Error("A later broker prompt was issued; its stop is unconfirmed.", { cause: error }),
          { turnStopUnconfirmed: true });
        handlerFailure = pending;
        throw pending;
      }
      throw error;
    }
    // close/disposer が呼ばれるより先に送信口を閉じ、await 中の再入も拒否する。
    tracker.sealed = true;
    try {
      await closeClient(client);
    } catch (closeError) {
      const failure = new AggregateError([error, closeError], "Broker cleanup failed before direct fallback.", { cause: error });
      handlerFailure = failure;
      throw failure;
    }
    if (!stillUnsent()) throw error;
    try {
      handlerFailed = false;
      client = await openDirectClient();
      return completedResult = await handler(client);
    } catch (fallbackError) {
      handlerFailure = fallbackError;
      handlerFailed = true;
      throw fallbackError;
    }
  } finally {
    let closeError;
    try { await closeClient(client); } catch (error) { closeError = error; }
    if (client.transport === "direct" && (client.closeStopUnconfirmed || closeError)) {
      if (completedResult && typeof completedResult === "object") completedResult.turnStopUnconfirmed = true;
      if (handlerFailed) {
        if (handlerFailure && typeof handlerFailure === "object") handlerFailure.turnStopUnconfirmed = true;
        else throw Object.assign(new Error(String(handlerFailure)), { turnStopUnconfirmed: true });
      } else if (closeError) {
        closeError.turnStopUnconfirmed = true;
      } else if (!completedResult || typeof completedResult !== "object") {
        throw Object.assign(new Error("Direct Grok agent stop could not be confirmed."), { turnStopUnconfirmed: true });
      }
    }
    // handlerの原因をcleanup例外で上書きしない。
    if (closeError && !handlerFailed) throw closeError;
  }
}

function isBrokerUnsentPrompt(error, client) {
  return getBrokerUnsentRejection(error, client)?.method === "session/prompt";
}

async function withDirectGrok(cwd, handler, options = {}) {
  return withGrok(cwd, handler, { ...options, disableBroker: true });
}

/** JSON-RPC の method not found。ACP v1 で消えた RPC を呼ぶとこれが返る。 */
const RPC_METHOD_NOT_FOUND = -32601;

/**
 * `session/new` が返した設定項目から、指定カテゴリのものを探す。
 * ACP 仕様上 category はあくまで UX ヒントで必須ではないため、
 * 見つからないことを異常扱いにしない。
 */
function findSessionConfigOption(response, category) {
  const configOptions = Array.isArray(response?.configOptions) ? response.configOptions : [];
  return configOptions.find((option) => option?.category === category) ?? null;
}

/** select 型の選択肢はフラットにもグループにもなるので、両方から value を集める。 */
function collectConfigValueIds(option) {
  const ids = [];
  for (const entry of Array.isArray(option?.options) ? option.options : []) {
    if (typeof entry?.value === "string") {
      ids.push(entry.value);
      continue;
    }
    for (const nested of Array.isArray(entry?.options) ? entry.options : []) {
      if (typeof nested?.value === "string") {
        ids.push(nested.value);
      }
    }
  }
  return ids;
}

/**
 * セッション設定を 1 件反映する。反映できなければ理由を返して呼び出し側に委ねる。
 */
function isOwnerGuardError(error) {
  return error?.code === "GROK_JOB_OWNER_GUARD_FAILED" || error?.code === "GROK_JOB_OWNER_CHANGED";
}

async function applySessionConfigOption(client, sessionId, option, wanted, options = {}) {
  const available = collectConfigValueIds(option);
  const value =
    available.find((id) => id === wanted) ??
    available.find((id) => id.toLowerCase() === String(wanted).toLowerCase()) ??
    null;

  if (!value) {
    const detail = available.length ? `not offered (available: ${available.join(", ")})` : "no selectable values";
    return { applied: false, value: null, reason: detail };
  }

  if (option.currentValue !== value) {
    const request = () => client.request("session/set_config_option", { sessionId, configId: option.id, value });
    await (options.guardOwnerEffect ? options.guardOwnerEffect(request) : request());
  }
  return { applied: true, value, reason: null };
}

/**
 * 要求されたモデルへ差し替え、実効モデルを返す。
 *
 * `session/new` の既定モデルは認証方式によって変わる（API キーだと
 * 推論なしモデルになる）ため、現在値と違えば明示的に合わせる。
 * ACP v1 は `session/set_model` を廃止して `session/set_config_option` へ
 * 統合したので、旧 RPC を先に試し method not found のときだけ新経路へ落ちる。
 */
async function applyRequestedModel(client, response, options) {
  const requested = options.model ?? null;
  const current = response.models?.currentModelId ?? null;

  if (!requested || requested === current) {
    return current;
  }

  const available = response.models?.availableModels?.map((model) => model.modelId) ?? [];
  if (available.length && !available.includes(requested)) {
    emitProgress(
      options.onProgress,
      `Model ${requested} is not available; staying on ${current ?? "the session default"}.`,
      "starting"
    );
    return current;
  }

  try {
    const request = () => client.request("session/set_model", { sessionId: response.sessionId, modelId: requested });
    await (options.guardOwnerEffect ? options.guardOwnerEffect(request) : request());
    emitProgress(options.onProgress, `Model set to ${requested}.`, "starting");
    return requested;
  } catch (error) {
    if (error?.rpcCode !== RPC_METHOD_NOT_FOUND) {
      throw error;
    }
  }

  const option = findSessionConfigOption(response, "model");
  if (!option) {
    emitProgress(
      options.onProgress,
      `This Grok build exposes no model selector; staying on ${current ?? "the session default"}.`,
      "starting"
    );
    return current;
  }

  const result = await applySessionConfigOption(client, response.sessionId, option, requested, options);
  if (!result.applied) {
    emitProgress(
      options.onProgress,
      `Model ${requested} is ${result.reason}; staying on ${current ?? "the session default"}.`,
      "starting"
    );
    return current;
  }

  emitProgress(options.onProgress, `Model set to ${result.value}.`, "starting");
  return result.value;
}

/**
 * 要求された推論レベルを反映する。
 * ACP に専用 RPC は無く、`thought_level` カテゴリの設定項目として扱う。
 * 反映可否は本題（レビューや委任タスク）の成否と無関係なので、
 * 失敗しても turn を止めず理由だけ進捗へ流す。
 */
async function applyRequestedEffort(client, response, options) {
  const requested = options.effort ?? null;
  if (!requested) {
    return null;
  }

  const option = findSessionConfigOption(response, "thought_level");
  if (!option) {
    emitProgress(
      options.onProgress,
      `This Grok build exposes no reasoning effort selector; --effort ${requested} was not applied.`,
      "starting"
    );
    return null;
  }

  try {
    const result = await applySessionConfigOption(client, response.sessionId, option, requested, options);
    if (!result.applied) {
      emitProgress(
        options.onProgress,
        `Reasoning effort ${requested} is ${result.reason}; leaving it unchanged.`,
        "starting"
      );
      return null;
    }
    emitProgress(options.onProgress, `Reasoning effort set to ${result.value}.`, "starting");
    return result.value;
  } catch (error) {
    if (isOwnerGuardError(error)) throw error;
    emitProgress(
      options.onProgress,
      `Could not set reasoning effort ${requested}: ${error?.message ?? error}`,
      "starting"
    );
    return null;
  }
}

/**
 * 再開したセッションへモデルと推論レベルを反映する。
 *
 * `session/load` の応答は `session/new` と違ってモデル一覧を含まない
 * （ACP v1 の LoadSessionResponse は modes と configOptions だけ）。
 * 現在値と比べられないので、要求された値をそのまま当てにいく。
 *
 * ここでの失敗は再開そのものを壊すべきではない。設定が当たらなくても
 * 元のセッションの値が残るだけで、続きを話すという目的は果たせる。
 */
async function applyResumedSessionSettings(client, response, options) {
  try {
    await applyRequestedModel(client, response, options);
  } catch (error) {
    if (isOwnerGuardError(error)) throw error;
    emitProgress(
      options.onProgress,
      `Could not set model ${options.model} on the resumed session: ${error?.message ?? error}`,
      "starting"
    );
  }

  await applyRequestedEffort(client, response, options);
}

/**
 * セッションを開始し、必要ならモデルと推論レベルを差し替える。
 */
async function startSession(client, cwd, options = {}) {
  const request = () => client.request("session/new", {
    cwd,
    mcpServers: options.mcpServers ?? []
  });
  const response = await (options.guardOwnerEffect ? options.guardOwnerEffect(request) : request());

  // session/new が返す currentModelId は差し替え前の値なので、実効モデルを別に持つ。
  const effectiveModel = await applyRequestedModel(client, response, options);
  const effectiveEffort = await applyRequestedEffort(client, response, options);

  return { ...response, effectiveModel, effectiveEffort };
}

/**
 * プロンプトを 1 ターン実行し、流れてきた更新を集約して返す。
 */
async function runPrompt(client, sessionId, promptText, options = {}) {
  const collector = createTurnCollector(sessionId, { onProgress: options.onProgress });
  client.setNotificationHandler(collector.handle);

  let stopReason = null;
  let error = null;
  let promptAttempted = false;
  let promptRequestId = null;
  let promptRequests = 0;
  let enqueueOpen = true;
  try {
    const params = {
      sessionId,
      prompt: [{ type: "text", text: promptText }],
      ...(client.transport === "broker" ? { executionId: options.executionId } : {})
    };
    const enqueue = () => {
      if (!enqueueOpen) {
        const tracker = brokerRequests.get(client);
        // 封鎖後は request に到達せず、元の未送信証拠を損なわない。
        if (tracker && !tracker.sealed) tracker.lateEnqueue = true;
        const rejected = Promise.reject(new Error("The prompt enqueue operation is no longer active."));
        void rejected.catch(() => {});
        return rejected;
      }
      promptAttempted = true;
      promptRequests += 1;
      promptRequestId = client.nextId;
      return client.request("session/prompt", params);
    };
    // lock内では同期送信だけを行い、応答待ちはlock解放後に行う。
    const execution = { sessionId, transport: client.transport,
      brokerGeneration: client.transport === "broker" ? client.initializeResult?._meta?.grokBrokerGeneration ?? null : null };
    const pending = options.enqueuePrompt ? options.enqueuePrompt(enqueue, execution) : enqueue();
    const response = await pending;
    const evidence = getAcpPromptSuccessEvidence(response, client);
    if (promptRequests !== 1 || !evidence || evidence.method !== "session/prompt" || evidence.requestId !== promptRequestId) {
      throw Object.assign(new Error("The prompt response could not be verified against the issued request."), { turnStopUnconfirmed: promptAttempted });
    }
    stopReason = evidence.stopReason;
    if (typeof stopReason !== "string" || !["end_turn", "cancelled", "refusal", "max_tokens", "max_turn_requests"].includes(stopReason)) {
      throw Object.assign(new Error("The prompt response did not contain a recognized terminal reason."), { turnStopUnconfirmed: true });
    }
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error("The prompt failed with a non-Error value.", { cause: caught });
  } finally {
    enqueueOpen = false;
    client.setNotificationHandler(null);
  }

  collector.state.stopReason = stopReason;
  collector.finalize();
  // RPC error の公開 data は enqueue 側で書き換え可能なので、実際に送信した
  // request と ACP 受信時の固定証拠が一致する場合だけ turn の停止を認める。
  const evidence = error && promptAttempted ? getAcpPromptFailureEvidence(error, client) : null;
  const verifiedTerminal = promptRequests === 1 && evidence && evidence.requestId === promptRequestId &&
    evidence.method === "session/prompt" && (evidence.terminal === "confirmed" || evidence.terminal === "not-sent");
  const turnStopUnconfirmed = Boolean(promptRequests > 1 || (error &&
    ((!promptAttempted && client.transport === "direct") || (promptAttempted && !verifiedTerminal))));
  return { ...collector.state, error, turnStopUnconfirmed };
}

function buildResultStatus(turnState) {
  if (turnState.error) {
    return "failed";
  }
  switch (turnState.stopReason) {
    case "end_turn":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "refusal":
      return "refused";
    case "max_tokens":
    case "max_turn_requests":
      return "truncated";
    default:
      return "unknown";
  }
}

/** `grok` 実行ファイルの場所。GROK_BIN で上書きできる。 */
function resolveGrokBin(env = process.env) {
  if (env.GROK_BIN) {
    return env.GROK_BIN;
  }
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const bundled = path.join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  return "grok";
}

export function getGrokAvailability(cwd, env = process.env) {
  const bin = resolveGrokBin(env);
  // Windows では cmd.exe 経由で起動する。`process.env.SHELL`（Git Bash）だと
  // パスのバックスラッシュがエスケープとして食われ、`.cmd` ラッパーも起動できない。
  const spawnOptions = { cwd, env, shell: process.platform === "win32" };
  const command = quoteIfNeeded(bin);

  const versionStatus = binaryAvailable(command, ["--version"], spawnOptions);
  if (!versionStatus?.available) {
    return { available: false, bin, reason: "not-installed", detail: versionStatus?.detail ?? null };
  }

  // `agent stdio` が無い古い版を弾く。--help はサブコマンドが実在するときだけ成功する。
  const agentStatus = binaryAvailable(command, ["agent", "stdio", "--help"], spawnOptions);
  if (!agentStatus?.available) {
    return { available: false, bin, reason: "missing-agent-stdio", detail: agentStatus?.detail ?? null };
  }

  return {
    available: true,
    bin,
    version: versionStatus.detail ?? null
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const storedSession = env[BROKER_ENDPOINT_ENV] ? null : loadBrokerSession(cwd);
  const endpoint = env[BROKER_ENDPOINT_ENV] ?? storedSession?.endpoint ?? null;
  let brokerActive = Boolean(endpoint);
  if (storedSession?.pid) {
    try {
      process.kill(storedSession.pid, 0);
    } catch {
      brokerActive = false;
    }
  }
  return {
    brokerEndpoint: endpoint,
    brokerActive
  };
}

/**
 * 認証状態を調べる。
 *
 * Grok は XAI_API_KEY があればそれを優先し、無ければ `grok login` で保存した
 * ブラウザ資格情報を使う。ACP の initialize は未認証でも成功し、
 * `session/new` で初めて "Authentication required" になるため、
 * セッションを 1 本張ってみるところまでを確認手段にしている。
 */
export async function getGrokAuthStatus(cwd, options = {}) {
  const env = options.env ?? process.env;
  const availability = getGrokAvailability(cwd, env);
  if (!availability.available) {
    return { authenticated: false, reason: "grok-missing", availability };
  }

  const usingApiKey = Boolean(env.XAI_API_KEY);

  try {
    return await withDirectGrok(
      cwd,
      async (client) => {
        const methods = client.initializeResult?.authMethods ?? [];
        try {
          const session = await client.request("session/new", { cwd, mcpServers: [] });
          return {
            authenticated: true,
            method: usingApiKey ? "api-key" : "browser-login",
            currentModelId: session.models?.currentModelId ?? null,
            availableModels: session.models?.availableModels?.map((model) => model.modelId) ?? [],
            agentVersion: client.initializeResult?._meta?.agentVersion ?? null,
            availability
          };
        } catch (error) {
          // session/new の失敗がすべて認証拒否とは限らない。
          const authenticationRequired = error?.rpcResponseReceived === true && /\bauthentication required\b/i.test(error.message ?? "");
          return {
            authenticated: false,
            reason: authenticationRequired ? "not-authenticated" : "check-failed",
            detail: error?.message ?? String(error),
            authMethods: methods.map((method) => method.id),
            availability
          };
        }
      },
      { grokBin: availability.bin, env }
    );
  } catch (error) {
    return { authenticated: false, reason: "connect-failed", detail: error?.message ?? String(error), availability };
  }
}

/**
 * 実行IDとbroker世代で進行中turnへ割り込む。旧brokerにsession単位cancelは送らない。
 * 失敗は結果で返し、呼び出し元がworker停止と状態保存へ進めるようにする。
 */
export async function interruptGrokTurn(cwd, { sessionId, executionId, transport, brokerGeneration, env = process.env }) {
  if (!sessionId) {
    return {
      attempted: false,
      interrupted: false,
      detail: "no Grok session was recorded for this job yet",
      sessionId: null
    };
  }

  if (!executionId) {
    return { attempted: false, interrupted: false, detail: "no execution identity was recorded; stopping the tracked worker instead", sessionId };
  }
  if (transport !== "broker" || typeof brokerGeneration !== "string" || !brokerGeneration) {
    return { attempted: false, interrupted: false, stopConfirmed: false, executionState: "unknown",
      detail: "no recorded broker generation; Grok turn stop cannot be proven", sessionId };
  }
  let client;
  try {
    // cancelにはversion/help probeも新規agent起動も不要。
    const deadline = Date.now() + 600;
    client = await GrokAcpClient.connect(cwd, { reuseExistingBroker: true, brokerOnly: true, cancellationOnly: true,
      cancellationGeneration: brokerGeneration, cancellationSessionId: sessionId, cancellationExecutionId: executionId,
      brokerDeadlineMs: deadline, env });
    if (client.transport !== "broker" || client.initializeResult?._meta?.grokExecutionLedger !== true ||
        client.initializeResult?._meta?.grokBrokerGeneration !== brokerGeneration) {
      return { attempted: false, interrupted: false, reservationAccepted: false, detail: "broker does not support execution-scoped cancellation; stopping the tracked worker instead", sessionId };
    }
    const result = await client.request("broker/cancelTurn", { sessionId, executionId, generation: brokerGeneration },
      { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    const notificationSent = result?.notificationSent === true;
    const reservationAccepted = result?.reservationAccepted === true;
    const executionState = result?.generation === brokerGeneration ? result?.executionState : "unknown";
    const stopConfirmed = executionState === "terminal" || executionState === "never-accepted";
    return { attempted: true, interrupted: stopConfirmed, stopConfirmed, executionState, notificationSent, reservationAccepted,
      detail: stopConfirmed ? "broker confirmed execution is no longer running" : "Grok turn stop is unconfirmed", sessionId };
  } catch (error) {
    return { attempted: true, interrupted: false, reservationAccepted: false, detail: error?.message ?? String(error), sessionId };
  } finally {
    await client?.close().catch(() => {});
  }
}

function grokMissingMessage(availability) {
  if (availability?.reason === "missing-agent-stdio") {
    return "This Grok Build version does not expose `grok agent stdio`. Update it with `grok update`, then rerun `/grok:setup`.";
  }
  return "Grok Build is not installed. Install it with `irm https://x.ai/cli/install.ps1 | iex` (Windows) or `curl -fsSL https://x.ai/cli/install.sh | bash`, then rerun `/grok:setup`.";
}

/**
 * 読み取り専用のコードレビューを実行する。
 *
 * Grok の `review/start` に相当する専用 API が Grok には無いため、
 * レビュー指示と（あれば）JSON Schema をプロンプトへ載せて実行し、
 * 書き込み系ツールは権限応答側で拒否して読み取り専用を担保する。
 */
export async function runGrokReview(cwd, options = {}) {
  const env = options.env ?? process.env;
  const executionId = options.executionId ?? randomUUID();
  const availability = getGrokAvailability(cwd, env);
  if (!availability.available) {
    throw new Error(grokMissingMessage(availability));
  }

  const model = options.model ?? env.GROK_PLUGIN_MODEL ?? DEFAULT_REVIEW_MODEL;

  return withGrok(
    cwd,
    async (client) => {
      emitProgress(options.onProgress, "Starting Grok review session.", "starting");
      const session = await startSession(client, cwd, {
        model,
        onProgress: options.onProgress,
        guardOwnerEffect: options.enqueuePrompt?.guardOwnerEffect,
        // レビュー中に外部 MCP を呼ばせない。Grok は既定でユーザーの
        // グローバル MCP 設定を拾ってしまい、余計なトークンを使うため。
        mcpServers: []
      });
      const sessionId = session.sessionId;
      emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { sessionId });

      // JSON 再出力で初回の拒否記録を消さず、呼び出し側の完了判定へ渡す。
      /** @type {string[]} */
      const permissionDenials = [];
      client.setWriteDeniedHandler((reason) => permissionDenials.push(reason));
      client.setPermissionHandler(createReviewPermissionHandler(cwd, options.onProgress, (reason) => {
        permissionDenials.push(reason);
      }));

      const promptText = buildReviewPrompt(options);
      const promptOptions = { onProgress: options.onProgress, executionId, enqueuePrompt: options.enqueuePrompt };
      let turnState = await runPrompt(client, sessionId, promptText, promptOptions);
      if (client.transport === "broker" && options.enqueuePrompt && !turnState.turnStopUnconfirmed &&
          turnState.error?.turnStopUnconfirmed !== true && isBrokerUnsentPrompt(turnState.error, client)) throw turnState.error;
      let repaired = false;

      // 正常に終了した最終応答だけを JSON として訂正する。拒否やキャンセル後の
      // 途中経過を再出力させると、未完了の調査が終わったように見えてしまう。
      if (options.outputSchema && !turnState.error && turnState.stopReason === "end_turn" && turnState.agentMessage) {
        const attempt = parseStructuredOutput(turnState.agentMessage);
        if (attempt.parseError) {
          emitProgress(options.onProgress, "Grok returned malformed JSON; asking it to re-emit.", "running", {
            sessionId
          });
          const retry = await runPrompt(
            client,
            sessionId,
            buildJsonRepairPrompt(attempt.parseError, options.outputSchema),
            promptOptions
          );
          // 訂正に失敗しても最新の本文・終了理由・エラーを返す。
          // 監査自体の思考サマリは初回のものを残し、JSON訂正の成否とは分ける。
          turnState = { ...retry, reasoning: turnState.reasoning };
          repaired = !retry.error && retry.stopReason === "end_turn" && Boolean(retry.agentMessage) &&
            !parseStructuredOutput(retry.agentMessage).parseError;
        }
      }

      const reviewStatus = buildResultStatus(turnState);
      return {
        jsonRepaired: repaired,
        permissionDenials,
        status: turnState.stopReason !== "end_turn" && reviewStatus === "completed" ? "unknown" : reviewStatus,
        sessionId,
        model: session.effectiveModel ?? model,
        reviewText: turnState.agentMessage,
        reasoningSummary: turnState.reasoning,
        stopReason: turnState.stopReason,
        usage: turnState.usage,
        error: turnState.error,
        turnStopUnconfirmed: turnState.turnStopUnconfirmed,
        stderr: cleanGrokStderr(client.stderr)
      };
    },
    { grokBin: availability.bin, env, readOnly: true, requireScopedCancellation: true,
      prepareConnection: options.enqueuePrompt?.prepareConnection,
      connectionEstablished: options.enqueuePrompt?.connectionEstablished,
      directAgentStarting: options.enqueuePrompt?.directAgentStarting,
      guardOwnerEffect: options.enqueuePrompt?.guardOwnerEffect,
      allowCapacityFallback: Boolean(options.enqueuePrompt) }
  );
}

/**
 * レビュー用のプロンプトを組み立てる。
 *
 * Grok は `review/start` の target でレビュー対象（diff / commit / ブランチ）を
 * 指定できたが、Grok にはその概念が無いので、対象の説明と収集済みの diff を
 * 文章として渡す。
 */
function buildReviewPrompt(options = {}) {
  const parts = [];
  parts.push(options.instructions?.trim() || "Review the code in this repository for defects.");

  if (options.targetDescription) {
    parts.push(`\n## Review target\n${options.targetDescription}`);
  }
  if (options.diff) {
    parts.push(`\n## Diff under review\n\n\`\`\`diff\n${options.diff}\n\`\`\``);
  }

  parts.push(
    "\n## Ground rules\n" +
      "- Read whatever files you need from the working tree to judge the change in context.\n" +
      "- Prefer your built-in file-reading tools (read_file, list_dir, and grep). Simple read-only repository commands such as rg are also available. Do not modify files or run commands with side effects.\n" +
      "- Every Git command must start with: git " + READ_ONLY_GIT_GLOBAL_ARGS.join(" ") + ". Then use a supported read-only subcommand. For diff, log, show and whatchanged, put --no-ext-diff and --no-textconv immediately after the subcommand as its first two arguments (either order), before any other option, revision or -- path separator. Status and blame are denied. Diff must put --cached or --staged immediately after those two guards, or use an exact 40-digit SHA-1 OID..OID or 64-digit SHA-256 OID..OID there. For fixed ranges, only supported display flags may follow; put paths after -- and do not add revisions or use HEAD/branch names. Use the fixed comparison from collection guidance. Grep requires --cached first; --no-index and modified ls-files checks are denied. These flags suppress textconv/external diff; they do not establish an OS sandbox. Example: git " + READ_ONLY_GIT_GLOBAL_ARGS.join(" ") + " diff --no-ext-diff --no-textconv --cached --stat. Use complete option names supported by that specific subcommand and separate short options; options from another subcommand, unknown options, custom pretty formats and --submodule=diff are denied. For example, grep --cached --text is supported, but cat-file --text is denied; use cat-file -p to read an object. Use file tools if a command is unsupported.\n" +
      "- For recent commit history, use --since=YYYY-MM-DD with git log and --oneline, not a custom percent-based format. Example: git " + READ_ONLY_GIT_GLOBAL_ARGS.join(" ") + " log --no-ext-diff --no-textconv --since=2026-09-28 --oneline. Replace the example date with the requested starting date.\n" +
      "- Avoid PowerShell script blocks and variables, command substitution, backticks, redirection, and executable paths: the read-only shell policy rejects these even in a read-only command.\n" +
      "- Perform all review perspectives yourself in this session. Subagent delegation is unavailable in this read-only runtime; do not call spawn_subagent or other delegation tools, even if repository instructions recommend parallel reviewers.\n" +
      "- If an operation is denied, continue the inspection directly with supported read-only tools and report the limitation. Never claim approval for an incomplete inspection; use the incomplete verdict.\n" +
      "- Report only defects you can point to a specific file and line for."
  );

  if (options.outputSchema) {
    parts.push(buildStructuredOutputInstruction(options.outputSchema));
  }

  return parts.join("\n");
}

/**
 * 構造化出力の指示文。
 *
 * ACP の `session/prompt` にはスキーマでモデルを制約する口が無い
 * （CLI の `--json-schema` は制約できるが、その代わり初回応答で打ち切られて
 * ファイルを読ませられないため、レビューには使えない）。
 * したがってプロンプトで守らせるしかなく、実際に踏んだ失敗
 * ―― 前置きの散文が混ざる、文字列内の `"` が未エスケープ ―― を名指しで禁じる。
 */
function buildStructuredOutputInstruction(schema) {
  return (
    "\n## Required output\n" +
    "Your final message must be a single JSON object and nothing else.\n" +
    "- Do not write any sentence before or after the JSON, not even a short lead-in.\n" +
    "- Do not wrap the JSON in a markdown code fence.\n" +
    '- Escape every `"` that appears inside a string value as `\\"`, and escape backslashes as `\\\\`.\n' +
    "- When you need to quote code that contains quotes, prefer single quotes or describe it in words.\n" +
    "It must validate against this JSON Schema:\n\n" +
    `${JSON.stringify(schema, null, 2)}`
  );
}

/**
 * 直前の返答が JSON として壊れていたときに、同じセッションで訂正させる指示。
 */
function buildJsonRepairPrompt(parseError, schema) {
  return (
    "Your previous message could not be parsed as JSON.\n" +
    `Parser error: ${parseError}\n\n` +
    "Send the same review again as one valid JSON object and nothing else.\n" +
    "Do not re-read any files and do not change your findings — only fix the JSON itself.\n" +
    'Pay particular attention to escaping `"` and `\\` inside string values.\n\n' +
    `It must validate against this JSON Schema:\n\n${JSON.stringify(schema, null, 2)}`
  );
}

/**
 * 任意のタスクを Grok に委任して 1 ターン実行する。
 * 書き込みを許すかどうかは options.readOnly で切り替える。
 */
export async function runGrokTurn(cwd, options = {}) {
  const env = options.env ?? process.env;
  const executionId = options.executionId ?? randomUUID();
  const availability = getGrokAvailability(cwd, env);
  if (!availability.available) {
    throw new Error(grokMissingMessage(availability));
  }

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Grok run.");
  }

  const model = options.model ?? env.GROK_PLUGIN_MODEL ?? DEFAULT_REVIEW_MODEL;

  return withGrok(
    cwd,
    async (client) => {
      let sessionId;

      // session/load はエージェントが loadSession capability を宣言した
      // ときだけ使える。未対応の相手には投げずに新規セッションへ落とす。
      const canLoadSession = client.initializeResult?.agentCapabilities?.loadSession === true;

      if (options.resumeSessionId && !canLoadSession) {
        emitProgress(
          options.onProgress,
          "This Grok build cannot resume sessions; starting a fresh one instead.",
          "starting"
        );
      }

      if (options.resumeSessionId && canLoadSession) {
        emitProgress(options.onProgress, `Resuming session ${options.resumeSessionId}.`, "starting");
        const request = () => client.request("session/load", {
          sessionId: options.resumeSessionId,
          cwd,
          mcpServers: options.mcpServers ?? []
        });
        const loaded = await (options.enqueuePrompt?.guardOwnerEffect ? options.enqueuePrompt.guardOwnerEffect(request) : request());
        sessionId = options.resumeSessionId;

        // 再開だと startSession を通らないため、以前は --model と --effort が
        // 黙って無視されていた。読み込んだセッションにも同じ設定を当てる。
        await applyResumedSessionSettings(
          client,
          { ...loaded, sessionId },
          { model, effort: options.effort, onProgress: options.onProgress, guardOwnerEffect: options.enqueuePrompt?.guardOwnerEffect }
        );
      } else {
        emitProgress(options.onProgress, "Starting Grok task session.", "starting");
        const session = await startSession(client, cwd, {
          model,
          effort: options.effort,
          onProgress: options.onProgress,
          guardOwnerEffect: options.enqueuePrompt?.guardOwnerEffect,
          mcpServers: options.mcpServers ?? []
        });
        sessionId = session.sessionId;
      }

      emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { sessionId });

      /** @type {string[]} */
      const permissionDenials = [];
      client.setWriteDeniedHandler((reason) => permissionDenials.push(reason));
      client.setPermissionHandler(
        options.readOnly
          ? createReviewPermissionHandler(cwd, options.onProgress, (reason) => permissionDenials.push(reason))
          : createAllowAllPermissionResponder()
      );

      const promptText = options.outputSchema
        ? `${prompt}\n\n## Required output\nReply with a single JSON object and nothing else. It must validate against this JSON Schema:\n\n${JSON.stringify(options.outputSchema, null, 2)}`
        : prompt;

      const turnState = await runPrompt(client, sessionId, promptText, { onProgress: options.onProgress, executionId, enqueuePrompt: options.enqueuePrompt });
      if (client.transport === "broker" && options.enqueuePrompt && !turnState.turnStopUnconfirmed &&
          turnState.error?.turnStopUnconfirmed !== true && isBrokerUnsentPrompt(turnState.error, client)) throw turnState.error;

      emitLogEvent(options.onProgress, {
        phase: "completed",
        logTitle: turnState.title ?? null,
        logBody: null
      });

      return {
        status: buildResultStatus(turnState),
        sessionId,
        model,
        finalMessage: turnState.agentMessage,
        permissionDenials,
        reasoningSummary: turnState.reasoning,
        stopReason: turnState.stopReason,
        usage: turnState.usage,
        error: turnState.error,
        turnStopUnconfirmed: turnState.turnStopUnconfirmed,
        stderr: cleanGrokStderr(client.stderr),
        touchedFiles: [...turnState.touchedFiles],
        commandExecutions: turnState.commandExecutions
      };
    },
    { grokBin: availability.bin, env, readOnly: Boolean(options.readOnly), resumeSessionId: options.resumeSessionId,
      requireScopedCancellation: true, prepareConnection: options.enqueuePrompt?.prepareConnection,
      connectionEstablished: options.enqueuePrompt?.connectionEstablished,
      directAgentStarting: options.enqueuePrompt?.directAgentStarting,
      guardOwnerEffect: options.enqueuePrompt?.guardOwnerEffect,
      allowCapacityFallback: Boolean(options.enqueuePrompt) }
  );
}

/**
 * 直近の委任タスク用セッションを探す。`/grok:rescue` の再開先に使う。
 */
export async function findLatestTaskSession(cwd, options = {}) {
  const excluded = new Set(options.excludeSessionIds ?? []);
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(grokMissingMessage(availability));
  }

  return withGrok(
    cwd,
    async (client) => {
      if (!client.initializeResult?.agentCapabilities?.sessionCapabilities?.list) {
        return null;
      }
      const response = await client.request("session/list", { cwd, limit: 20 });
      const sessions = response?.sessions ?? [];
      // ACPのsessionIdを正本とし、従来のid形式も呼び出し元のidへそろえる。
      const normalized = sessions.flatMap((session) => {
        const id = [session?.sessionId, session?.id].find((value) => typeof value === "string" && value.trim());
        return id ? [{ ...session, id }] : [];
      });
      return (
        normalized.find((session) => typeof session.title === "string" && session.title.startsWith(TASK_SESSION_PREFIX) &&
          !excluded.has(session.id)) ??
        null
      );
    },
    { grokBin: availability.bin, reuseExistingBroker: true }
  );
}

export function buildPersistentTaskSessionName(prompt) {
  return buildTaskSessionName(prompt);
}

/**
 * 構造化出力を取り出す。
 *
 * Grok は outputSchema でモデルを制約できたが、ACP の session/prompt には
 * その口が無くプロンプトでの依頼になるため、コードフェンス付きで返ってくる
 * ケースを剥がしてから JSON.parse する。
 */
export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: String(fallback.failureMessage ?? "").trim() || "Grok did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const candidate = stripJsonFence(rawOutput);

  try {
    return {
      parsed: JSON.parse(candidate),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

/**
 * ```json ... ``` のフェンスや前後の散文を剥がして JSON 本体だけにする。
 * フェンスが無く JSON が単体で返っている場合はそのまま返す。
 */
function stripJsonFence(text) {
  const trimmed = String(text).trim();

  const opening = trimmed.indexOf("```");
  if (opening !== -1) {
    const contentStart = trimmed.indexOf("\n", opening + 3);
    if (contentStart !== -1) {
      const closing = trimmed.indexOf("\n```", contentStart + 1);
      if (closing !== -1) {
        return trimmed.slice(contentStart + 1, closing).trim();
      }
    }
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  // 前後に説明文が付いた場合に備え、最初の { から対応する最後の } までを拾う。
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_SESSION_PREFIX, resolveGrokBin, stripJsonFence };
