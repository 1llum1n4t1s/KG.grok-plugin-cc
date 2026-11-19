/**
 * Grok Imagine（画像生成）の判定と、セッションディレクトリからワークスペースへのコピー。
 *
 * 画像そのものは Grok Build の image_gen / image_edit がセッション配下へ書く。
 * companion はリポジトリの編集を許可せず、そのファイルだけを出力先へ複製する。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containWorkspacePath } from "./acp.mjs";
import { t } from "./i18n.mjs";
/** API 課金の案内に出す画像モデル。docs.x.ai の従量単価の起点。 */
export const IMAGINE_API_IMAGE_MODEL = "grok-imagine-image-2.0";
/** grok-imagine-image-2.0 の公開リスト価格（1K・low）。解像度と品質で上がる。 */
export const IMAGINE_API_IMAGE_PRICE = "$0.04/img";
/** xAI の画像 API が受け付ける aspect ratio。--aspect はこれ以外を起動前に拒否する。 */
export const IMAGINE_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "auto"];
/** セッション画像としてコピーする上限。これを超える報告は生成画像として扱わない。 */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif)$/i;
const PROSE_IMAGE_PATH = /(?:\\\\[?]\\|[A-Za-z]:\\|\/)[^\r\n"<>|]+?\.(?:png|jpe?g|webp|gif)(?!\w)/gi;
const VIDEO_VARIANT = /^(?:ImageToVideo|ReferenceToVideo|VideoGen)$/;
const VIDEO_TITLE = /^(?:image_to_video|video_gen|reference_to_video|image-to-video:|imagine-video:)/i;
/** Windows の拡張長プレフィックス `\\?\` を、実ファイルを開くパスから外す。 */
export function cleanExtendedPath(value) {
    return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}
function rawVariant(raw) {
    if (!raw || typeof raw !== "object")
        return "";
    const variant = raw.variant;
    return typeof variant === "string" ? variant : "";
}
/**
 * 画像生成・編集のツール要求か。許可は image_gen / image_edit と
 * variant ImageGen / ImageEdit だけ。表示名が imagine: で始まるだけでは許可しない。
 * 動画ツールは先に拒否する。完了通知は title が空になるため、呼び出し側は toolCallId を覚えておく。
 */
export function isImageGenerationTool(tool) {
    const title = typeof tool?.title === "string" ? tool.title.trim() : "";
    const variant = rawVariant(tool?.rawInput);
    if (VIDEO_VARIANT.test(variant) || VIDEO_TITLE.test(title))
        return false;
    if (variant === "ImageGen" || variant === "ImageEdit")
        return true;
    if (/^(?:image_gen|image_edit)$/i.test(title))
        return true;
    return false;
}
/**
 * 画像権限が無いアカウントの失敗文。SuperGrok と画像ツールの両方に触れる文だけを対象にする。
 * 利用枠切れ（HTTP 402）とは別で、課金エラーをこの理由にまとめない。
 */
export function isMissingImageEntitlement(text) {
    return /(?:image tools|image generation|\/imagine)\b[\s\S]{0,180}\bsuper\s*grok\b/i.test(text)
        || /\bsuper\s*grok\b[\s\S]{0,180}\b(?:image tools|image generation|\/imagine)\b/i.test(text);
}
/** 失敗したツール結果の本文。成功した応答や最終メッセージは資格不足の判定に使わない。 */
export function failedToolText(update) {
    if (!update || typeof update !== "object")
        return "";
    const record = update;
    if (record.status !== "failed")
        return "";
    const texts = [];
    collectTexts(record.content, texts, 0);
    collectTexts(record.rawOutput, texts, 0);
    return texts.join("\n");
}
function collectTexts(value, out, depth) {
    if (value == null || depth > 6)
        return;
    if (typeof value === "string") {
        out.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value)
            collectTexts(item, out, depth + 1);
        return;
    }
    if (typeof value === "object") {
        const record = value;
        if (typeof record.text === "string")
            out.push(record.text);
        if ("content" in record)
            collectTexts(record.content, out, depth + 1);
    }
}
function jsonImagePaths(value) {
    const found = [];
    const visit = (node) => {
        if (!node || typeof node !== "object")
            return;
        if (Array.isArray(node)) {
            for (const item of node)
                visit(item);
            return;
        }
        const record = node;
        if (typeof record.path === "string" && IMAGE_EXT.test(cleanExtendedPath(record.path)))
            found.push(cleanExtendedPath(record.path));
        for (const nested of Object.values(record)) {
            if (nested && typeof nested === "object")
                visit(nested);
        }
    };
    visit(value);
    return found;
}
/**
 * ツール結果の text から画像パスを取り出す。
 * Linux/macOS は JSON の path、Windows は `Image generated and saved to ...jpg.` の地の文。
 */
