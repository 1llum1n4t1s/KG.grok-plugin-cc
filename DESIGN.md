# システム設計

## 目的と境界

Claude Code と Codex から、ローカルにインストールされた Grok Build を使ってレビュー、全体監査、X 検索、タスク委任を実行する。利用者向けの入口と設定は [README.md](README.md)、開発時の検証手順は [AGENTS.md](AGENTS.md) を参照する。

プラグインは Grok Build のインストールや認証サービスを提供せず、既存 CLI を子プロセスとして起動する。モデル実行と外部サービスへのアクセスは Grok Build が担う。`../vps-web/lp/grok-plugin/` はVPSから配信する紹介ページであり、ジョブのバックエンドではない。`/` と `/index.html` に HTML を返し、その他のパスは 404 にする。

## 主要コンポーネント

| 場所 | 責務 |
| --- | --- |
| `plugins/grok/commands/`、`agents/`、`claude-skills/`、`skills/` | Claude Code のコマンド・subagent・内部 helper と、Codex の公開 skill。ホストごとの呼び出し手順、プロンプトの組み立て方、結果の提示契約を分離する |
| `scripts/grok-companion.mjs` | 引数解釈、レビュー・タスクの実行、ジョブ作成、status/result/cancel/setup の統一入口 |
| `scripts/lib/git.mjs`、`prompts.mjs`、`render.mjs`、`text.mjs`、`prompts/`、`schemas/` | 対象とコンテキストの収集、プロンプト、構造化出力の検証・表示、共通の文字列短縮 |
| `scripts/lib/grok.mjs`、`acp.mjs` | Grok CLI と ACP セッション、権限応答、モデル指定、進捗の受信 |
| `scripts/lib/jsonl.mjs` | ACP クライアントとブローカーの受信ストリームに共通の JSONL フレーム分離 |
| `scripts/acp-broker.mjs`、`lib/broker-*.mjs` | Grok プロセスの再利用、接続とライフサイクル、JSON-RPC の中継 |
| `scripts/lib/state.mjs`、`tracked-jobs.mjs`、`job-control.mjs` | 状態・成果物の永続化、ジョブ追跡、所有権と停止処理 |
| `hooks/hooks.json` と二つの `scripts/*hook.mjs` | セッション開始・終了、ターンの基準状態記録、任意の終了時レビューゲート |
| `tests/` | fake Grok を使うランタイム検証、権限・状態・フック・両ホスト併用の回帰検証 |

表内の `scripts/`、`prompts/`、`schemas/` は `plugins/grok/` 配下を指す。

Claude の manifest は `skills` に `./claude-skills/`、Codex の manifest は `./skills/` を指定する。Claude 専用 helper の `user-invocable: false` だけに依存せず探索先も分けることで、内部 helper が Codex の公開スキル一覧へ露出するのを防ぐ。Claude の rescue subagent は helper 名で参照し、Codex には `source-command-*` の公開ワークフローだけを配置する。

## データフローと設計判断

1. ホストのコマンドまたはスキルが、対象リポジトリを作業ディレクトリとして companion を前景実行する。Codex は `--json` で完了時にまとめて結果を受け取り、詳細進捗はジョブログへ保存する。これによりジョブ ID、完了、結果取得を一つの実行経路で扱う。
2. companion が対象とプロンプトを作成し、ジョブを登録して ACP で `grok agent stdio` に依頼する。監査は差分やファイル本文を事前に埋め込まず、ファイル一覧から Grok が調査対象を選ぶ。
3. ブローカーは Unix ソケットまたは Windows 名前付きパイプを介して Grok プロセスを再利用し、起動コストを抑える。通常の要求を占有クライアントへ結び付け、同じ接続の通常要求がすべて完了するまで占有を維持する。JSONL のフレーム分離中には RPC 完了を待たず、キャンセルは同じ接続・別接続からも扱い、通常要求の占有を解除しない。権限やファイル操作の逆リクエストとセッション通知は、実行中のセッションと接続が一致する呼び出し元へ転送し、応答の接続元も照合する。実行中に接続を失ったセッションへはキャンセルを送り、実際の終了応答まで応答待ちと占有を維持する。遅延要求と再開後の要求を区別できないため、そのセッションは当該ブローカー内で失効させる。失効セッションの再開は拒否し、直接起動への切替で迂回しない。同一 broker 世代で terminal を確認済みのセッションだけ再利用する。起動時には `GROK_BIN` の指定を引き継ぐ。新規セッションは接続失敗時に起動受付条件を満たす場合だけ直接起動へフォールバックできるが、再開時は既存 broker 以外へ切り替えない。

