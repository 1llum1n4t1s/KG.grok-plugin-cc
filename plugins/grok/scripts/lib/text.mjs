/** 空白を正規化し、コードポイント単位で省略する。 */
export function shortenText(text, limit) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (Number.isSafeInteger(limit) && limit >= 3) {
    const prefix = [];
    let count = 0;
    for (const character of normalized) {
      count++;
      if (count > limit) return `${prefix.join("")}...`;
      if (count <= limit - 3) prefix.push(character);
    }
    return normalized;
  }
  const characters = Array.from(normalized);
  if (characters.length <= limit) {
    return normalized;
  }
  return `${characters.slice(0, limit - 3).join("")}...`;
}
