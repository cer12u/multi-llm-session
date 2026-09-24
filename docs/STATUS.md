# 実装状況と未実証事項

更新日：2026-09-24。全体の受け入れ管理はIssue #4。実装、結合試験、実API適合、会話品質を別に判定します。Issue数やテスト件数を完成率とはしません。

## mainと作業ブランチ

PR #3、#31（#5）、#32（#6/#8）、#33（#7）、#34（#14/#21）、#37（#24）、#35（#17）、#39（#18）、#40（#22）、#38（#9/#10）、#36（#15/#16）、#41（#11）、#42（#12）、#43（#13の制御部分）はmainへマージ済みです。本作業の基準mainは `6dce598ed47f193b0252d22c979cfb1b8a9f2a2f`。#13は人による読解・実モデル評価が未実施のためOPENを維持しています。

PR #44は#19の参加者変更・明示的な人格/モデル版適用・退出者の所有状態保持・発言時作者情報・episode時刻/範囲・定義のみ複製を、実際のSessionService、API、CLI、通常フォームへ接続します。V7移行と投入済みDBの復旧試験も含みます。ブランチ実装、最終headのCI通過、mainへのマージを区別し、現在のhead・合否・マージSHAはPR #44に記録します。

外部deploy、有料モデル呼出し、registry公開は実施していません。通常CIは合成データのみ、GitHubへの書込み権限なしです。

## 要件ごとの現在地

| 範囲 | 実装・制御試験の範囲 | 残る判定・Issue |
|---|---|---|
| #5 私有状態 | 沈黙/保留時の原子的保存、世代・所有者・version・根拠・再送・再起動 | 実LLMの状態選択と活用の質は#28 |
| #6 個別Agentループ | 連続観測、保留中observe、本人状態の循環、3/5/8 Worker結合 | 自然な理解は#28、資料版/対象管理は#20 |
| #7 本人の予定 | 永続one-shot、変更/撤回/再起動/重複防止/根拠失効/予算 | 関連話題照合は語彙ベース、話題選択の質は#28 |
| #8 記憶バックログ | 別cursor、凍結target、区間receipt、根拠version、最古分割/公平割当て | 無制限入力追従は保証しない、長時間負荷は#29 |
| #9 記憶・訂正・競合 | 所有者/対象/時点/epistemic、add/merge/correct/conflict、旧履歴、派生失効 | 意味/正規化キー/別名はモデル解釈で、真実を独立証明しない |
| #10 想起・入力予算 | 別名/人物/時間の交換可能検索、原文付き想起、request/schema/output予算、LOOKUP余裕と明示失敗 | 保守UTF-8推定でtokenizer不明、実会話取得品質は#28 |
| #11 質問・複数話題 | 本人ごとの明示/推定宛先、未解決/部分回答/確認待ち等、根拠version、非排他的話題、三者HTTP/復旧 | 自然言語の解釈精度は#28 |
| #12 候補整合性 | 分割reviewの候補再構成、人格/モデル/参加者照合、旧LOOKUP再結合拒否、5倍合成遅延/割込み/再起動/推論中HTTP | 意味保持の質は#28、無限更新下の投稿保証ではない |
| #13 継続・反復 | PR #43で本人の公開目的フィードバック、助言的反復信号、根拠付き本人判断、自然休止/障害/予算との区別 | 人の読解・実LLM評価は未実施、#13/#28は未完了 |
| #14 キャラクター管理 | 通常フォーム、版/詳細/検証/import/export、固定版表示 | 既存session適用はPR #44、人格品質は#28 |
| #15 Provider管理 | 設定フォーム/API/CLI、固定版/最新/送信先、API/JSON/token/temperature/usage宣言、三者HTTP | 実サービス適合は#27、明示差替えはPR #44 |
| #16 復旧 | 沈黙/観測/記憶/待機/障害/認証/予算の区別、単一probe/再試行、旧run失効、遠隔実行枠保持 | 遠隔推論の取消保証ではない、長時間評価は#29 |
| #17 全履歴UI | ページ取得、原文リンク、読み位置、1,205原文/270検索/241返信、欠落/削除/再接続 | 一定DOM量の保証ではない、閲覧は推論条件にしない |
| #18 下書き | IndexedDB、不変payload/key、結果照合/再送、版競合、logout/破棄競合、IME | 一運用者の端末内保存。同期/暗号化/完全消去は含まない |
| #19 セッション継続 | PR #44でepoch付き参加者変更、保持/退出/新個体分離、発言時作者、episode範囲、定義のみclone、API/UI/CLIとV7移行/復旧 | 最終headの合否とマージはPR #44参照。跨session私有経験共有はしない |
| #20 資料・フィード | 手動資料と設定済みfeedの基本入力 | 版/対象管理・完全取得・安全な失効/再開との結合は未完了 |
| #21 表示交換 | CharacterProvider/PresentationAdapter、公開DTO、重複排除、非同期隔離、文字fallback | 外部renderer自体は初期必須外 |
| #22 配布 | 構成生成、版付き設定、Worker別file-secret、Core専用DB、非root共有/異種3体HTTP | 実Providerは#27、実deployは別許可 |
| #23 診断・再生 | run/trace、cursor/agenda、記憶履歴/想起指標/Provider運用状況 | 因果追跡、public/private export、replayの横断結合は未完了 |
| #24 保存・復旧 | online backup、別パスrestore、CLI、移行/容量失敗/実停止、PR #44でV7まで拡張 | 実電源断・全filesystem・24時間保証ではない |
| #25 権限 | ACL/Host/Origin/CSRF、所有者隔離、管理/復旧権限、PR #44で退出者読取・LOOKUP cache失効 | 資料/export等を含む全経路横断受入れは残る |
| #26 試験 | read-only CI、HTTP Worker、3/5/8プロセス、Chromium、Compose、要件回帰 | 全要件の状態機械/障害/UI完備とは判定しない |
| #27〜#30 実測・完成判定 | live opt-inと通常CIを分離、制御証拠と実測を区別 | 実Provider・会話読解・予算/soak・全仕様成果物対応は未完了 |

