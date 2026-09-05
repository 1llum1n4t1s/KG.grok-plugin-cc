# 変更履歴

Git のバージョン記録・コミット差分と既存の変更履歴をもとに、確認できた版ごとの変更点をまとめています。「Git 記録日」は公開日ではありません。番号の欠番だけから未確認のリリースは補っていません。

## 未リリース

## [1.0.12] — 2026-09-06

- Windows の標準フックをシェルの環境変数展開に依存せず起動できるように修正しました。
- Codex のプラグイン保存先に対応し、Claude Code との個別インストール・同時使用の手順を明記しました。
- Codex 用マーケットプレイス定義を追加し、Claude Code 用の配布定義と併存させました。

## [1.0.11] — Git 記録日: 2026-08-24

- Made the optional stop-time review gate compose safely with other Stop hooks by using a bounded repository fingerprint, skipping unchanged continuations, retaining Grok's own blockers until a subsequent edit is re-reviewed, sending long prompts over stdin, and keeping gate sessions out of rescue-task continuation.
- Kept Codex chats quiet during foreground Grok runs by buffering progress in JSON mode and returning the exact job ID only after completion; Claude Code's foreground display is unchanged.
- Rejected Git output and external-execution options from read-only Grok review sessions.

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/edd535ae917ce0d1799a93981c1422c9e3f9e9a1) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/488fc8150221532eeee93b0b047f7eb2ffeb5c7d...edd535ae917ce0d1799a93981c1422c9e3f9e9a1) / [プラグインの詳細](plugins/grok/CHANGELOG.md)。

## [1.0.10] — Git 記録日: 2026-08-23

- Aligned lifecycle hooks with Codex's three-second `SessionEnd` limit and made session scoping consistent across Claude Code and Codex. Stop warnings, optional review-gate jobs, and cleanup now preserve the active session when a hook payload supplies a blank session ID.

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/488fc8150221532eeee93b0b047f7eb2ffeb5c7d) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/cf9805b5dcfc029768c2ef689c9c6b5f7e7f4b7e...488fc8150221532eeee93b0b047f7eb2ffeb5c7d) / [プラグインの詳細](plugins/grok/CHANGELOG.md)。

## [1.0.9] — Git 記録日: 2026-08-13

- Unified Claude Code, Codex, and the companion runtime on foreground-only Grok execution. Legacy `--wait` remains a no-op, while `--background` now fails clearly instead of creating a second process lifecycle.
- Added `CODEX_THREAD_ID` as the Codex session identity fallback so tracked jobs, bare results, cancellation, and rescue continuation remain scoped to the current Codex task.
- Added complete Japanese installation and usage documentation alongside the English README.

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/cf9805b5dcfc029768c2ef689c9c6b5f7e7f4b7e) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/4c14a74cd1470684c46879869e5bfafcd36dc476...cf9805b5dcfc029768c2ef689c9c6b5f7e7f4b7e) / [プラグインの詳細](plugins/grok/CHANGELOG.md)。

## [1.0.8] — Git 記録日: 2026-08-13

- Hardened read-only reviews against shell-control bypasses, write-capable Git forms, repository path escapes, symlink traversal, and oversized untracked-file context.
- Made cancellation, job state, process cleanup, shared-broker reuse, and ACP timeouts safe under concurrent sessions. Commands now retrieve the exact job they launched instead of guessing from the most recently finished result.
- Review, adversarial-review, and audit now start immediately in the host-managed background mode unless `--wait` is explicit. Audits without a focus use a risk-directed deep tracing pass.

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/4c14a74cd1470684c46879869e5bfafcd36dc476) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/c27efd777bfb3f6c3e5531a3dacf7db105054bc3...4c14a74cd1470684c46879869e5bfafcd36dc476) / [プラグインの詳細](plugins/grok/CHANGELOG.md)。

## [1.0.7] — Git 記録日: 2026-08-13

- Fixed Codex background execution for review, adversarial review, audit, rescue, and X search. Long-running jobs now stay attached to a Codex-managed process, announce their exact Grok job ID, and expose initial progress instead of detaching invisibly inside the companion. Review and audit skills ask for the execution mode when it is not explicit, while rescue and X search remain foreground by default.

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/c27efd777bfb3f6c3e5531a3dacf7db105054bc3) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/d987587198e190e2c95bf0880cc3250d713a5c1f...c27efd777bfb3f6c3e5531a3dacf7db105054bc3) / [プラグインの詳細](plugins/grok/CHANGELOG.md)。

## [1.0.6] — Git 記録日: 2026-08-13

- Updated the explicitly selected default model and the `latest` alias from Grok 4.5 to Grok 4.6, including the documentation and landing page. Explicit model overrides remain supported.

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/d987587198e190e2c95bf0880cc3250d713a5c1f) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/1441d51912d91d366061bbe916ea411cc7d79c0c...d987587198e190e2c95bf0880cc3250d713a5c1f) / [プラグインの詳細](plugins/grok/CHANGELOG.md)。

## [1.0.5] — Git 記録日: 2026-08-12

