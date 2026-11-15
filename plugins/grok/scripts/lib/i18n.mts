// companion が利用者へ直接見せる固定文言（setup の結果・レビューの見出し・診断・ヘルプ）を
// 9 言語で出すための辞書と言語判定。共通仕様 APP-DISTRIBUTION.md「8. ローカライズ」に従う。
//
// 判定順: GROK_PLUGIN_LANGUAGE → LC_ALL → LC_MESSAGES → LANG（空・C・POSIX は次へ）
//        → Intl の表示言語 → 英語。
// Grok への応答言語指定 `--language`（BCP 47）とは別物で、そちらは lib/language.mts が扱う。
// AI が読む文言（プロンプト・スキル・スキーマ）と、OS や Grok 由来のエラー詳細は訳さない。
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** 対応言語。辞書ファイル名（locales/<タグ>.json）にも使う。整合テストはこの並びを基準にする。 */
export const SUPPORTED_LANGUAGES = ["ja", "en", "zh-CN", "zh-TW", "ko", "es", "fr", "de", "pt-BR"] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

const localesDirectory = fileURLToPath(new URL("../locales/", import.meta.url));

/**
 * `ja`、`ja_JP.UTF-8`、`zh-Hant-TW`、`pt_BR` などを対応言語へ照合する。
 * zh-Hans・zh-CN・zh-SG は zh-CN、zh-Hant・zh-TW・zh-HK・zh-MO は zh-TW、pt（pt-PT 等を含む）は pt-BR、
 * それ以外は主言語で照合する。未対応の言語は "en"。空文字・C・POSIX（C.UTF-8 を含む）は判定材料にならず null。
 */
export function matchLanguageTag(value: unknown): Language | null {
  const base = String(value ?? "").trim().split(/[.@]/, 1)[0].toLowerCase();
  if (!base || base === "c" || base === "posix") return null;
  const [primary, ...rest] = base.split(/[_-]/);
  // Windows の英語名ロケール（`Chinese (Traditional)_Taiwan.950`）は主言語が "chinese (traditional)" になる。
  switch (primary.startsWith("chinese") ? "zh" : primary) {
    case "ja": case "japanese": return "ja";
    case "zh": {
      // 文字体系（Hans/Hant）を地域より優先する。どちらも無い zh は簡体字。
      if (rest.includes("hant")) return "zh-TW";
      if (rest.includes("hans")) return "zh-CN";
      if (rest.some(tag => ["tw", "hk", "mo", "taiwan", "macao", "macau"].includes(tag))) return "zh-TW";
      if (primary.startsWith("chinese") && /traditional|hong kong/.test(base)) return "zh-TW";
      return "zh-CN";
    }
    case "ko": case "korean": return "ko";
    case "es": case "spanish": return "es";
    case "fr": case "french": return "fr";
    case "de": case "german": return "de";
    case "pt": case "portuguese": return "pt-BR";
    default: return "en";
  }
}

let osLanguageCache: Language | null | undefined;
function osLanguage(): Language | null {
  if (osLanguageCache === undefined) {
    try { osLanguageCache = matchLanguageTag(Intl.DateTimeFormat().resolvedOptions().locale); }
    catch { osLanguageCache = null; }
  }
  return osLanguageCache;
}

/** 環境変数から言語を決める。最初に判定材料になった変数で確定し、何も無ければ OS の表示言語、最後に英語。 */
export function detectLanguage(env: NodeJS.ProcessEnv = process.env): Language {
  for (const name of ["GROK_PLUGIN_LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"]) {
    const language = matchLanguageTag(env[name]);
    if (language) return language;
  }
  return osLanguage() ?? "en";
}

const dictionaries = new Map<Language, Record<string, string>>();
/** 言語の辞書を読み込んで使い回す。ファイルが無い・壊れている場合は空辞書（英語へ退避）。 */
export function loadDictionary(language: Language): Record<string, string> {
  let dictionary = dictionaries.get(language);
  if (!dictionary) {
    try { dictionary = JSON.parse(fs.readFileSync(`${localesDirectory}${language}.json`, "utf8")); }
    catch { dictionary = {}; }
    dictionaries.set(language, dictionary);
  }
  return dictionary;
}

/** `{name}` 形式のプレースホルダーを置換する。値が無いプレースホルダーはそのまま残す。 */
function interpolate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}

/**
 * キーに対応する文言を返す。辞書に無いキーは英語、英語にも無ければキーそのもの。
 * language を省略すると環境から判定する（呼び出しごとに環境変数を読むため、プロセス内で切り替えても反映される）。
 */
export function t(key: string, values: Record<string, unknown> = {}, language: Language = detectLanguage()): string {
  const template = loadDictionary(language)[key] ?? loadDictionary("en")[key] ?? key;
  return interpolate(template, values);
}
