/** 空白を正規化し、コードポイント単位で省略する。 */
export function shortenText(text, limit) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  const characters = Array.from(normalized);
  if (!normalized) {
    return "";
  }
  if (characters.length <= limit) {
    return normalized;
  }
  return `${characters.slice(0, limit - 3).join("")}...`;
}
