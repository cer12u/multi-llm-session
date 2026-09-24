# 実装状況と未実証事項

更新日：2026-09-24。全体の受け入れ管理は Issue #4。実装、結合試験、実API適合、会話品質は別に判定します。Issue数やテスト件数から完成率は算出しません。

## mainと作業ブランチ

PR #3、#31（#5）、#32（#6/#8）、#33（#7）、#34（#14/#21）、#37（#24）、#35（#17）、#39（#18）、#40（#22）、#38（#9/#10）、#36（#15/#16）、#41（#11）はmainへマージ済みです。PR #36のマージは `edc93796ecd6e3f3c07c002c1cf765b371498e0b`、PR #41は `b39437bba069b2a0bed191c4bdfde3d6b6977691`。

管理API未登録・画面未結合、記憶パッチが作業領域のみという以前の記録は、現在のmainには当てはまりません。Provider管理の画面/API/CLIと、V6記憶・想起・要求予算は結合済みです。PR #41は宛先と質問解釈を分け、未解決・一部回答・確認待ち等の認識を各Agentの私有状態に接続しました。

本PR #42は候補の再構成による分割reviewの継続性と、人格・モデル・参加者の整合性を追加します。ブランチ実装、最終headのCI通過、マージは別です。現在の合否・head・マージSHAはPR #42に記録し、途中の合格を流用しません。

外部deploy、有料モデル呼出し、registry公開は行っていません。通常CIは合成データのみ・GitHubへの書込み権限なしです。

## 要件ごとの現在地

| 範囲 | 実装・制御試験の範囲 | 残る判定・Issue |
|---|---|---|
| #5 私有状態 | 沈黙・保留時の原子的保存、世代・所有者・version・根拠・再送・再起動 | 実LLMの状態選択・活用の質は #28 |
| #6 個別Agentループ | 連続観測、保留中observe、本人状態の循環、3/5/8 WorkerのHTTP結合 | 自然な理解・相互作用は #28、資料の版・対象管理は #20 |
| #7 本人の予定 | 永続one-shot予定、変更・撤回・再起動・重複防止・根拠失効・予算 | 関連話題照合は語彙ベース。話題選択品質は #28 |
| #8 記憶バックログ | 観測と別cursor、凍結target、区間receipt、根拠version、最古からの分割・公平割当て | 無制限入力への追従保証ではない。長時間負荷は #29 |
| #9 記憶・訂正・競合 | PR #38で所有者・対象・時点・epistemic区分、add/merge/correct/conflict、旧履歴、派生メモ・状態への失効伝播を実結果処理へ接続 | 意味・正規化キー・別名はモデルの解釈。真実・意味の正しさを独立証明しない |
| #10 想起・入力予算 | PR #38で別名・人物・時間の交換可能検索、原文付き自動想起、request/schema/output予算、LOOKUP余裕と明示失敗、検索比較指標 | UTF-8保守推定でtokenizer不明。時間・人物解釈は限定的。実会話品質は #28 |
| #11 質問・複数話題 | PR #41で明示/推定宛先、本人の未解決/部分回答/確認待ち/解決/保留、根拠version、非排他的話題、三者HTTP参加、復旧を検査 | 自然言語の質問抽出・解決判定の正確さは #28 |
| #12 候補整合性 | PR #42で部分KEEPを拒否し候補全文を次chunkへ保持。人格/モデル/参加者照合、旧LOOKUP再結合拒否、5倍遅延・割込み・再起動・推論中HTTP入力を検査 | 最終headの合否はPR参照。意味の保持品質は #28、無限更新下の発言保証ではない |
| #13 会話継続・反復 | 本人の発言/保留/沈黙、任意話題と非強制応答の基本制御 | 内容ループの区別・反復抑制・実会話読解は未完了 |
| #14 キャラクター管理 | 通常フォーム、版・詳細・検証・import/export、固定版表示、HTTP/Chromium | 既存sessionへの新persona適用は #19、人格再現品質は #28 |
| #15 Provider管理 | PR #36で版付き設定フォーム・カタログ・実送信先/固定版表示、API/JSON/token/temperature/usage宣言、三者別合成HTTP配送を実アプリへ結合 | 実サービス適合は #27、既存sessionへの明示的差替えは #19 |
| #16 復旧 | 沈黙/観測/記憶/待機/通信障害/認証/予算を区別。UI/CLIからAgent再試行・固定版scopeの単一probe。旧run失効と遠隔実行枠保持 | 遠隔推論の取消保証ではない。長時間評価は #29 |
| #17 全履歴UI | history/search/threadページ、原文リンク、読み位置、1,205原文/270検索/241返信。欠落区間・削除再確認・世代付き再接続 | 一定DOM/メモリ量の保証ではない。閲覧は推論起動条件にしない |
| #18 下書き | IndexedDB、送信前の不変payload/key、結果照合・再送、版競合、logout/破棄競合、IME | 一運用者の端末内保存。同期・暗号化・フォレンジック消去は含まない |
| #19〜#20 session/source | lifecycle、episode、公開返信、手動資料、設定済みfeed | 参加者・設定適用、資料版/対象管理は未完了 |
| #21 表示交換 | CharacterProvider/PresentationAdapter、公開DTO、重複排除、非同期隔離、文字fallback | 外部renderer自体は初期必須範囲外 |
| #22 配布 | 構成生成、版付きAPP_CONFIG、Worker別file-secret、Core専用DB、loopback、非rootの共有/異種3体HTTP試験 | 実Providerは #27、配置先deployは別許可。既定mockを維持 |
| #23 診断・再生 | run/trace、cursor、agenda、記憶履歴、想起指標、Provider運用状況 | 因果追跡、public/private exportとreplayの横断結合は未完了 |
| #24 保存・復旧 | online backup、別パスrestore、inspect、移行/容量失敗・実プロセス停止、V6移行/復旧 | 次schemaも同時に試験拡張。実電源断・全filesystem・24時間安定保証ではない |
| #25 権限 | ACL/Host/Origin/CSRF、所有者隔離、管理API・表示DTO・復旧権限の個別検査 | 全経路横断の権限・消去・export受け入れは残る |
| #26 検証 | read-only CI、合成HTTP Worker、3/5/8プロセス、Chromium、Compose、要件由来の回帰 | 全要件の状態機械・障害・UI試験完備という判定ではない |
| #27〜#30 実測・完成判定 | live opt-inと通常CIを分離し、制御証拠と実測を分ける | 実Provider、会話読解、予算/soak、全仕様・成果物対応は未完了 |