POSIX の broker socket は UTF-8 の絶対パスが 104 bytes 以下なら既存の `broker.sock`、超過する場合は同じ一時 sessionDir 内の `b` を使う。`b` でも超過するときは sessionDir・pending・子プロセスを作る前に拒否する。旧 `broker.sock` の endpoint は引き続き完全一致で cleanup を許可し、切断名や未知の entry、link は回収しない。

broker の新規世代起動は admission journal に pending→spawned→settled→confirmed を追記・同期保存して制御する。Windows と macOS では `broker-v2/broker-admission.jsonl`、Linux では `broker-v3/<epoch>` に置く。settled は単独では pending を解除せず、同 generation・PID・outcome に対応する完全な confirmed 行を検証して初めて確定する。confirmed の完全行は、先行する settled の write/fsync/close と必要な directory 同期が成功して戻った経路の証拠であり、電源断時の物理的耐久性を保証するものではない。v1 journal は同期確認の契約がないため、保全して自動移行せず拒否する。pending が残る、記録が破損・不正・切断している、または容量が不足する場合は明示エラーにし、新しい broker や direct agent の起動へ迂回しない。保存済み broker が世代を確認できない場合や記録が不正な場合も保持して拒否する。journal 不在で起動 lock が残る場合も判断不能として lock を保持し拒否する。認証方式の不一致や、確定済み journal がある孤立起動 lock で直接起動へ切り替わる経路とは区別する。journal は追記専用で上限 4 MiB、pending 追加時には後続3記録分を予約するため、通常の長期利用でも上限未満で新規世代を拒否し得る。自動 rotation/compaction や不明世代の自動回復は実装しない。Windows と macOS には admission 記録を保全して再開する組み込み復旧機能もない。調査に必要な journal とログを保持する。

direct 起動と保存済み broker の通常採用は、broker pending 追加と同じ state mutex 内で記録を予約する。Windows と macOS では `direct-start-v1/<generation>.jsonl`、Linux では `direct-start-v2/<epoch>` に置く。broker pending 中は direct 起動を拒否し、未確認の direct 起動 marker がある間は新しい broker 世代を拒否する。複数の direct 起動自体は許容する。marker は pending→released→confirmed と同期し、ready、未起動、または所有 Job/group の停止証拠の確認後に回収する。保存済み broker の通常採用は、保存 session と journal の確定済み ready generation・PID・endpoint の一致も要求する。取消専用接続は新しい marker や代替プロセスを作らず、initialize と記録された generation/session/execution に一致する broker/cancelTurn だけを許可し、prompt を拒否する。子 broker は専用の継承 pipe の認可と state identity・永続化済み spawned generation/PID/endpoint を照合してから agent を起動し、listen 成功後に同じ pipe で nonce 付き ready ACK を返す。

親死亡・記録破損・I/O の成否不明では子・agent・supervisor が残存または遅延起動し得るため、PID の不在や記録の除去を停止証拠にせず、未確認の admission を保持する。明示的な offline 復旧には、全 runtime と遅延起動し得るプロセスの停止・再起動防止、他 host が同じ state を使用していないことの確認を要する。journal・marker・ログを保全し、state-lock の明示移行だけで起動の未確認状態が解消するとは扱わない。

追跡ジョブは接続準備前に state lock 内で `grokPromptState: starting` を保存し、prompt 送信前に `pending` と実行情報を保存する。送信は、最新のジョブ状態を再検査する state lock 内で同期的に enqueue し、応答は lock 外で待つ。起動や送信の成否が不明な場合は worker 終了後も termination-pending を維持する。現行 runtime は新規 stateDir を含め未移行の状態更新と lock 付き snapshot を拒否し、旧 file lock 経路へ戻さない。旧 runtime 自体には死者 lock の自動回復未対応と、所有者の確認・削除の間の置換競合が残るため、明示移行前に全旧 runtime を停止する。既存の旧 lock file は削除しない。

