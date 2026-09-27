# レスキュー送信失敗の検証（2026-09-28）

## 対象と再現

- 対象: Codexチャット `01a0b076-4e26-7a71-ac35-32ed9259a871` の最終レスキュー呼び出し。
- 実行元: Windows、Node.js v24.18.0、pnpm 11.26.0、導入済み Grok plugin 1.0.20。
- 導入済み `scripts/grok-companion.mjs` は変更前のリポジトリ HEAD と改行を除いて一致。
- 原因: PowerShell here-string の終端を依頼本文の最終行へ直結していた。
  PowerShell AST parser で `TerminatorExpectedAtEndOfString` を再現した。
  この段階では Node.js も Grok も起動されない。
- `task --json` と `--prompt-file` は導入済み版でも実装されていた。
  ヘルプでの省略を未対応と判断した以前の説明は誤り。

構文エラーの最小再現（実行せず解析する）:

```powershell
$bad = "`$promptText = @'`n依頼本文です。'@; node --version"
$tokens = $null
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseInput(
  $bad, [ref]$tokens, [ref]$errors)
$errors | Select-Object ErrorId, Message
```

## 修正と再実行手順

スキルに複数行本文の UTF-8 ファイル渡しを明記し、読み取り専用では `--write` を省略する。
共有契約には起動前エラーと起動後エラーの切り分けを追加した。
CLI ヘルプには既存の `--json` と `--prompt-file` を明記した。
同じ変更を導入済み 1.0.20 に適用し、対象ファイルの SHA-256 一致を確認した。
バージョン番号は変更していない。

1. 元の依頼文をファイルツールで UTF-8 の一時ファイルに保存する。
2. 元の対象リポジトリ `C:\Users\IMT\dev\UnLhaRe` を cwd として次を実行する。
   `node <plugin-root>/scripts/grok-companion.mjs task --json --fresh --prompt-file <absolute-path>`
3. 同じ foreground プロセスの完了を待つ。
4. 完了 JSON の `jobId` を使って `result <jobId>` を実行し、保存結果を照合する。
5. 一時プロンプトを削除する。再実行は実アカウントを使用するため、必要な場合だけ行う。

独立したエージェントによる修正後手順の PowerShell AST 検証は構文エラー 0 件。
これはコマンド構築の検証であり、将来のエージェントによる遵守を保証するものではない。

## 実環境の結果

- 元の依頼文と元の cwd で `task --json --fresh --prompt-file` を実行し、exit 0、
  `status: completed` を確認した。ジョブ ID は `task-muk8jovx-5zbvlx`。
- `permissionDenials: []`。読み取り専用のままコード調査と助言を完了した。
- 完了 JSON の正確な ID を渡した `result task-muk8jovx-5zbvlx` も exit 0。
  回答原文は `.rescue-command-verification/grok-result.md` に成果物として保存した。
- 助言内容そのものの正しさや、将来のホストエージェントによる指示遵守までは本検証の対象外。

## 検証結果と保持物

- `pnpm test`: 175 件中 174 成功、1 スキップ、失敗 0。
- `pnpm build`、`pnpm check-version`、`git diff --check`: 成功。
- `skill-creator/scripts/quick_validate.py`: 成功。
- 保存した回答は `storedJob.rendered` と result が付加するセッション案内に一致。
- 初回テストは一時領域を本リポジトリ内へ置いたため、Git 基点の検出による干渉で 3 件失敗。
  リポジトリ外へ隔離した全件再実行で上記の成功結果を得た。製品コードを変更して回避していない。

今回作成した一時領域は以下。対象範囲、junction のリンク先、利用プロセスを確認したが、
PowerShell `Remove-Item -LiteralPath` による清掃が自動承認レビューの `blocked by policy` で拒否された。
明示的な絶対パスに組み替えた清掃も拒否されたため、回避せず保持している。
検証プロセスは終了済みで、削除可能な環境になった際に以下の一時物を削除できる。

- `C:\Users\IMT\dev\KG.grok-plugin-cc\.rescue-command-verification\temp`: 初回テストの隔離領域。
- `C:\Users\IMT\AppData\Local\Temp\kg-rescue-command-verification-20260928`: 再実行テストの隔離領域。
- `.rescue-command-verification/prompt.txt`: 元の助言依頼文。
- `.rescue-command-verification/tests.log` と `tests-isolated.log`: 初回と再実行の検証ログ。

`.rescue-command-verification/grok-result.md` は利用者向け成果物として保持する。
以前から存在した `.rescue-fetch-verification` は今回の生成物ではなく、変更していない。