## 検証の所在

| PR | 確認済み履歴 / 対応文書 |
|---|---|
| #31 | Actions 35561187577、110テスト。AGENT_PRIVATE_STATE.md |
| #32 | Actions 35566152494、131テスト。AGENT_LOOP.md |
| #33 | Actions 35574429773、149テスト。本人予定・再開・撤回・失効 |
| #34 | Actions 35582111134、158テスト。CHARACTERS_AND_PRESENTATION.md |
| #37 | Actions 35587592577、176テスト。STORAGE_RECOVERY.md |
| #35 | Actions 35600336635、183テスト。ARCHIVE_NAVIGATION.md |
| #39 | Actions 35606783854、192テスト。DURABLE_DRAFTS.md |
| #40 | Actions 35611884468 / 35611884501、205テスト。MULTIPROVIDER_DEPLOYMENT.md |
| #38 | head 1f95d843b2caa42fc21fe9b901bd76677c03fb7b、Actions 35987906241 / 35987906255、47ファイル229テスト、全必須job成功。MEMORY_PROVENANCE_AND_RECALL.md |
| #36 | head 9a334d8c4d1590fbadb7b1dbf87b672099fb4ea4、Actions 35989522788 / 35989522767、53ファイル255テスト、全必須job成功。PROVIDER_MANAGEMENT.md |
| #41 | head 25ac96eefcbe9a39565c35665f6fa61a802e31f1、Actions 35995273138 / 35995269556、56ファイル263テスト、全必須job成功。CONVERSATION_UNDERSTANDING.md |
| #42 | 最終head/CIはPR記録。CANDIDATE_REVIEW.md、R4-REVIEW-000〜008、既存200件差分確認。旧部分KEEPの試験アクションは新契約に更新し、網羅・未確認非公開のassertionを維持 |

CI成否はcheck metadataと生成された合成要約から確認します。元のActions全ログやartifact実体を取得済みとはしません。診断表示jobの成功を失敗したverifyの代わりに使いません。通常verifyは型検査・テスト・build・schema・複数Worker lab・Chromiumを含みます。

## 運用上の境界

同時RUNNING上限1、3〜16参加者、単一運用者と共有閲覧トークンの非公開ラボです。公開マルチテナント/SSO、HA、外部キャラクター描画、Slack/Discord、汎用ブラウザー/シェル、sessionをまたぐ私有経験共有は必須範囲に追加しません。

原文保存とモデル入力上限を分け、再処理も既存予算を消費します。予算は自動拡張しません。資料は現在1600文字の明示excerptです。公開削除は現在の検索/引用からの除去で、私有journal・旧run・backupの完全消去ではありません。更新前backupと対応旧binaryによるrollbackを使い、DBを自動置換しません。

profileは鍵の参照名のみを保存します。Coreの存在確認は別Workerへの鍵配置確認の代用ではありません。設定保存・表示・再読込みだけでは推論せず、retryも終了・予算停止を解除しません。

実API適合・自然な会話・長時間運用には別の実測が必要です。Provider/API・モデルID・URL・安全なSecret参照と回数/出力/時間/費用上限なしに有料実行しません。この不足を鍵不要の実装・合成試験を止める理由にはしません。