取消確定には worker の停止確認を要求する。接続準備前の `not-sent` を確認できるジョブを除き、broker ジョブでは実行 ID とセッション ID に対応する取消予約とターン終了の確認も要求し、通知の送信や worker の停止だけでは確定しない。direct ジョブは後述の協調停止証拠で確認する。必要な証拠のない旧ジョブは停止後も termination-pending に残り得る。この場合は結果公開とタスク再開を拒否し、再試行だけで回復できるとは保証しない。Windows の停止では taskkill /T を使わず、追跡 worker だけを対象に共有 broker を保護する。ブローカーは取消済み ID の後着 prompt を拒否する。取消記録が 4096 件に達し、さらに新たな取消を受けると、新たな prompt の受入れを停止し、新規接続は直接起動へ切り替える。旧ブローカーは実行 ID による取消を保証できないため直接起動へ切り替え、旧クライアントの世代なし取消は別世代のターンへ転送しない。

SessionEnd のジョブ清掃は全 OS で agent の停止証拠を先に要求し、その後 worker の終了と同一世代を再確認する。未確認・期限超過は terminationPending の記録を保持し、状態更新の lock を保持したまま owner の ACK を待たない。SessionEnd は接続と進行中の要求がないブローカーにだけ停止を予約する。停止要求の受付 ACK は終了完了ではない。通常 idle 清掃も Windows では同一 generation の agent Job が空である保存済み停止証拠と broker 終了、POSIX では所有 group の generation と group 不在を確認してから状態を回収する。broker PID 消滅だけでは清掃せず、未確認は記録を保持する。認証方式が異なる、到達できない、または所有世代を確認できないブローカーは停止せず、必要に応じて直接起動へ切り替える。所有不明の broker lock は安全に奪取できないため保持する。

4. 応答を検証してジョブ状態、ログ、結果を保存する。`status`、`result`、`cancel` は同じ追跡情報を参照する。

直接起動とブローカー経由の ACP クライアント、およびブローカーのクライアント接続は、共通の `JsonlFramer` で受信断片を保持し、改行が届いた行だけを連結する。巨大な一行を分割受信するたびに受信済み全体を連結し直すコストを避けるためである。閉鎖時は未完成の断片を解放し、以後の受信を処理しない。Grok またはブローカーから不正 JSON を受信した ACP クライアントは、保留中の要求を失敗させて接続を閉じ、同じ受信塊の後続フレームも処理しない。一方、ブローカーが呼び出し元から受け取った不正 JSON には JSON-RPC の parse error を返す。