export function extractGeneratedImagePaths(update) {
    const texts = [];
    if (update && typeof update === "object") {
        const record = update;
        collectTexts(record.content, texts, 0);
        collectTexts(record.rawOutput, texts, 0);
    }
    const paths = [];
    for (const text of texts) {
        const trimmed = text.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                const parsed = jsonImagePaths(JSON.parse(trimmed));
                if (parsed.length) {
                    paths.push(...parsed);
                    continue;
                }
            }
            catch {
                // JSON でなければ地の文としてパスを探す。
            }
        }
        for (const match of trimmed.matchAll(PROSE_IMAGE_PATH))
            paths.push(cleanExtendedPath(match[0]));
    }
    return paths;
}
/** Grok が画像を書くセッションディレクトリ。HOME / USERPROFILE は呼び出し環境を使う。 */
export function grokSessionsRoot(env) {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    return path.resolve(home, ".grok", "sessions");
}
/**
 * 報告されたパスが、今回の ACP セッションの images ディレクトリにある通常ファイルか。
 * セッション ID の直下の images だけを対象にする。過去セッションやシンボリックリンクはコピーしない。
 * 公開されている配置は ~/.grok/sessions/<cwd>/<sessionId>/images/<file> である。
 */
export function isGrokSessionImage(filePath, env, sessionId) {
    if (!sessionId)
        return false;
    const cleaned = cleanExtendedPath(filePath);
    if (!path.isAbsolute(cleaned) || !IMAGE_EXT.test(cleaned))
        return false;
    let listed;
    try {
        listed = fs.lstatSync(cleaned);
    }
    catch {
        return false;
    }
    if (!listed.isFile() || listed.isSymbolicLink())
        return false;
    let realFile;
    let realRoot;
    try {
        realFile = fs.realpathSync(cleaned);
        realRoot = fs.realpathSync(grokSessionsRoot(env));
    }
    catch {
        return false;
    }
    const relative = path.relative(realRoot, realFile);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return false;
    const parts = relative.split(path.sep);
    const sid = parts.indexOf(sessionId);
    return sid >= 0 && parts[sid + 1] === "images" && parts.length > sid + 2;
}
/** 今回のセッション画像と、コピーを拒否する報告を分ける。同じパスは一度だけ扱う。 */
export function partitionSessionImages(reported, env, sessionId) {
    const accepted = [];
    const rejected = [];
    const seen = new Set();
    for (const item of reported) {
        const cleaned = cleanExtendedPath(item);
        if (!cleaned || seen.has(cleaned))
            continue;
        seen.add(cleaned);
        if (isGrokSessionImage(cleaned, env, sessionId))
            accepted.push(cleaned);
        else
            rejected.push(item);
    }
    return { accepted, rejected };
}
/** --aspect が公開リストに無ければ、Grok を起動せずに失敗させる。 */
export function assertImagineAspect(ratio) {
    if (!IMAGINE_ASPECT_RATIOS.includes(ratio)) {
        throw new Error(t("imagine.bad_aspect", { ratio, ratios: IMAGINE_ASPECT_RATIOS.join(", ") }));
    }
}
/**
 * 出力先をワークスペース内のディレクトリと、指定されたファイル名に分ける。
 * 画像拡張子が付いていなければディレクトリ、付いていればそのファイル名で保存する。
 */
export function resolveImagineOutput(cwd, requested) {
    const spec = requested?.trim() ? requested.trim() : "grok-imagine";
    const asFile = IMAGE_EXT.test(spec) && !spec.endsWith("/") && !spec.endsWith("\\");
    const directory = containWorkspacePath(cwd, asFile ? path.dirname(spec) : spec);
    const fileName = asFile ? path.basename(spec) : null;
    if (!directory || (fileName != null && !IMAGE_EXT.test(fileName)))
        throw new Error(t("imagine.output_escapes", { path: spec }));
    return { directory, fileName };
}
/** 存在する通常ファイルとシンボリックリンクを占有とみなす。切れたリンクは existsSync では見えない。 */
function pathOccupancy(target) {
    try {
        return fs.lstatSync(target).isSymbolicLink() ? "symlink" : "present";
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return "missing";
        throw error;
    }
}
function uniquePath(directory, fileName) {
    const ext = path.extname(fileName);
    const stem = path.basename(fileName, ext);
    let candidate = path.join(directory, fileName);
    for (let suffix = 2; pathOccupancy(candidate) !== "missing"; suffix += 1)
        candidate = path.join(directory, `${stem}-${suffix}${ext}`);
    return candidate;
}
/**
 * 出力先がシンボリックリンクなら、リンク先へ書き込まずに拒否する。
 * 元を先に読み、出力は読込みに成功してから作る。書込みに失敗したときは自分が作った出力を残さない。
 */