- Added native Codex plugin support alongside Claude Code. The plugin now ships a Codex manifest and matching skills for review, adversarial review, repository audit, rescue, job status, cancellation, stored results, setup, and X search, all routed through the same companion runtime and job store. The README and landing page now document installation and usage in both hosts.
- Added detached background execution for review and audit jobs without relying on a host-specific background API. Job state is now persisted before the worker starts, preventing fast workers from racing the parent process or having completed state overwritten as queued.

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/1441d51912d91d366061bbe916ea411cc7d79c0c) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/cd2ab9eebdb5fe394bac4f4a7851c443b607c648...1441d51912d91d366061bbe916ea411cc7d79c0c) / [プラグインの詳細](plugins/grok/CHANGELOG.md)。

## [1.0.4] — Git 記録日: 2026-08-09

- Stopped rendering Grok's internal thought stream (the `Reasoning:` section) in `/grok:review`, `/grok:audit`, and `/grok:adversarial-review` output once the structured result parsed successfully. The thought stream is not subject to the response-language instruction, so it always came out in English even when the rest of the report was in the user's language, and it carries no information beyond conversational fragments. It is still shown when the structured result fails to parse, since it is the only diagnostic trail left in that case.

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/cd2ab9eebdb5fe394bac4f4a7851c443b607c648) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/761fb42ce4020eb12d22e89e5d68e160cce8671c...cd2ab9eebdb5fe394bac4f4a7851c443b607c648) / [プラグインの詳細](plugins/grok/CHANGELOG.md)。

## [1.0.3] — Git 記録日: 2026-08-06

- Fixed `/grok:review`, `/grok:adversarial-review`, `/grok:audit`, and `/grok:x` still returning noisy or missing output when run in the foreground. The 1.0.2 fix only rewired the background flow; foreground runs kept treating the `Bash` call's own merged stdout/stderr as the report, so progress lines (`[grok] Tool: ...`) and Node warnings still leaked in, and some runs answered with a pointer or a summary instead of the report itself. Foreground now reads the finished job back with `grok-companion.mjs result`, exactly like the background flow, and each command spells out that the report only reaches the user through the assistant's own reply, verbatim, in full.

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/761fb42ce4020eb12d22e89e5d68e160cce8671c) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/2a25569ec304ffe06fa989479ac74321204652d1...761fb42ce4020eb12d22e89e5d68e160cce8671c) / [プラグインの詳細](plugins/grok/CHANGELOG.md)。

## [1.0.2] — Git 記録日: 2026-08-06

- Fixed background `/grok:review`, `/grok:adversarial-review`, `/grok:audit`, and `/grok:x` runs returning noisy output: Claude Code merges a background task's stdout and stderr into a single file, so the companion's own progress lines (`[grok] Tool: ...`) and any Node warnings landed ahead of the report when that file was read back. The commands now read the finished job's stored report with `grok-companion.mjs result` instead, which returns the rendered output only.
- Stopped emitting Node's `DEP0190` deprecation warning on every `grok` and `grok agent stdio` spawn on Windows. Passing an argument array together with `shell: true` triggered the warning on Node 22+; the plugin now folds the command and arguments into a single shell-safe string instead.

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/2a25569ec304ffe06fa989479ac74321204652d1) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/440ab46f71484ad2db94762f58c0be6b2a0eb36a...2a25569ec304ffe06fa989479ac74321204652d1) / [プラグインの詳細](plugins/grok/CHANGELOG.md)。

## [1.0.1] — Git 記録日: 2026-08-05

- /grok:status の Session runtime が undefined になるのを直す
- 前景レビューが既定タイムアウトで打ち切られないようにする

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/440ab46f71484ad2db94762f58c0be6b2a0eb36a) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/2998be122ff161b61dfbe4e153f4af83c730cc80...440ab46f71484ad2db94762f58c0be6b2a0eb36a)。

## [1.0.0] — Git 記録日: 2026-08-05

- Grok フォークのパッケージバージョンを 1.0.0 へ変更。

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/2998be122ff161b61dfbe4e153f4af83c730cc80) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/42a80eec8713eba380b48179f17a412c6e25ad52...2998be122ff161b61dfbe4e153f4af83c730cc80)。

## [0.1.1] — Git 記録日: 2026-08-05

- X (Twitter) 検索コマンドを追加する
- ランディングページ配信 Worker を追加する
- 掲載名をディレクトリ申請と同じ名前に固定する
- 巨大リポジトリでの監査失敗と severity の並び順の崩れを直す
- 状態の同時更新とブローカープロセスの残留を防ぐ
- 自由記述がフラグやシェルとして再解釈される経路を塞ぐ

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/42a80eec8713eba380b48179f17a412c6e25ad52) / [変更差分](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/compare/008eb25e13d49d0324a8c14d5d4a157b434ee276...42a80eec8713eba380b48179f17a412c6e25ad52)。

## [0.1.0] — Git 記録日: 2026-08-04

- First release of the Grok plugin, forked from `openai/codex-plugin-cc` and retargeted from the OpenAI Codex CLI to xAI's Grok Build CLI.
- Talks to Grok over the Agent Client Protocol (`grok agent stdio`) instead of the Codex app-server protocol, so Grok reads the repository itself and its tool calls stream back live.
- `/grok:review` and `/grok:adversarial-review` run read-only, schema-constrained reviews. Read-only access is enforced by allowlisting the commands Grok is permitted to run, and the plugin asks Grok to re-emit its answer once if the structured output does not parse.

出典: [版の記録](https://github.com/1llum1n4t1s/KG.grok-plugin-cc/commit/008eb25e13d49d0324a8c14d5d4a157b434ee276) / [プラグインの詳細](plugins/grok/CHANGELOG.md)。
