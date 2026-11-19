import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { SUPPORTED_LANGUAGES, detectLanguage, matchLanguageTag, t } from "../plugins/grok/scripts/lib/i18n.mjs";
import { GROK_INSTALL_COMMANDS } from "../plugins/grok/scripts/lib/grok.mjs";
import { renderReviewResult } from "../plugins/grok/scripts/lib/render.mjs";

const scriptsDirectory = fileURLToPath(new URL("../plugins/grok/scripts/", import.meta.url));
const localesDirectory = path.join(scriptsDirectory, "locales");
const dictionary = (tag: string): Record<string, string> => JSON.parse(fs.readFileSync(path.join(localesDirectory, `${tag}.json`), "utf8"));
const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();

test("every supported language has exactly one dictionary and no stray locale files", () => {
  assert.deepEqual([...SUPPORTED_LANGUAGES].sort(), ["de", "en", "es", "fr", "ja", "ko", "pt-BR", "zh-CN", "zh-TW"]);
  assert.deepEqual(fs.readdirSync(localesDirectory).sort(), SUPPORTED_LANGUAGES.map(tag => `${tag}.json`).sort());
});

test("all dictionaries share the English key set and the same placeholders", () => {
  const english = dictionary("en");
  assert.ok(Object.keys(english).length > 0);
  for (const tag of SUPPORTED_LANGUAGES) {
    const translated = dictionary(tag);
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort(), `${tag}: key set differs from en`);
    for (const [key, text] of Object.entries(translated)) {
      assert.equal(typeof text, "string", `${tag}.${key}`);
      assert.ok(text.trim(), `${tag}.${key} is empty`);
      assert.deepEqual(placeholders(text), placeholders(english[key]), `${tag}.${key}: placeholders differ from en`);
    }
  }
});

test("keys referenced by the code exist in the dictionary and no dictionary key is unused", () => {
  const sources = ["grok-companion.mts", "lib/render.mts", "lib/grok.mts", "lib/imagine.mts", "lib/args.mts", "lib/git.mts", "lib/language.mts"].map(file => fs.readFileSync(path.join(scriptsDirectory, file), "utf8")).join("\n");
  const used = new Set([...sources.matchAll(/"((?:cli|setup|diag|review|render|imagine|err)\.[a-z_.]+)"/g)].map(match => match[1]));
  const keys = new Set(Object.keys(dictionary("en")));
  for (const key of used) assert.ok(keys.has(key), `code references missing key ${key}`);
  for (const key of keys) assert.ok(used.has(key), `dictionary key ${key} is not referenced by the code`);
});