function writeNewFile(source, target) {
    const occupancy = pathOccupancy(target);
    if (occupancy === "symlink")
        throw new Error(t("imagine.output_escapes", { path: target }));
    if (occupancy === "present")
        throw new Error(t("imagine.output_exists", { path: target }));
    let bytes;
    try {
        bytes = fs.readFileSync(source);
    }
    catch (error) {
        throw new Error(t("imagine.copy_failed", { detail: error?.message ?? String(error) }), { cause: error });
    }
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
    let fd;
    try {
        fd = fs.openSync(target, flags);
    }
    catch (error) {
        if (error?.code === "ELOOP" || error?.code === "EEXIST")
            throw new Error(t("imagine.output_escapes", { path: target }), { cause: error });
        throw new Error(t("imagine.copy_failed", { detail: error?.message ?? String(error) }), { cause: error });
    }
    try {
        fs.writeSync(fd, bytes);
    }
    catch (error) {
        try {
            fs.closeSync(fd);
        }
        catch { /* 閉じ直しの失敗より元の書込みエラーを優先する。 */ }
        try {
            fs.unlinkSync(target);
        }
        catch { /* 自分が作った不完全な出力の片付けに失敗しても元のエラーを返す。 */ }
        throw new Error(t("imagine.copy_failed", { detail: error?.message ?? String(error) }), { cause: error });
    }
    fs.closeSync(fd);
}
/**
 * 受け入れたセッション画像をワークスペースの出力先へ複製する。
 * 明示したファイル名が既にある場合は上書きしない。ディレクトリ指定の衝突は連番にする。
 * 1 枚も保存していない間の失敗は例外にする。1 枚以上保存した後の失敗はそこで打ち切り、
 * 保存済みを返して失敗の理由を failure に載せる（有効な画像が 1 枚でもあれば成功扱い）。
 */
export function copySessionImages(accepted, destination, cwd) {
    const directory = containWorkspacePath(cwd, destination.directory);
    if (!directory)
        throw new Error(t("imagine.output_escapes", { path: destination.directory }));
    try {
        fs.mkdirSync(directory, { recursive: true });
    }
    catch (error) {
        throw new Error(t("imagine.output_unusable", { path: directory }), { cause: error });
    }
    // 作成後も containWorkspacePath で確かめる。native realpath の \\?\ をここで直接比べない。
    if (!containWorkspacePath(cwd, directory))
        throw new Error(t("imagine.output_escapes", { path: destination.directory }));
    const listed = fs.lstatSync(directory);
    if (!listed.isDirectory() || listed.isSymbolicLink())
        throw new Error(t("imagine.output_unusable", { path: directory }));
    const saved = [];
    for (let index = 0; index < accepted.length; index += 1) {
        try {
            const source = fs.realpathSync(accepted[index]);
            const base = destination.fileName ?? path.basename(source);
            const explicit = Boolean(destination.fileName) && index === 0;
            const target = explicit ? path.join(directory, destination.fileName) : uniquePath(directory, base);
            if (explicit && path.extname(destination.fileName).toLowerCase() !== path.extname(source).toLowerCase()) {
                throw new Error(t("imagine.extension_mismatch", { source: path.extname(source) || "(none)", output: path.extname(destination.fileName) || "(none)" }));
            }
            if (explicit && pathOccupancy(target) === "present")
                throw new Error(t("imagine.output_exists", { path: target }));
            const size = fs.statSync(source).size;
            if (size <= 0 || size > MAX_IMAGE_BYTES)
                throw new Error(t("imagine.copy_failed", { detail: `${source} (${size} bytes)` }));
            writeNewFile(source, target);
            saved.push({ source, saved: target });
        }
        catch (error) {
            if (!saved.length)
                throw error;
            return { saved, failure: error?.message ?? String(error) };
        }
    }
    return { saved, failure: null };
}
/**
 * XAI_API_KEY があるときは API 従量課金として明示の同意が要る。
 * 無いときはブラウザログイン（サブスクリプション）の共有週間枠として進める。
 */
export function imagineBilling(env, allowApiBilling) {
    const values = { model: IMAGINE_API_IMAGE_MODEL, price: IMAGINE_API_IMAGE_PRICE };
    if (env.XAI_API_KEY) {
        return allowApiBilling
            ? { method: "api-key", allowed: true, notice: t("imagine.api_billing_notice", values) }
            : { method: "api-key", allowed: false, notice: t("imagine.api_billing_required", values) };
    }
    return { method: "browser-login", allowed: true, notice: t("imagine.subscription_pool") };
}
