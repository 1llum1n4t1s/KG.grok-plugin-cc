// BCP 47 言語タグの検証と正規化。review / adversarial-review / audit の
// --language を agent 起動前に検証するため companion から呼ぶ。
// 単体テストから直接検査できるよう、companion から純粋に移したもの（実装は不変）。
export function normalizeLanguageTag(language) {
  if (/[^A-Za-z0-9-]/.test(String(language))) throw new Error(`Invalid BCP 47 language tag "${language}".`);
  const tag = String(language).toLowerCase();
  // RFC 5646 の祖父タグと、Intl が扱わない extlang・private-use を許容する。
  const grandfathered = new Set([
    "en-gb-oed", "i-ami", "i-bnn", "i-default", "i-enochian", "i-hak", "i-klingon",
    "i-lux", "i-mingo", "i-navajo", "i-pwn", "i-tao", "i-tay", "i-tsu",
    "sgn-be-fr", "sgn-be-nl", "sgn-ch-de", "art-lojban", "cel-gaulish", "no-bok",
    "no-nyn", "zh-guoyu", "zh-hakka", "zh-min", "zh-min-nan", "zh-xiang"
  ]);
  const langtag = /^(?:[a-z]{2,3}(?:-[a-z]{3}){0,3}|[a-z]{4}|[a-z]{5,8})(?:-[a-z]{4})?(?:-(?:[a-z]{2}|[0-9]{3}))?(?<variants>(?:-(?:[a-z0-9]{5,8}|[0-9][a-z0-9]{3}))*)(?<extensions>(?:-[0-9a-wy-z](?:-[a-z0-9]{2,8})+)*)(?:-x(?:-[a-z0-9]{1,8})+)?$/;
  const match = langtag.exec(tag);
  if (!grandfathered.has(tag) && !/^x(?:-[a-z0-9]{1,8})+$/.test(tag)) {
    if (!match) throw new Error(`Invalid BCP 47 language tag "${language}".`);
    const variants = match.groups.variants.split("-").filter(Boolean);
    const singletons = Array.from(match.groups.extensions.matchAll(/-([0-9a-wy-z])(?:-[a-z0-9]{2,8})+/g), (item) => item[1]);
    if (new Set(variants).size !== variants.length || new Set(singletons).size !== singletons.length) {
      throw new Error(`Invalid BCP 47 language tag "${language}".`);
    }
  }
  try { return new Intl.Locale(language).toString(); } catch { return tag; }
}
