# opop 検証記録（2026-10-01）

対象はこのリポジトリの配布ランタイム。実アカウントへ接続せず、fake Grok と実際の companion / broker プロセスで検証する。

## 変更前に列挙した失敗

- inline option の値に `=` を含むと、プロンプトファイルのパスやモデル ID が途中で切れる。
- 終了済み履歴が増えると、queued / running / 停止保留の記録と成果物が削除され、再キャンセルできなくなる。
- キャンセル中にログだけを書けなくなると、プロセス照合・停止・状態確定まで中断する。
- broker が長時間 prompt を待つと、同じ受信チャンク内のキャンセルや逆リクエスト応答も待たされる。後続チャンクとの再入で途中の JSON が破損する可能性もある。
- 同じソケットのキャンセルが先に完了しても、prompt の占有は保持し、他ソケットの実行要求を拒否する必要がある。
- setup の認証確認が可用性確認を含むため、同じ起動 probe を二重実行する。

## 再現コマンド

```powershell
node --test tests/maintenance-e2e.test.mjs tests/broker.test.mjs
pnpm test
pnpm build
pnpm check-version
git diff --check
```

## 実行環境・台帳

- Windows / Node.js v24.18.0（`C:\Program Files\Volta\node.exe`）/ pnpm 11.26.0。
- cwd: `C:\Users\IMT\dev\KG.grok-plugin-cc`。配布バージョンは1.0.21のまま。
- 基礎検証: `pnpm test` exit 0、175件中174成功・1スキップ・失敗0、512.091秒。
- 基礎型検査: `pnpm build` exit 0、1.857秒。`pnpm check-version` exit 0、1.520秒。
- 追加E2E変更前: maintenanceの4件は全失敗。ENOENT（`=`でパス切断）、停止保留の脱落、EISDIRによるキャンセル中断、setup probe各2回を実プロセスで観測。
- brokerの初回検証はfakeの起動証拠がなく不採用。PATHにもfakeを配置した再現で、結合キャンセルの停止と、別接続の逆応答を拒否・通知しない問題を確認した。
- 追加E2E変更後: 6件すべて成功、42.687秒。続くbroker2件の強化検証も成功、0.693秒。
- 強化したbroker検証では、`GROK_BIN`に指定したfakeとPATH上の別fakeを分離し、前者だけが起動することを確認。同じ接続の通常RPCがpromptより先に完了しても、他接続のBUSYを維持することも確認。
- 新規E2Eはプロセスと実ソケットで検証する。ユニットテストは追加していない。
- 独立レビューは成立した指摘なし。全体テスト・型検査の二重実行はしていない。

## 採用した改善と効果

| 対象 | 変更前 → 変更後 | 観測 |
| --- | --- | --- |
| args | inline値を`split("=", 2)` → 最初の`=`だけで分離 | `=`・空白を含むprompt-fileパス、`=`を含むモデルIDがACPと保存結果まで保持される |
| state | 新旧・状態を問わず50件 → 終了済み50件とactive/pending全件 | 終了履歴50件がある状態で新しいtaskを完了しても、queued/running/pendingのJSONとログを保持し、pendingを同じIDでcancelできる |
| cancel | 補助ログ障害で中断 → 警告を返して停止と状態確定を続行 | ログ先をディレクトリにしても実際のheld taskが終了し、pid=null、terminationPending=false、警告を保存・返却 |
| broker | 受信loop内でRPC完了待ち → 同期フレーム分離と非同期dispatch | 同一チャンクのprompt/cancel、分割フレーム、逆要求応答、接続元照合、同一接続の複数RPCと占有保持を実ソケットで確認 |
| broker起動 | GROK_BIN指定を無視 → 子プロセス起動へ引継ぎ | PATH上の別fakeが起動しない |
| setup | 事前確認を二重取得 → 認証確認のavailabilityを再用 | `--version`と`agent stdio --help`が各2回→各1回。起動4回→2回。実行時間の比較は未計測 |
| 未使用コード | 汎用helper4関数と旧native rendererが残存 → 削除 | 配布実装・入口・tests・文書に定義以外の参照なし。未追跡の旧検証コピーは変更していない |
| 重複テスト | 保存済みrender優先・stop-gate wrapperの単体2件 → 削除 | runtime E2Eのreview→result、および権限拒否→ALLOW→resultで同じ挙動を検証 |

## 観点・担当の確定

