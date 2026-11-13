/**
 * 読み取り専用レビュー・タスクで Grok が要求するシェルコマンドの許可判定。
 *
 * セキュリティ境界の判定だけを実行本体（grok.mts）から分け、差分レビューの範囲を狭める。
 * 依存は node:fs / node:path と git.mjs の READ_ONLY_GIT_GLOBAL_ARGS だけに保つ。
 * 公開名 classifyShellCommand は従来どおり grok.mjs からも再 export される。
 */
import fs from "node:fs";
import path from "node:path";
import { READ_ONLY_GIT_GLOBAL_ARGS } from "./git.mjs";
/**
 * 読み取り専用として許可するコマンド。
 * git はサブコマンドまで見て、履歴や作業ツリーを変えないものだけ通す。
 *
 * 汎用インタプリタ（node / python など）は載せない。
 * `-e` や `-c` の引数一つで任意の書き込みができてしまい、
 * コマンド名だけでは読み取り専用を保証できないため。
 * ack / ag の pager と tree の出力ファイル指定も同じ理由で載せない。
 * 情報を取りたいときは Grok 自身のファイル読み取りツールを使わせる。
 */
export const READ_ONLY_COMMANDS = new Set([
    "cat", "head", "tail", "type",
    "ls", "dir", "pwd", "find", "stat", "wc",
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
    ["diff", new Set(SAFE_GIT_DIFF_OPTIONS)],
    ["log", SAFE_GIT_HISTORY_OPTIONS], ["show", SAFE_GIT_HISTORY_OPTIONS],
    ["whatchanged", SAFE_GIT_HISTORY_OPTIONS],
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
            "--cached", "--no-recurse-submodules", "--no-textconv", "--no-color", "--full-name",
            "--count", "--quiet", "--ignore-case", "--fixed-strings", "--extended-regexp", "--basic-regexp",
            "--perl-regexp", "--line-number", "--files-with-matches", "--files-without-match",
            "--invert-match", "--word-regexp", "--text"
        ])]
]);
// status と blame、diff / grep の --no-index は classifyShellCommand が先に明示拒否するため、
// ここ（とサブコマンド別の長名許可表）には載せない。到達しない許可を残すと境界の読解を誤らせる。
function isSafeGitOption(token, sub) {
    if (!token.startsWith("-"))
        return true;
    // 単独の短名と検証済み数値形式だけを認め、短名の組合せは認めない。
    if (/^-(?:[0-9]+|[pnzburwtlvaHIEFqsmSLneAfBt]|[UMC][0-9]*|n[0-9]+)$/.test(token))
        return true;
    if (SAFE_GIT_LONG_OPTIONS_BY_SUBCOMMAND.get(sub)?.has(token))
        return true;
    const diff = ["diff", "log", "show", "whatchanged"].includes(sub);
    const history = ["log", "show", "whatchanged", "shortlog"].includes(sub);
    if (diff && /^--unified=[0-9]+$/.test(token))
        return true;
    if (sub === "log" && /^--since=[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(token))
        return true;
    if (history && /^--(?:max-count|skip)=[0-9]+$/.test(token))
        return true;
    if (["diff", "log", "show", "whatchanged", "ls-tree", "describe"].includes(sub) && /^--abbrev=[0-9]+$/.test(token))
        return true;
    if (["diff", "log", "show", "whatchanged"].includes(sub) && /^--submodule=(?:short|log)$/.test(token))
        return true;
    if ((diff || sub === "grep") && /^--color=(?:never|auto)$/.test(token))
        return true;
    if (["log", "show", "whatchanged", "shortlog"].includes(sub) && /^--(?:pretty|format)=(?:oneline|short|medium|full|fuller|reference|raw)$/.test(token))
        return true;
    return ["log", "show", "whatchanged"].includes(sub) && /^--diff-merges=(?:off|none|first-parent|separate|combined|dense-combined)$/.test(token);
}
function isSafeFixedObjectDiff(args) {
    if (!/^(?:[a-f0-9]{40}\.\.[a-f0-9]{40}|[a-f0-9]{64}\.\.[a-f0-9]{64})$/.test(args[2] ?? ""))
        return false;
    const separator = args.indexOf("--", 3);
    const options = separator < 0 ? args.slice(3) : args.slice(3, separator);
    const simpleOptions = new Set([
        "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--raw",
        "--patch", "--no-patch", "--binary", "--check", "--summary", "--compact-summary",
        "--full-index", "--no-renames", "--ignore-all-space", "--ignore-space-change",
        "--ignore-space-at-eol", "--ignore-cr-at-eol", "--ignore-blank-lines", "--no-color",
        "--exit-code", "--quiet", "--text", "--submodule=short", "-p", "-u", "-w", "-b", "-z"
    ]);
    if (options.some((arg) => !simpleOptions.has(arg) && !/^--(?:unified|abbrev)=[0-9]+$/.test(arg)))
        return false;
    // 追加 revision や暗黙の path を認めず、path は -- の後だけで明示する。
    if (separator >= 0 && (separator === args.length - 1 ||
        args.slice(separator + 1).some((arg) => !arg || arg.startsWith("-") || arg.includes(":"))))
        return false;
    return true;
}
/** ファイルへ書き出すリダイレクトと、その場編集を示す痕跡。 */
const WRITE_SIDE_EFFECT_PATTERN = /(^|\s)(>>?|\btee\b)(\s|$)|(^|\s)-i(\s|$)/;
/**
 * コマンド置換。`git log $(rm -rf .)` のように、許可コマンドの引数へ
 * 埋め込むだけで別のコマンドが先に走るため、中身を見ずに一律で拒否する。
 */
const COMMAND_SUBSTITUTION_PATTERN = /\$\(|\$\{|`/;
const UNICODE_QUOTE_PATTERN = /[‘-„]/;
/**
 * タブ以外の制御文字・書式文字。PowerShell は U+0085（NEL）等を空白として扱うが、
 * JS の `\s` は含まないため、tokenizer が 1 語とみなした引数を shell 側は 2 語に分け、
 * 語頭を見る検査（rg --pre、find -delete、git --output 等）を迂回できてしまう。
 */
// 改行（\r \n）は従来どおり UNSAFE_SHELL_SYNTAX_PATTERN が「shell control」として拒否する。
const UNSAFE_CONTROL_CHARACTER_PATTERN = /(?![\t\r\n])[\p{Cc}\p{Cf}]/u;
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
        // PowerShell は引数モードでも引用なしの `(...)` と `@(...)` / `@{...}` / `@name` を
        // 式として先に評価する。許可コマンドの引数に埋め込むだけで別コマンドが走るため、
        // 引用なしの括弧と先頭 `@` は拒否する。引用内の括弧（正規表現など）は 1 語の文字列なので許可する。
        if (match[3] !== undefined && (/[()]/.test(match[3]) || match[3].startsWith("@"))) {
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
            }
            catch (error) {
                if (error?.code !== "ENOENT")
                    return false;
                const parent = path.dirname(existing);
                if (parent === existing)
                    return false;
                existing = parent;
            }
        }
        return isWithinPath(realRoot, fs.realpathSync.native(existing));
    }
    catch {
        return false;
    }
}
/**
 * シェルコマンドが読み取り専用かどうかを判定する。
 *
 * `&&` `||` `;` `|` で区切った各セグメントの先頭コマンドを見て、すべてが
 * 許可リストに載っていて、かつファイルへの書き出しを含まない場合だけ許可する。
 * 判断できないものは拒否側に倒す。
 */
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
    // PowerShell は Unicode の引用符（‘ ’ ‚ ‛ “ ” „）も ASCII の引用符と同じ文字列境界に使う。
    // ASCII で開いてスマート引用符で閉じると、下の tokenizer が引用内とみなした括弧式が
    // PowerShell では引用外として評価されるため、これらの文字は位置を問わず拒否する。
    if (UNICODE_QUOTE_PATTERN.test(text)) {
        return { allowed: false, reason: "uses Unicode quotation marks that some shells treat as string delimiters" };
    }
    if (UNSAFE_CONTROL_CHARACTER_PATTERN.test(text)) {
        return { allowed: false, reason: "uses control or format characters that shells may split differently" };
    }
    if (UNSAFE_SHELL_SYNTAX_PATTERN.test(text)) {
        return { allowed: false, reason: "uses unsupported shell control or expansion syntax" };
    }
    const segments = text.split(/\|\||&&|[;|]/).map((segment) => segment.trim()).filter(Boolean);
    for (const segment of segments) {
        const tokens = tokenizeCommand(segment);
        if (!tokens) {
            return { allowed: false, reason: "uses unsupported shell quoting or unquoted expression syntax" };
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
        if (head === "rg" && tokens.slice(1).some((token) => /^--(?:pre(?:-glob)?|hostname-bin)(?:=|$)/.test(token))) {
            return { allowed: false, reason: "rg uses an external command" };
        }
        if (head === "find" && tokens.slice(1).some((token) => UNSAFE_FIND_ARGUMENTS.has(token))) {
            return { allowed: false, reason: `${head} is being used in a way that can write or run other commands` };
        }
    }
    return { allowed: true, reason: null };
}