## 検証の所在

| PR | 確認済み履歴 / 対応文書 |
|---|---|
| #31 | Actions 35561187577、110テスト。AGENT_PRIVATE_STATE.md |
| #32 | Actions 35566152494、131テスト。AGENT_LOOP.md |
| #33 | Actions 35574429773、149テスト。本人予定/再開/撤回/失効 |
| #34 | Actions 35582111134、158テスト。CHARACTERS_AND_PRESENTATION.md |
| #37 | Actions 35587592577、176テスト。STORAGE_RECOVERY.md |
| #35 | Actions 35600336635、183テスト。ARCHIVE_NAVIGATION.md |
| #39 | Actions 35606783854、192テスト。DURABLE_DRAFTS.md |
| #40 | Actions 35611884468 / 35611884501、205テスト。MULTIPROVIDER_DEPLOYMENT.md |
| #38 | head 1f95d843b2caa42fc21fe9b901bd76677c03fb7b、Actions 35987906241 / 35987906255、47ファイル229テスト。MEMORY_PROVENANCE_AND_RECALL.md |
| #36 | head 9a334d8c4d1590fbadb7b1dbf87b672099fb4ea4、Actions 35989522788 / 35989522767、53ファイル255テスト。PROVIDER_MANAGEMENT.md |
| #41 | head 25ac96eefcbe9a39565c35665f6fa61a802e31f1、Actions 35995273138 / 35995269556、56ファイル263テスト。CONVERSATION_UNDERSTANDING.md |
| #42 | head 931939f175af93aa8c52c30ce871a1421484e8f1、Actions 35999992278 / 35999992275、60ファイル274テスト。CANDIDATE_REVIEW.md |
| #43 | head 560cb01c0cc1cc2b8c277b7750591e7afbc2defe、Actions 36006179252 / 36006179387、63ファイル288テスト。制御実装のみ、#13はOPEN |
| #44 | 最終head/CIはPR記録。SESSION_MEMBERSHIP.md、R7-MEMBERS-000〜010、UI-001/002、旧版移行assertion維持 |

CI成否はcheck metadataと生成された合成要約で確認します。Actions全ログ・artifact実体を取得済みとはしません。診断表示jobの成功をverify失敗の代わりに使いません。通常verifyは型検査・テスト・build・schema・複数Worker lab・Chromiumを含み、別Composeの結合結果も確認します。

## 運用の境界

同時RUNNING上限1、3〜16参加個体、単一運用者と共有閲覧トークンの非公開ラボです。公開マルチテナント/SSO、HA、外部描画、Slack/Discord、汎用ブラウザー/シェル、跨session私有経験共有は初期必須へ追加しません。

原文保存とモデル入力上限を分け、再処理も既存予算を消費します。予算は自動拡張しません。資料は現在1600文字の明示excerptです。公開削除は現在の検索/引用からの除去であり、私有journal・旧run・backupの完全消去ではありません。V7からのrollbackは対応する更新前backupと旧binaryで行い、DBを自動置換・schema番号だけ巻き戻すことはしません。

profileは鍵の参照名のみを保存します。Coreの存在確認は別Workerへの鍵配置確認の代用ではありません。設定保存・表示・再読込みでは推論せず、retry/参加者変更/cloneも終了・予算停止を解除しません。定義のみcloneは新しいDRAFTを作り、元の会話や私有経験をコピーしません。

実モデル試験にはProvider/API・モデルID・URL・安全なSecret参照と回数/出力/時間/費用上限が必要です。有料実行の許可なしに実行しません。この不足を鍵不要の実装・合成試験を止める理由にはしません。
