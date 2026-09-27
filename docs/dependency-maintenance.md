# 依存関係の保守（2026-09-28）

- ブランチ: `main`。既存のレスキュー修正を保持し、stage・commit・push は行っていない。
- `@types/node`: 26.5.1 → 26.6.3（minor）。`^` と devDependencies 区分を維持。
  `package.json` と pnpm が生成する `pnpm-lock.yaml` を更新。互換コード変更は不要。
- TypeScript 7.0.2、actions/checkout v7.0.1、actions/setup-node v7.0.0 は最新安定版。
  Actions の tag が指す commit と既存 SHA pin の一致を確認。
- 製品 1.0.20、Node.js 世代、pnpm 11.26.0 の toolchain pin は維持。
  pnpm は 12.6.0 の通知があるが、既存 toolchain の移行は今回の対象外。
- 他の package manager manifest、同梱 binary、vendored source は該当なし。
  Grok Build は利用者が別途導入する外部実行環境で、同梱依存ではない。

## 検証

- Windows x64 / Node.js v24.18.0 / pnpm 11.26.0。
- `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm check-version`、`git diff --check`: 成功。
- `pnpm test`: 175 件中 174 成功、1 スキップ、失敗 0。更新 batch は `verified`。
- `pnpm outdated --format json`: `{}`。
- `pnpm audit --json`: 脆弱性 0 件。
- @types/node、TypeScript、undici-types の採用版に deprecated 指定なし。install の警告なし。
- native TypeScript は Windows x64 で実行確認。他 architecture は lockfile の確認のみ。

今回のテスト一時領域は `C:\Users\IMT\AppData\Local\Temp\kg-deps-verification-20260928`。
実行終了後、絶対パス・junction のリンク先・利用プロセスなしを確認したが、
`Remove-Item -LiteralPath` による清掃は自動承認レビューに `blocked by policy` で拒否された。
詳細理由は返されておらず、回避せずテストログと一時 fixture を保持した。
上記結果を記録済みのため、削除が許可される環境ではこの一時領域を削除できる。

## Dependabot

- `.github/dependabot.yml` は既定ブランチにも存在し、YAML 解析成功。
  root の npm と github-actions、週次 schedule、minor/patch groups は既存運用に適合。
  設定変更なし。開いている Dependabot PR は 0 件。
- GitHub API で alerts 有効（204）、security updates 有効・停止なしを確認。
- [公式対応表](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories)
  は pnpm v10 までの記載。現在の v11 による Dependabot 自動更新の動作保証は未確認。
  package manager の変更や監視設定の削除は行っていない。