状態保存先は `CLAUDE_PLUGIN_DATA`、次に `PLUGIN_DATA` を採用し、未設定時だけ OS の一時領域を使う。保存先の下をワークスペースの実パス由来のハッシュで分ける。同じ実装を両ホストで利用しつつ、各ホストの data ディレクトリが異なればジョブとゲート設定も独立する。状態更新はロックと一時ファイルからの rename を用い、破損 JSON は黙って初期化せずエラーにする。
状態更新と `withStateSnapshot` は、新規 stateDir でも明示移行済みの有効な protocol marker を必須とする。`loadState` 等の直接読取は残すが、transaction の一貫性や取消確定の証拠にはしない。対応 backend は Windows の NTFS ローカル固定 volume、macOS の local APFS、Linux の local ext4/tmpfs に限り、不明な FS・host や必須 utility 不在は fail closed とする。`state-lock migrate --offline-confirmed --local-only --expected-state-dir <absolute>` は明示操作で、自動移行しない。全 host の旧 runtime を停止し再起動しないこと、同期コピーを含め他 host が同時利用しないことは利用者の実行前提で、自動検出の保証ではない。host ID の照合は clone を含む host 一意性の証明ではない。旧 lock file・symbolic lock は拒否して削除せず、状態・ジョブ・barrier・prepared metadata を保持する。不完全な移行は旧 file lock へ戻さない。
手動移行はホストの実行時 workspace と環境変数の値・設定有無を再現して実行する。CLI の必須 `--expected-state-dir` は、対象ホストの未移行エラーの `State directory (data):` 行が表す実際の stateDir の絶対パスを指定する。未指定・相対パス・解決された保存先との不一致は作成前に拒否し、成功時は text/JSON の出力へ実効 stateDir を返す。`CLAUDE_PLUGIN_DATA` が `PLUGIN_DATA` より優先され、両方未設定なら OS の一時領域へ保存される。手動 shell の環境や workspace/TEMP がホストと異なっても、正しいホスト由来の expected を指定していれば保存先の不一致を拒否する。別の空 stateDir を移行するリスクは、その別保存先を誤って expected に入力した場合、または expected を要求しない旧 CLI を使う場合に残る。Claude Code と Codex は実際の保存先ごとに個別に移行し、別保存先での成功を既存データの移行完了と扱わない。
Windows / Linux で既存の通常 file の `state.lock` を拒否した場合の手動復旧では、最初に全 host の旧 runtime の停止・再起動禁止・他 host 不在を確認する。拒否に示された正確な絶対パスと通常 file であること、確認済み実パスのディレクトリ経路にも link/junction がないことを確認した場合だけ、同一ディレクトリ内の未使用名へ改名して保管する。削除・上書きはせず、symbolic/junction・ディレクトリ障壁・不明状態は処理しない。保管ファイルを残したまま同じ明示 migration を再実行して、元の `state.lock` パスへ新しい障壁を作る。CLI が自動で旧 file を回収・退避する機能は設けていない。
Windows の v2 native endpoint の対応範囲は NTFS ローカル固定 volume に限る。FAT/ReFS 等では dev + ino の rename 安定性・一意性を保証せず拒否し、ファイルシステムの判定不能時も拒否する。endpoint は canonical パス文字列ではなく state directory の volume 上の dev + ino で構成し、同一実体の alias・rename でも同じ排他となる。v2 移行 marker には実ディレクトリ handle から取得した NTFS 固定 volume の canonical GUID も保存し、以後の照合を必須とする。volume GUID の欠落・不正・不一致は、dev + ino が一致していても拒否する。identity 不明・0・marker が示すものと別実体の場合や旧 v1 marker は fail closed とし、自動置換しない。identity 検査と各 path I/O 間の差替えを阻止する handle 相対 I/O は未実装なので、全 runtime の稼働中は state directory と祖先の rename/replace/junction 変更を禁止する。同一 directory rename による mutex 分裂を防止する設計であり、全 I/O のパス固定まで保証するものではない。一方、`resolveStateDir` は元の workspace basename と実パスの hash を組み合わせるため、workspace を別名 junction 経由で開くと別 stateDir へ分岐する既存挙動が残り、移行では統合しない。MachineGuid が同じ clone や共有 host の有無も flags では検証できず、前提確認は利用者の責任とする。旧 file の削除や marker rollback は行わない。未移行状態への書込みは拒否するが、旧 runtime そのものの排他脆弱性を修復するものではない。Windows の排他は名前付きパイプを OS が解放するため、正常終了・異常終了後も barrier を削除して回収しない。
POSIX は恒久 `state.lock/native.lock` を使い、macOS は `posix-local-v3` marker、Linux は sentinel を持つ marker を使う。Linux は `/usr/bin/flock -x -n 3`、macOS は `/usr/bin/lockf -s -t 0 3` に検証済み FD を渡し、FD を保持して同期の critical section を実行する。同期 enqueue 後の応答 Promise は解放後に await でき、Promise を返す正規経路を禁止しない。FD close または runtime の正常・異常終了で kernel lock は解放され、年齢判定や lock file 削除は不要である。stateDir・barrier・native.lock・protocol.json は実行 UID 所有で private な permission、同じ dev と記録済み ino を要求する。marker は host・FS・各 identity を照合し、prepared-UUID.json も保持する。

macOS の v3 は新しい epoch と 256 slot の worker lease ledger を作る。旧 marker は自動更新せず拒否し、明示 offline 移行を必要とする。移行前には全 host の旧 runtime・broker・agent・worker・supervisor と遅延 spawn 可能なプロセスを停止し再起動を防ぐ。旧 writer の barrier だけでは旧 agent の遅延起動を防げない。移行 inventory は stateDir 直下の未知 entry、片側・不整合の job 記録、旧 admission などを拒否し、旧記録を空 ledger に降格しない。旧 state と job の JSON は各 64 MiB 以下の private な通常 file を要求する。旧 lock や barrier を stateDir 内の別名に保管すると未知 entry として拒否されるため、拒否時は記録を保全して調査する。これらの自動保管・汎用復旧は未実装である。

macOS の slot が満杯または不確定なら最大 16 slot・5 秒の sweep を試み、成功後に予約を 1 回再試行する。走査の時間切れは再予約せず失敗する。逆参照検査は state の job と jobs directory の entry をそれぞれ最大 4,096 件に制限する。未知・不整合・上限超過・worker lease や turn の停止証拠が未確認なら slot を回収せず、空きがなければ容量不足を返す。完了済みの記録でも両保存先の一致と停止証拠を照合し、推測で回収しない。

