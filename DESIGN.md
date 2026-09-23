# システム設計

## 目的と境界

Claude Code と Codex から、ローカルにインストールされた Grok Build を使ってレビュー、全体監査、X 検索、タスク委任を実行する。利用者向けの入口と設定は [README.md](README.md)、開発時の検証手順は [AGENTS.md](AGENTS.md) を参照する。

プラグインは Grok Build のインストールや認証サービスを提供せず、既存 CLI を子プロセスとして起動する。モデル実行と外部サービスへのアクセスは Grok Build が担う。`../vps-web/lp/grok-plugin/` はVPSから配信する紹介ページであり、ジョブのバックエンドではない。`/` と `/index.html` に HTML を返し、その他のパスは 404 にする。

## 主要コンポーネント

| 場所 | 責務 |
| --- | --- |
| `plugins/grok/commands/`、`agents/`、`claude-skills/`、`skills/` | Claude Code のコマンド・subagent・内部 helper と、Codex の公開 skill。ホストごとの呼び出し手順、プロンプトの組み立て方、結果の提示契約を分離する |
| `scripts/grok-companion.mjs` | 引数解釈、レビュー・タスクの実行、ジョブ作成、status/result/cancel/setup の統一入口 |
| `scripts/lib/git.mjs`、`prompts.mjs`、`render.mjs`、`prompts/`、`schemas/` | 対象とコンテキストの収集、プロンプト、構造化出力の検証・表示 |
| `scripts/lib/grok.mjs`、`acp.mjs` | Grok CLI と ACP セッション、権限応答、モデル指定、進捗の受信 |
| `scripts/acp-broker.mjs`、`lib/broker-*.mjs` | Grok プロセスの再利用、接続とライフサイクル、JSON-RPC の中継 |
| `scripts/lib/state.mjs`、`tracked-jobs.mjs`、`job-control.mjs` | 状態・成果物の永続化、ジョブ追跡、所有権と停止処理 |
| `hooks/hooks.json` と二つの `scripts/*hook.mjs` | セッション開始・終了、ターンの基準状態記録、任意の終了時レビューゲート |
| `tests/` | fake Grok を使うランタイム検証、権限・状態・フック・両ホスト併用の回帰検証 |

表内の `scripts/`、`prompts/`、`schemas/` は `plugins/grok/` 配下を指す。

Claude の manifest は `skills` に `./claude-skills/`、Codex の manifest は `./skills/` を指定する。Claude 専用 helper の `user-invocable: false` だけに依存せず探索先も分けることで、内部 helper が Codex の公開スキル一覧へ露出するのを防ぐ。Claude の rescue subagent は helper 名で参照し、Codex には `source-command-*` の公開ワークフローだけを配置する。

## データフローと設計判断

1. ホストのコマンドまたはスキルが、対象リポジトリを作業ディレクトリとして companion を前景実行する。Codex は `--json` で完了時にまとめて結果を受け取り、詳細進捗はジョブログへ保存する。これによりジョブ ID、完了、結果取得を一つの実行経路で扱う。
2. companion が対象とプロンプトを作成し、ジョブを登録して ACP で `grok agent stdio` に依頼する。監査は差分やファイル本文を事前に埋め込まず、ファイル一覧から Grok が調査対象を選ぶ。
3. ブローカーは Unix ソケットまたは Windows 名前付きパイプを介して Grok プロセスを再利用し、起動コストを抑える。通常の要求を占有クライアントへ結び付け、キャンセルは別接続からも扱う。権限やファイル操作の逆リクエストは呼び出し元へ転送し、ジョブごとの判断を維持する。接続失敗時には直接起動へフォールバックするため、共有プロセスは必須依存ではない。
4. 応答を検証してジョブ状態、ログ、結果を保存する。`status`、`result`、`cancel` は同じ追跡情報を参照する。

状態保存先は `CLAUDE_PLUGIN_DATA`、次に `PLUGIN_DATA` を採用し、未設定時だけ OS の一時領域を使う。保存先の下をワークスペースの実パス由来のハッシュで分ける。同じ実装を両ホストで利用しつつ、各ホストの data ディレクトリが異なればジョブとゲート設定も独立する。状態更新はロックと一時ファイルからの rename を用い、破損 JSON は黙って初期化せずエラーにする。

## 重要な不変条件

- review、adversarial-review、audit、X 検索は読み取り専用で実行し、レビューの権限処理はシェル許可リストを含む検査で書き込みを拒否する。書き込み可能な委任タスクとは権限経路を分ける。
- review、adversarial-review、audit と終了時レビューゲートは、一つの Grok セッションで各観点を直接調査する。子エージェントの権限継承を保証できないため、委任の許可は追加しない。
- 構造化レビューは `incomplete` を未完了として扱う。権限拒否は JSON 再出力をまたいで保持し、モデルが `approve` を返しても有効な結果を `incomplete` にしてジョブを失敗とする。生の応答は診断用に保持する。終了時レビューゲートも権限拒否後の `ALLOW` では成功させない。`result` は構造化レビューと終了時レビューゲートの保存済み表示を優先し、未完了の説明を生の応答で置き換えない。これにより再表示でも承認との誤認を防ぐ。
- review、adversarial-review、audit では、初回応答がエラーなしの非空本文で JSON 解析に失敗したとき、同じセッションで一度だけ JSON の再出力を要求する。再出力後は成否にかかわらず最新の本文・終了理由・エラーを採用し、思考サマリは初回のものを維持する。これにより訂正前の応答を最終結果と誤認させず、元の調査の思考サマリも保持する。
- レビューの構造化出力が解析または形状検証に失敗した場合は、Grok 側が実行完了でもジョブを失敗として扱う。結果の `grok.status` と `grok.stopReason` は Grok の最新ターンの状態を表し、ジョブの成功判定とは区別する。レビューゲートの成功判定へ壊れた結果を渡さない。
- Grok 実行は前景に統一する。互換用 `--wait` は no-op、`--background` はエラーにする。
- 終了時レビューゲートは既定で無効。`UserPromptSubmit` で基準 fingerprint を記録し、有効時の Stop で変更を判定する。変更のない継続では新たなレビューを起動しない。
- フックは Node.js 内でホストの環境変数からパスを解決する。シェルごとの変数展開へ依存せず、同じ4イベントのフックを両ホストで使用する。
- セッション終了やキャンセルは追跡された所有関係に従う。実行中ジョブの停止は PID とプロセス開始識別子を照合し、PID 再利用時の誤停止リスクを抑える。両ホストの保存先が独立する構成では、一方の終了が他方のジョブやブローカー状態を消さない。
- ACP のクライアントバージョンは配布内の `.codex-plugin/plugin.json` から取得する。ホストごとの manifest を同じバージョンに保つことで共通ランタイムの識別情報をそろえる。

## 製品ページの配信先

製品ページの配信HTMLは `../vps-web/lp/grok-plugin/`（編集元は `../vps-web/tools/lp/templates/`）、公開実体はVPSの `/srv/www/lp/grok-plugin/`。
直接配信の設定は `../vps-web/deploy/caddy-sites/lp-grok-plugin.caddy` に置く。
公開URLを維持し、静的ファイルの配信は `vps-web/deploy/deploy-lp.ps1` へ統一する。