| 観点 | 担当 | 判定 |
| --- | --- | --- |
| Modernizer | 親 | 証拠不足。配布依存はなく、開発依存更新やAPI置換を採用する根拠なし。検証helperの既存DEP0190警告は本体改善と独立で保留 |
| Normalizer | 親 | 改善を採用。brokerのGROK_BIN指定を事前確認・直接起動と統一 |
| Performance | analyst performance_async | 改善を採用。setup probe重複を除去 |
| Cleaner | analyst cleaner_tester | 改善を採用。未参照helperと旧rendererを削除 |
| Hardening | analyst hardening・親 | 改善を採用。inline値、停止記録保持、ログ失敗経路、逆応答の接続元照合 |
| Tester | analyst cleaner_tester・performance_async・親 | 改善を採用。低価値2件削除と実プロセスE2E6件追加。OS間パスの単体テストはnative E2Eでは見逃すため保持 |
| Async | analyst performance_async・親 | 改善を採用。受信再入・キャンセル待ちと占有寿命を修正 |
| Startup | analyst performance_async | 現状が最適。開発依存だけで配布bundleなし。起動初期化の変更を正当化する負荷証拠なし |
| Intel | 親 | 非該当。採用判定に現在の外部仕様への照会は不要で、外部資料を判断に使用していない |

調査3担当の要求プロファイルと役割定義の実効設定はanalyst / gpt-6.1-sol / medium。
独立レビューはreviewer / gpt-6-astra / xhigh。実行ツールから内部のモデル実行テレメトリは返されない。
親だけが実装を所有し、全担当にGit操作・外部書込み・シークレット取得禁止を引き継いだ。
2026-09-24の同リポジトリのメモリ（`75751358-f083-4093-8b58-e743f7f0888d`）は歴史情報として現在のコードと照合し、当時の検証数やモデル設定を今回の実測として使っていない。

## 未採用・検証の限界

- 巨大な未改行JSONLのfragment buffering: 局所測定では利益があるが、通常の製品経路の負荷証拠がない。今回のbroker修正は走査開始位置をACP clientと揃える範囲に限定し、完全な線形化はしていない。
- Windows CIM照会の外部コマンドtimeout: 無期限待ちの可能性は静的に確認したが、実CIMハングは未再現。期限の選定・実環境検証が必要なため保留。
- test helperの恒常的な一時物清掃: 全fixtureに影響する変更は未採用。今回の最終テストはリポジトリ外の専用TEMPへ隔離した。
- 実Grokによる完了、Unixソケット、切断後の遅延逆要求は未検証。配布済みインストールは更新していない。

## 一時物・残作業

初回基礎テストが作成した275ディレクトリ、そのworkspaceに対応する独立stateディレクトリ14件と、追加・最終検証の隔離TEMP（直下289ディレクトリ）を保持。
削除前に絶対パス、作成時間、実行中プロセスなし、reparse point（1件）のリンク先を確認した。
一括の`Remove-Item -LiteralPath -Recurse`と、検証済みの絶対パス1件を明示した同コマンドは、どちらも自動承認レビューで`blocked by policy`として拒否された。この2コマンドでは削除は実行されていない。別手段で回避していない。
最終確認では、保持した全対象に対応するNode/Grokプロセスは0件。新規E2E自身のteardownは通常経路で作成物を清掃したが、全体テストの既存fixtureと初回broker検証の清掃失敗分は上記へ残っている。

対象の絶対パス・用途・削除条件は[一時物台帳](opop-temp-paths-2026-10-01.txt)に保存。
既存の`.rescue-command-verification/`と`.rescue-fetch-verification/README.md`は保持。
変更は未ステージ。commit / push / releaseは行っていない。

## 最終全体検証

| コマンド | 結果 | 所要時間 |
| --- | --- | --- |
| `pnpm test` | exit 0、179件中178成功・1スキップ・失敗0 | 430.172秒（Node runner 428.551秒） |
| `pnpm build` | exit 0 | 1.472秒 |
| `pnpm check-version` | exit 0、全manifestは1.0.21で一致 | 1.320秒 |
| `git diff --check` | exit 0 | 未計測 |
| `node --check`（companion / broker） | 両方exit 0 | 未計測 |

基礎検証から新しい失敗なし。基礎検証と最終検証の経過時間差は、テスト内容と並行負荷が異なるため製品の性能改善値として扱わない。
全体テストの生ログは[final-test.tap](C:/Users/IMT/AppData/Local/Temp/kg-opop-20261001-80ee1306310147bbaa7485b8db4d8054/final-test.tap)に保持。
残作業は、自動承認レビューに拒否された一時物の清掃。採用分の実装・ローカル検証は完了。
