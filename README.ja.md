[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Português (Brasil)](README.pt-BR.md)

# Claude Code・Codex 向け Grok プラグイン

Claude Code や Codex から Grok Build を使い、コードレビュー、リポジトリ監査、X 検索、タスクの委任、画像生成を行えます。本プロジェクトは [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) のフォークです。詳細は [NOTICE](NOTICE) を参照してください。

## 必要環境とインストール

[Grok Build](https://x.ai/cli) をインストールし、ログインまたは API キーを設定してください。Git 2.45 以降（または `--no-lazy-fetch` のバックポート版）が必要です。Windows・macOS・Linux では Bun 1.4.4 以降または Node.js 22 以降を使い、両方ある場合は Bun を優先します。Grok の利用は使用するアカウントまたは API キーに課金されます。`grok agent stdio` が使えない場合は `grok update` で更新してください。

Windows では ia32・x64・arm64 のランタイムに対応するネイティブ helper を同梱しています。Rust や MSVC のインストールは不要です。

Claude Code では次を実行します。

```text
/plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
/plugin install grok@kagayoi-grok
```

Codex ではターミナルから次を実行します。

```bash
codex plugin marketplace add 1llum1n4t1s/KG.grok-plugin-cc
codex plugin add grok@kagayoi-grok
```

新しい Codex タスクでスキルを読み込みます。両ホストで使う場合はそれぞれにインストールしてください。

### 更新

Claude Code では、`kagayoi-grok` のようなサードパーティーのマーケットプレイスは自動更新が既定で無効です。有効にするには、Claude Code のセッションで `/plugin` を実行し、**Marketplaces** タブで `kagayoi-grok` を選んで **Enable auto-update** を選択します。以後はセッション開始後にマーケットプレイスを更新し、インストール済みのプラグインも更新します。新しい版は `/reload-plugins` の実行か、次のセッションの開始で読み込まれます。すぐに更新したい場合は、シェルで `claude plugin update grok@kagayoi-grok` を実行します。

Codex では、`codex plugin marketplace upgrade kagayoi-grok` でマーケットプレイスを更新し、新しい Codex タスクを開始します。

## コマンド

Claude Code では `/grok:review`、`/grok:adversarial-review`、`/grok:audit`、`/grok:imagine`、`/grok:rescue`、`/grok:x`、`/grok:setup` を使います。Codex では対応する `grok:source-command-<name>` スキルを選びます。レビュー・監査と X 検索は読み取り専用です。rescue は編集も依頼できます。`/grok:imagine <description>` は Grok Build に画像を生成させ、ワークスペース内の `grok-imagine/`、またはワークスペース内に収まる `--output <path>` へコピーします。リポジトリの他のファイルは編集しません。`grok login` では、生成はサブスクリプションの共有週間利用枠から消費されます。`XAI_API_KEY` があるときは、`--allow-api-billing` を付けるまでコマンドは止まります。API の画像は共有枠ではなく xAI の従量料金（`grok-imagine-image-2.0` は $0.04/img から）です。setup は Grok の認証を確認します。

Windows では `/grok:review --scope working-tree` でローカル変更をレビューできます。`auto` と `working-tree` は Windows の安全なスナップショットを完全に取得できることが条件で、取得できなければ失敗します。macOS/Linux では `/grok:review --scope branch` または `--base <ref>` を明示してコミット済みの変更をレビューしてください。未コミット変更は比較差分には含まれませんが、周辺ファイルは作業ツリーから読み取られる場合があります。全 OS で `/grok:audit authentication` によりリポジトリ全体の監査を認証に絞り、`/grok:rescue <task>` でタスクを委任できます。レビュー・敵対的レビュー・監査には `--language <BCP 47 tag>` も指定できます。起動や認証に失敗したら `/grok:setup` を実行し、表示されたエラーと Grok のログイン案内を確認してください。

各実行は新しい Grok セッションを前景で開始し、その結果を直接返します。会話の続きは Grok 本体で行ってください。自動レビューと旧 status・result・cancel・state-lock・タスク再開コマンドは利用できません。

ローカルにインストールされた Grok CLI を起動します。companion は ACP のファイル要求のパスを検査し、読み取り専用の権限要求を許可リストで判定します。明示的に編集を依頼したタスクはワークスペースを変更できます。組込みのファイル・シェル操作、外部アクセスと認証は Grok Build が担います。companion はすべての I/O を仲介する OS サンドボックスではなく、symlink 経由を含む完全なアクセス隔離は保証しません。結果と変更を確認してから利用してください。

## 表示言語

companion 自身のメッセージ（setup の結果、レビューの見出し、診断、ヘルプ）は、環境の言語で表示します。`GROK_PLUGIN_LANGUAGE`、`LC_ALL`、`LC_MESSAGES`、`LANG`、システムの表示言語の順に判定し、判定できなければ英語にします。対応言語は `ja`、`en`、`zh-CN`、`zh-TW`、`ko`、`es`、`fr`、`de`、`pt-BR` です。Grok のレビュー本文の言語を決める `--language` とは別の設定です。Grok 自身の出力と、OS や Grok から返るエラーの詳細は翻訳しません。

## トラブルシュート

HTTP 402 と `usage balance exhausted` が表示された場合は、Grok Build の利用枠が不足しています。利用枠の回復後に再実行してください。サブスクリプションの画像生成も同じ共有枠を使います。画像ツールに SuperGrok のサブスクリプションが必要だと返った場合、そのサインインには Imagine が含まれていません。Imagine を含むプランを使うか、`--allow-api-billing` を付けた API キーを使ってください。タイムアウト、権限拒否、不完全なレビュー、agent の終了未確認は実行失敗です。途中の出力を完了したレビューやタスクとして扱わないでください。

読み取り専用レビューでは、読取りだけを意図したスクリプトでも Python・Node.js・Bun・別シェル経由の実行は拒否します。Grok Build は権限拒否後に `cancelled` でターンを終了することがあります。JSON などの証拠は組込みのファイル読取りツールで確認し、アクセスできない証拠は未検証とします。レビュー開始時のプロンプトにも、この制約を渡します。

ソースからのビルド、開発用コマンドと検証手順は [開発ガイド](CONTRIBUTING.md#日本語)、実行時の構造と境界は [DESIGN.md](DESIGN.md) を参照してください。