test("language tags follow the shared matching rules", () => {
  const cases: Record<string, string | null> = {
    "ja": "ja", "ja_JP.UTF-8": "ja", "en_US.UTF-8": "en", "ko-KR": "ko", "es-MX": "es", "fr_CA": "fr", "de-AT": "de",
    "zh": "zh-CN", "zh-Hans": "zh-CN", "zh-CN": "zh-CN", "zh_SG": "zh-CN", "zh-Hans-CN": "zh-CN",
    "zh-Hant": "zh-TW", "zh-TW": "zh-TW", "zh_HK.UTF-8": "zh-TW", "zh-MO": "zh-TW", "zh-Hant-CN": "zh-TW",
    "pt": "pt-BR", "pt-BR": "pt-BR", "pt_PT": "pt-BR", "Chinese (Traditional)_Taiwan.950": "zh-TW", "Japanese_Japan.932": "ja",
    "it_IT": "en", "C": null, "POSIX": null, "C.UTF-8": null, "": null, "  ": null
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(matchLanguageTag(input), expected, JSON.stringify(input));
  assert.equal(matchLanguageTag(undefined), null);
});

test("language detection prefers GROK_PLUGIN_LANGUAGE, then LC_ALL, LC_MESSAGES, LANG", () => {
  assert.equal(detectLanguage({ GROK_PLUGIN_LANGUAGE: "de", LC_ALL: "ja_JP.UTF-8", LANG: "fr_FR" }), "de");
  assert.equal(detectLanguage({ LC_ALL: "ko_KR.UTF-8", LC_MESSAGES: "ja", LANG: "fr" }), "ko");
  assert.equal(detectLanguage({ LC_MESSAGES: "es_ES", LANG: "fr" }), "es");
  assert.equal(detectLanguage({ LANG: "pt_BR.UTF-8" }), "pt-BR");
  // 空・C・POSIX は判定材料にならず次の変数へ進む。
  assert.equal(detectLanguage({ GROK_PLUGIN_LANGUAGE: "", LC_ALL: "C", LC_MESSAGES: "POSIX", LANG: "zh_TW.UTF-8" }), "zh-TW");
  // 未対応の言語は英語で確定し、後続の変数は見ない。
  assert.equal(detectLanguage({ LC_ALL: "it_IT.UTF-8", LANG: "ja_JP.UTF-8" }), "en");
  // 何も無ければ OS の表示言語、判定できなければ英語。結果は必ず対応言語のいずれか。
  assert.ok((SUPPORTED_LANGUAGES as readonly string[]).includes(detectLanguage({})));
});

test("translation interpolates placeholders and falls back safely", () => {
  assert.equal(t("render.verdict", { value: "approve" }, "en"), "Verdict: approve");
  assert.equal(t("render.verdict", { value: "approve" }, "ja"), "判定: approve");
  assert.equal(t("setup.authenticated", { method: "api-key" }, "fr"), "Grok est authentifié (api-key).");
  // 値の無いプレースホルダーはそのまま残す。
  assert.equal(t("render.verdict", {}, "en"), "Verdict: {value}");
  // 辞書に無いキーはキーそのもの（落ちない）。
  assert.equal(t("no.such.key", {}, "de"), "no.such.key");
});

test("review rendering follows the display language without changing identifiers", () => {
  const parsed = { verdict: "needs-attention", summary: "S", next_steps: ["N"], findings: [{
    severity: "high", title: "T", body: "B", file: "a.ts", line_start: 1, line_end: 2, confidence: 0.9, recommendation: "R" }] };
  const previous = process.env.GROK_PLUGIN_LANGUAGE;
  try {
    process.env.GROK_PLUGIN_LANGUAGE = "ja";
    const output = renderReviewResult({ parsed, rawOutput: "", parseError: null }, { reviewLabel: "レビュー", targetLabel: "working tree" });
    assert.match(output, /^# Grok レビュー$/m);
    assert.match(output, /判定: needs-attention/);
    assert.match(output, /指摘:/);
    assert.match(output, /- \[high\] T \(a\.ts:1-2\)/);
    assert.match(output, /推奨: R/);
    assert.match(output, /次の手順:/);
  } finally {
    if (previous === undefined) delete process.env.GROK_PLUGIN_LANGUAGE; else process.env.GROK_PLUGIN_LANGUAGE = previous;
  }
});

test("the companion help follows the environment language and falls back to English", () => {
  const help = (env: Record<string, string>) => spawnSync(process.execPath, [path.join(scriptsDirectory, "grok-companion.mjs"), "help"], {
    encoding: "utf8", timeout: 15000, env: { ...process.env, GROK_PLUGIN_LANGUAGE: "", LC_ALL: "", LC_MESSAGES: "", LANG: "", ...env }
  });
  const japanese = help({ GROK_PLUGIN_LANGUAGE: "ja" });
  assert.equal(japanese.status, 0, japanese.stderr);
  assert.match(japanese.stdout, /^使い方: grok-companion\.mjs <setup\|review\|adversarial-review\|audit\|task\|imagine>/);
  assert.match(help({ LC_ALL: "fr_FR.UTF-8" }).stdout, /^Utilisation: grok-companion\.mjs/);
  assert.match(help({ GROK_PLUGIN_LANGUAGE: "it" }).stdout, /^Usage: grok-companion\.mjs/);
});

test("the missing-Grok startup error follows the display language and shares the install commands", () => {
  const missing = path.join(scriptsDirectory, "no-such-grok-binary");
  const run = (language: string) => spawnSync(process.execPath, [path.join(scriptsDirectory, "grok-companion.mjs"), "task", "inspect"], {
    encoding: "utf8", timeout: 15000, cwd: os.tmpdir(), env: { ...process.env, GROK_PLUGIN_LANGUAGE: language, GROK_BIN: missing }
  });
  const japanese = run("ja");
  assert.equal(japanese.status, 1, japanese.stderr);
  assert.match(japanese.stderr, /Grok Build がインストールされていません/);
  assert.ok(japanese.stderr.includes(GROK_INSTALL_COMMANDS.windows) && japanese.stderr.includes(GROK_INSTALL_COMMANDS.unix));
  assert.match(run("en").stderr, /^Grok Build is not installed\. Install it with `irm https:\/\/x\.ai\/cli\/install\.ps1 \| iex` \(Windows\) or `curl -fsSL https:\/\/x\.ai\/cli\/install\.sh \| bash`, then rerun `\/grok:setup`\./m);
});