Linux の長寿命 sentinel は epoch の生存証拠であり、PID 再利用時にも別個体を旧世代と扱わない。同じ state を利用するプロセスは sentinel と同じ PID・time・network namespace と、対応する `/proc` view を必要とする。sentinel の停止・障害後は全 runtime と遅延起動し得るプロセスを停止して再起動を防ぎ、単一 host とリンクのない対象 barrier を確認して旧 barrier を未使用名へ保全し、明示 migrate で新 sentinel と epoch を作る。旧 admission が残る場合は有効な marker と稼働中 sentinel の下で `state-lock recover --offline-confirmed --local-only --all-old-processes-stopped --expected-state-dir <absolute>` を実行する。`stop-sentinel` 後も同じ復旧順序が必要である。復旧記録・旧ジョブ・既存 POSIX broker の socket、PID file、log を保全し、旧ターンの成功・失敗は推測しない。同 UID のプロセスが全証拠を消去した場合、外部正本なしでは新規状態と区別できず、改変に対する完全な保護ではない。
Linux の復旧 inventory は broker と direct の旧 epoch 合計 64 件、旧ファイル合計 64 MiB を超えると fail closed とし、そのまま明示 recover しても再開できない。安全な保全アーカイブ方式は未実装であり、旧記録を保持し、独立した保全方法なしに削除・変更しない。

Linux の FS 判定は statfs と `/proc/self/mountinfo` の同じ dev に対応する候補がすべて ext4 またはすべて tmpfs であることを要求し、host は読取可能で有効な `/etc/machine-id` から識別する。macOS は `/sbin/mount` の同じ dev に一致する候補すべてが local APFS であることを要求し、`/usr/sbin/ioreg` の IOPlatformUUID を host 正本とする。utility・host・mount 情報の欠落や不明、identity/marker 不一致は拒否し、自動上書きしない。
通常の fsync 成功を電源断時の物理的耐久性の実証とは扱わず、不完全な marker は保全する。Linux で st_dev が変化した場合や marker/移行が不完全な場合の復旧は、全 runtime の停止・旧版の再起動禁止・単一 host を最初に確認する。正確な state.lock が対象の directory barrier で、確認済み実パスの経路に link がない場合だけ、同じ stateDir 内の未使用別名へ barrier 全体を保管する。保管した旧 barrier と既存 state は削除せず、同じ host 環境・workspace・正しい expected-state-dir で明示再移行する。symbolic link や不明状態へは適用しない。通常 file の保管手順とは別の、Linux offline 復旧の手順である。
POSIX のパス確認では macOS の /var→/private/var のような既知の OS 標準 alias が報告パスの祖先にある場合、報告された stateDir と正確な state.lock を fs.realpathSync で解決し、実 lock の親と実 stateDir の一致、対象の host/workspace とリンクのない実パスを確認する。state.lock 自体は lstat で symbolic link でないことを要求し、junction・不明なリンクは保管しない。Linux の手動保管は確認済み実パスで行う一方、CLI の expected-state-dir はホストが報告した元の stateDir と同一 workspace・環境変数を維持し、解決後の別表記へ勝手に置き換えない。
全 OS で runtime 稼働中は、stateDir・祖先・native 管理 file（lock/marker/prepared）を別処理から変更・置換・削除せず、rename/mount/symlink/junction 等の namespace を変更しない。同 UID による state 改変を防ぐ sandbox ではなく、個々の path I/O を handle 相対で固定する保証もない。対応 FS と隔離した正常・競合・crash・拒否・offline 復旧の実機確認は、任意の FS や namespace 変更条件での動作保証へ拡張しない。
履歴の上限50件は終了済みジョブに適用し、queued / running / terminationPending の記録と成果物は保持する。キャンセル時の補助ログ書き込み失敗は警告として返し、プロセス照合・停止・状態確定を続ける。

新規 task の早期 `grokSessionId` は取消と進捗表示に使い、再開可能性の証明にはしない。`taskSessionResumable` は実行結果とセッション ID の terminal 保存が成功したときだけ true とし、取消や例外は false のまま保つ。保存済み状態だけでは再開を許可せず、対象セッションの terminal が再開を担う同一 broker 世代で確認済みの場合だけ許可する。broker 再起動後や direct 起動・旧版の履歴は、その確認を得られないため拒否する。外部 session/list の列挙結果や同じ ID の過去の成功履歴で、この条件を迂回しない。一覧の `sessionId` を正本、旧 `id` を互換として扱うことと、安全な再開の許可は別である。これは prompt の送信済み証明でもない。

