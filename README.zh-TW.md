[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-BR.md)

# 適用於 Claude Code 與 Codex 的 Grok 外掛程式

在 Claude Code 或 Codex 中執行 Grok Build，用於程式碼審查、儲存庫稽核、X 搜尋、委派任務與影像產生。本專案是 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 的分支（fork），詳見 [NOTICE](NOTICE)。

## 系統需求與安裝

請安裝 [Grok Build](https://x.ai/cli)，完成登入或設定其 API 金鑰，並安裝 Git 2.45 或更新版本（或已回移 `--no-lazy-fetch` 的 Git 版本）。在 Windows、macOS 與 Linux 上，請安裝 Bun 1.4.4 或更新版本，或 Node.js 22 或更新版本；兩者皆可用時優先使用 Bun。Grok 的使用費用會計入所使用的帳號或 API 金鑰。Grok 必須支援 `grok agent stdio`；如有需要，請以 `grok update` 更新。

在 Windows 上，本外掛程式內含適用於 ia32、x64 與 arm64 執行環境的原生輔助程式，無須安裝 Rust 或 MSVC。

在 Claude Code 中：

```text
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
/plugin install grok@kagayoi-grok
```

在 Codex 中，請執行：

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

請開啟新的 Codex 任務以載入其技能（skills）。若兩者都使用，請在各個主機環境中分別安裝。

### 更新

對於 `kagayoi-grok` 等第三方 marketplace，Claude Code 預設關閉自動更新。若要啟用，請在 Claude Code 工作階段中執行 `/plugin`，開啟 **Marketplaces** 分頁，選取 `kagayoi-grok`，然後選擇 **Enable auto-update**。之後 Claude Code 會在工作階段啟動後重新整理 marketplace，並更新已安裝的外掛程式；請執行 `/reload-plugins` 或開啟新的工作階段來載入新版本。若要立即更新，請改在 shell 中執行 `claude plugin update grok@kagayoi-grok`。

對於 Codex，請執行 `codex plugin marketplace upgrade kagayoi-grok` 來重新整理 marketplace，然後開啟新的 Codex 任務。

## 指令

Claude Code 提供 `/grok:review`、`/grok:adversarial-review`、`/grok:audit`、`/grok:imagine`、`/grok:rescue`、`/grok:x` 與 `/grok:setup`。在 Codex 中，請選取對應的 `grok:source-command-<name>` 技能。審查與稽核為唯讀；rescue 可以要求進行編輯，而 X 搜尋則維持唯讀。`/grok:imagine <description>` 會請 Grok Build 產生影像，並複製到工作區的 `grok-imagine/`，或複製到仍位於工作區內的 `--output <path>`。它不會編輯儲存庫中的其他檔案。使用 `grok login` 時，產生會消耗訂閱的共享每週用量額度。設定了 `XAI_API_KEY` 時，指令會停下，直到加上 `--allow-api-billing`：API 影像依 xAI 費率計費（`grok-imagine-image-2.0` 標價自 $0.04/img 起），而不是使用該額度。Setup 會檢查 Grok 的驗證狀態。

在 Windows 上，請使用 `/grok:review --scope working-tree` 審查本機變更。`auto` 與 `working-tree` 範圍需要取得完整且安全的 Windows 快照，若無法取得則會失敗。在 macOS/Linux 上，請明確使用 `/grok:review --scope branch` 或 `--base <ref>` 來審查已提交的變更；未提交的變更不會納入比較用的 diff，但周邊檔案仍可能從工作目錄讀取。在任何平台上，皆可使用 `/grok:audit authentication` 將整個儲存庫的稽核聚焦於特定主題，或使用 `/grok:rescue <task>` 委派任務。審查、對抗式審查與稽核也接受 `--language <BCP 47 tag>`。當安裝或驗證失敗時，請執行 `/grok:setup`；並依照其回報的錯誤與 Grok 的登入指引處理。

每次呼叫都會在前景啟動新的 Grok 工作階段，並直接回傳結果。若要延續對話，請使用 Grok 本身的介面。自動審查，以及先前的 status、result、cancel、state-lock 與 task-resume 指令，已不再由 companion 支援。

Companion 會啟動本機已安裝的 Grok CLI。它會在 ACP 檔案請求時檢查路徑，並套用唯讀權限允許清單；明確要求的寫入任務則可修改工作區。Grok Build 負責處理其內建的檔案系統與 shell 操作、對外存取及驗證。Companion 不會仲介每一項 I/O 操作，也不提供作業系統層級的沙箱，並且不保證完整的存取隔離，包括透過符號連結（symlink）的情況。在依賴 Grok 的輸出與變更之前，請先加以檢視。

## 顯示語言

Companion 自身的訊息（setup 結果、審查標題、診斷資訊與說明）會以您環境所使用的語言顯示。它會依序檢查 `GROK_PLUGIN_LANGUAGE`，接著是 `LC_ALL`、`LC_MESSAGES` 與 `LANG`，再來是系統顯示語言，最後退回使用英文。支援的語言為 `ja`、`en`、`zh-CN`、`zh-TW`、`ko`、`es`、`fr`、`de` 與 `pt-BR`。這與 `--language` 不同，後者用於設定 Grok 審查文字的語言。Grok 自身的輸出，以及來自作業系統或 Grok 的錯誤詳細資訊，不會被翻譯。

## 疑難排解

若呼叫回報 HTTP 402 與 `usage balance exhausted`，代表 Grok Build 的使用額度已用盡。請待額度恢復後再重試。訂閱登入下的影像產生也使用同一個共享額度。若影像產生回報 Grok Build 的影像工具需要 SuperGrok 訂閱，則此登入不包含 Imagine；請使用包含 Imagine 的方案，或使用帶 `--allow-api-billing` 的 API 金鑰。逾時、權限遭拒、審查未完成，或未能確認 agent 已停止，皆視為呼叫失敗；請勿將部分輸出視為已完成的審查或任務。

要為 `/grok:imagine` 選擇圖像模型，請傳入 `--image-model <id>`（或設定 `GROK_PLUGIN_IMAGE_MODEL`）。編輯既有圖像請使用 `--image-edit-model <id>`（或 `GROK_PLUGIN_IMAGE_EDIT_MODEL`），生成用的 ID 不會被沿用於編輯。companion 僅在該次執行中設定 Grok 的 `GROK_IMAGE_GEN_MODEL_OVERRIDE` / `GROK_IMAGE_EDIT_MODEL_OVERRIDE`，並在 `--json` 中以 `requestedImageModel` 回報所要求的 ID。未使用這些選項時，預設值為 `grok-imagine-image-2.0`（最高品質，也用於編輯）；若您自行設定了 `GROK_IMAGE_GEN_MODEL_OVERRIDE` / `GROK_IMAGE_EDIT_MODEL_OVERRIDE`，則原樣傳給 Grok。向任一選項或 `GROK_PLUGIN_IMAGE_*` 傳入 `auto`（不分大小寫）即交由 Grok 決定：外掛不設定任何值，您自行設定的覆寫值仍會原樣傳遞，否則 `requestedImageModel` 為 `null`。ID 只檢查字元，帳號無法使用的 ID 會在生成圖像時被 xAI 拒絕。`--effort` 設定的是聊天模型的推理深度，而不是圖像品質。

在唯讀審查與唯讀任務（不帶 `--write` 的 `task`）期間，即使 Python、Node.js、Bun 與 shell 包裝程式僅用於讀取檔案，也會被拒絕。Grok Build 可能在權限遭拒後以 `cancelled` 結束該回合。請使用內建的檔案工具檢視 JSON 與其他佐證資料；無法取得的佐證仍視為未經驗證。審查提示詞，以及唯讀任務中附加在你的請求之後的說明，會在檢視開始前說明這些限制。

關於從原始碼建置、開發指令與驗證，請參閱 [開發指南](CONTRIBUTING.md#english)。執行階段的結構與邊界說明於 [DESIGN.md](DESIGN.md)。
