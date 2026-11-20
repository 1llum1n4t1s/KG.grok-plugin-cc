import { fileURLToPath } from "node:url";
import { t } from "./i18n.mjs";

/** 配布済みのネイティブヘルパーを選ぶ。存在確認は起動側で扱う。 */
export function windowsHelperPath(arch: string = process.arch): string {
  if (arch !== "ia32" && arch !== "x64" && arch !== "arm64") {
    throw new Error(t("err.windows_arch"));
  }
  return fileURLToPath(new URL(`../../bin/win32-${arch}/grok-windows-helper.exe`, import.meta.url));
}