Windows の worker は同じプロセスハンドルで高精度の開始識別子を照合して停止する。旧 CIM 識別子は照合不能として保留する。プロセス照会で開始識別子が同じでもコマンドが一致しなければ識別不能とし、元の個体が終了した根拠にはしない。開始識別子の相違は元の個体の終了を示す。POSIX の tracked worker は数値 PID/group への signal を送らず、所有 worker の協調処理後の自然終了を確認する。期限内に終了を確認できなければ保留を維持し、別プロセスからの PID 停止へ fallback しない。

Windows の direct agent は専用 supervisor が所有する Job Object に、`CreateProcess` の Job List 属性で最初の命令より前から所属させる。Windows 10 / Windows Server 2016 以降を必要とし、非対応時は起動前に失敗する。worker や共有 broker を Job に入れず、breakaway を許可しない。親の終了・制御接続の切断・close 要求ではこの Job だけを停止する。停止確認は同じ Job の `ActiveProcesses = 0` を検査した supervisor からの nonce 付き ACK に限り、supervisor の終了、PID の不在、別途収集した process snapshot では代用しない。起動・停止処理の失敗や ACK 欠落は未確認を維持する。direct `/cancel` は所有 worker の monitor に協調停止を要求する。実所有 worker は同じ Job の ACK、または close gate 後に spawn を一度も試みていない証拠を、同じ generation・owner PID・開始識別子を照合して job file と state index の両方へ保存する。呼出元は両保存先の証拠を確認し、state lock 内でも同一世代を再照合してから worker 停止と取消確定へ進む。旧ジョブ、ACK 保存前の worker 死亡、確認期限超過は terminationPending を維持し、期限超過時に所有 worker を先に殺さない。POSIX の direct agent はこの spawn の detached child/group を所有対象に固定し、その group だけへ SIGTERM を送る。実子の stdio drain 後の close と group の不在の両方を確認した `posix-group-empty` を停止証拠として保存する。直子 close だけでは確定せず、group 不在が未確認なら pending を維持する。group への停止 signal は所有直子の exit 前に一度だけ試み、直子終了後は group の不在確認だけを行う。子孫が残っていても再 signal せず、PID/PGID 再利用先を停止しない。別 session/group へ逃れた子孫の不在は保証せず、Windows Job の全子孫終了と同等ではない。通常 Node/libuv の reap と exit callback 配送、timer 内の同期 guard→signal を前提とし、独自 waitpid/setsid/setpgid を行う外部 native addon は保証範囲に含めない。
協調停止は Windows 実コマンド E2E（`tests/direct-cancel-owned-e2e.test.mjs`、`GROK_DIRECT_CANCEL_E2E=1`）で handshake 中・prompt 中・同時 cancel の3条件を確認した。利用者が指定した作業 root 内の隔離 fixture と明示移行済み state、fake Grok を使った結果であり、未移行 state の安全性や POSIX の停止経路の検証を示すものではない。参考測定として、同じ Windows 端末・Node.js 24・fake Grok で `node --test --test-name-pattern='^ACP (direct|broker):' tests/acp-transport-e2e.test.mjs` の13ケースを実行した合計は、supervisor 導入前の約4.82秒から導入後の約16.46秒になった。通信・fixture・プロセス起動を含む実測値であり、Job 単体のコストや個々の利用環境での速度を保証しない。

POSIX の broker 起動失敗時は、その起動の detached child/group だけを所有対象として停止し、process group の不在まで確認する。直子 exit だけでは同 group の agent が残り得るため、終了後の group 確認は観測専用とし、任意 PID や別 group への停止に切り替えない。別 session/group へ移った子孫の不在は保証しない。通常 Node/libuv の動作を前提とし、独自 waitpid/setsid/setpgid を行う外部 native addon は保証範囲外とする。

### プロセス照会診断

Windows のプロセス照会は `scripts/lib/process.mjs` が PowerShell / CIM を直接起動し、stdout の照会結果と stderr の段階記録を分離する。段階は `powershell-start`、`cim-start`、`cim-end`、`powershell-end` と、例外時の `error`。失敗した外部照会だけを `Process lookup diagnostic` 付きの JSON として stderr へ同期出力し、ジョブ開始・cancel・SessionEnd では `tracked-jobs.mjs` の callback を介して既存のジョブログにも追記する。成功した外部照会では出力しない。

診断には照会種別、対象・親・観測した PowerShell の PID、時刻・経過時間・制限時間、終了状態・signal・エラーコード、観測段階と取得できた HRESULT だけを記録する。stdout、生の stderr、コマンドライン、marker 値、プロセス開始キー、プロンプトは保存しない。callback の例外や閉じた stderr への書き込み失敗を捕捉し、診断の保存失敗で同一性判定・キャンセル結果を変えない。既存の照会時間予算と停止確認の契約も維持する。

`not-observed` は開始記録を観測できなかった意味であり、OS がプロセスを生成しなかった証拠にはしない。`cim-start` 以降にはモジュールの自動読込なども含まれるため、この段階だけで CIM provider の故障と断定しない。診断は停止箇所を絞る補助情報として扱い、照合不能を終了済みと判断する根拠には使わない。

## 重要な不変条件

- 読み取り専用の外部資料取得は、ACP の `kind: fetch` と `rawInput.variant: WebFetch` が一致する組み込み要求に限定する。入力は `variant` と認証情報を含まない HTTP(S) の `url` だけを許可し、権限は `allow_once` に限定する。表示名や読み取り専用の自己申告だけでは許可せず、未知ツール、追加引数、ファイル URL は拒否する。
- review、adversarial-review、audit、X 検索は読み取り専用で実行する。レビューの権限処理は、コマンド名に加えて引用・引数・パスも検査し、外部コマンド実行や書き込みにつながるシェル要求を拒否する。例外として PowerShell の `Test-Path -LiteralPath` は単一パスに限り、作業リポジトリを基点に絶対パスも解決し、実パスでリンク先を確認して領域内に収まる場合だけ許可する。存在しない末尾は既存の祖先まで遡って確認する。ACP のファイル書き込み要求もセッションの書き込み権限で判定し、読み取り専用セッションでは拒否と未完了の記録を残す。書き込み可能な委任タスクとは権限経路を分ける。
- Git の作業ツリー差分・状態確認は clean/process filter を実行し得るため、内部ラッパーは status と作業ツリー diff を spawn 前に拒否する。既定 auto と working-tree のレビュー、および stop fingerprint は代わりに Git の HEAD/index/属性メタデータと独立したファイル読取りから snapshot を作る。読取りは Windows のローカル固定ドライブに限定し、祖先と対象を同一 handle で検証・保持してリンク/reparse や共有違反を拒否する。二重読取りと前後のメタデータ照合が一致しなければ incomplete とする。他 OS、未対応の EOL/encoding/filter 属性・設定、unborn HEAD、sparse/unmerged index、submodule、バイナリや非 UTF-8 の変更、列挙・内容の容量超過は明示的に incomplete とし、Git の作業ツリー照会へ fallback しない。明示 branch/base と repo の経路は維持する。branch は固定 OID 間で比較し、raw mode の両側を検査して変更 gitlink があれば incomplete とする。子 Git の textconv 抑止を保証できないため --submodule=diff は拒否し、子内容の欠落を黙認しない。権限判定そのものは OS サンドボックスではない。
- snapshot の `core.filemode` は明示的な false を要求する。`core.autocrlf=true/input` の追跡ファイルでも raw blob OID が index OID と一致すれば clean とし、未変更の binary や index CRLF を拒否しない。一致しない場合は、未対応の制御文字を含まない有効な UTF-8 で LF のみまたは CRLF のみ、既存 index blob に CR がない範囲に限り、index 比較と unstaged patch 生成用のコピーを CRLF→LF に正規化する。混在改行・bare CR・binary/unsupported control content・index の CR/CRLF は変換対象なら fail closed とする。明示的な `-text`/`-crlf` は生のバイトを使う。これは Git clean の完全互換ではなく、未対応の属性・設定は引き続き拒否する。snapshot に保存する内容と fingerprint は raw bytes を保持し、基準からのターン差分にも正規化済みコピーを使わないため、改行だけの変更も失わない。
- review、adversarial-review、audit と終了時レビューゲートは、一つの Grok セッションで各観点を直接調査する。子エージェントの権限継承を保証できないため、委任の許可は追加しない。
- 構造化レビューは `incomplete` を未完了として扱う。権限拒否は JSON 再出力をまたいで保持し、モデルが `approve` を返しても有効な結果を `incomplete` にしてジョブを失敗とする。生の応答は診断用に保持し、不正形状の JSON は構造化結果として公開しない。終了時レビューゲートも権限拒否後や `end_turn` 以外での `ALLOW` では成功させない。`result` は構造化レビューと終了時レビューゲートの保存済み表示を優先し、未完了の説明を生の応答で置き換えない。これにより再表示でも承認との誤認を防ぐ。
- review、adversarial-review、audit では、初回ターンが `end_turn` で正常終了し、非空の最終応答の JSON 解析に失敗したときだけ、同じセッションで一度 JSON の再出力を要求する。再出力後は成否にかかわらず最新の本文・終了理由・エラーを採用し、思考サマリは初回のものを維持する。拒否やキャンセルなどで途中終了した本文は JSON 修復へ送らず、終了理由と権限拒否を表示する。初回と再出力のいずれも `end_turn` 以外は、本文が有効な JSON でも未完了とし、未知の終了理由を完了扱いにしない。
- レビューの構造化出力が解析または形状検証に失敗した場合は、Grok 側が実行完了でもジョブを失敗として扱う。結果の `grok.status` と `grok.stopReason` は Grok の最新ターンの状態を表し、ジョブの成功判定とは区別する。レビューゲートの成功判定へ壊れた結果を渡さない。
- Grok 実行は前景に統一する。レビュー・監査・タスク実行の互換用 `--wait` は no-op、`--background` はエラーにする。`status <job-id> --wait` は対象ジョブの終了を待つための独立した指定として維持する。
- 終了時レビューゲートは既定で無効。`UserPromptSubmit` の基準 snapshot と有効時の Stop の snapshot を比較し、変更のないターンでは新たなレビューを起動しない。レビュー対象は基準からのターン差分とし、基準以前の dirty 内容を再レビューしない。基準は圧縮して Windows DPAPI CurrentUser で保護し、実ワークスペース・session・turn key・capture nonce・取得時刻を照合する。state lock 内で現在の nonce を確認して更新し、新しいターンの状態を上書きしない。基準の欠落・復号/照合失敗・容量超過や snapshot 取得失敗時は Grok の probe と起動に進む前に block を返し、変更なしやレビュー済みとは扱わない。基準を作れなかった場合は新しいユーザーターンで取得し直す。繰り返す Stop でも取得不能のまま追加レビューを起動しない。
- フックは Node.js 内でホストの環境変数からパスを解決する。シェルごとの変数展開へ依存せず、同じ4イベントのフックを両ホストで使用する。
- セッション終了やキャンセルは追跡された所有関係に従う。ジョブを実行中として登録する前にプロセス開始識別子の取得を短時間再試行し、取得できなければ実行を開始せず実行中へ遷移させない。worker の確認には PID・開始識別子・companion のコマンドラインを照合する。Windows の停止は同じ process handle で行い、POSIX は照合後の数値 PID への停止を避けて自然終了を待つ。照合不能や停止未確認ならキャンセルを保留してジョブ記録を残し、同じ ID で再試行できるようにする。停止要求が失敗しても終了を確認できればキャンセルを確定する。プロセス情報の照会が再試行後も失敗した場合、Linux では `/proc/<pid>/stat` の PID・開始 tick の形式を確認でき、状態が `Z`（ゾンビ）または `X`（終了）なら、PID が残っていても処理を続けられないため停止済みと判定する。読み取り失敗や不正な形式だけを終了の根拠にはしない。保留中のジョブは status で稼働中として扱い、result やタスク再開の対象にしない。セッション終了時も停止を確認できないジョブ記録を保持する。両ホストの保存先が独立する構成では、一方の終了が他方のジョブやブローカー状態を消さない。
- 外部プロセスの照会は単発3秒、同一性照合全体は3秒、終了待ち全体は5秒の時間予算を使い、再試行や複数の `ps` 呼び出しに残時間を渡す。時間切れを終了の根拠にせず、照合不能・停止未確認として扱う。ジョブ開始時の照会は既存の最大3回を維持し、各回を3秒で制限する。これらの予算は照会と待機に適用し、プロセス停止コマンド自体の所要時間を含まない。
- ACP のクライアントバージョンは配布内の `.codex-plugin/plugin.json` から取得する。ホストごとの manifest を同じバージョンに保つことで共通ランタイムの識別情報をそろえる。

## 製品ページの配信先

製品ページの配信HTMLは `../vps-web/lp/grok-plugin/`（編集元は `../vps-web/tools/lp/templates/`）、公開実体はVPSの `/srv/www/lp/grok-plugin/`。
直接配信の設定は `../vps-web/deploy/caddy-sites/lp-grok-plugin.caddy` に置く。
公開URLを維持し、静的ファイルの配信は `vps-web/deploy/deploy-lp.ps1` へ統一する。
