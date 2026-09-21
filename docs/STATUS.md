# 実装状況と未実証事項

更新日：2026-09-21。全体の受け入れ管理は Issue #4。未実装、結合済みの制御、実APIの適合、会話品質を別に判定します。Issue数やテスト件数から完成率は算出しません。

## 基準

PR #3、#31（#5）、#32（#6/#8）、#33（#7）、#34（#14/#21）はmainへマージ済み。PR #34のマージコミットは `c8a0cf8f0014dd4c3632c74a53f760fe18f10372`。PR #37は現在のV5データを対象に保存・復旧のCLIと実停止試験を追加します。ブランチへの実装、CI通過、mainへのマージ、外部deployは別です。各最終headの成否・マージSHAはPRの記録を参照してください。有料モデル呼出し、外部deploy、registry公開は行っていません。

PR #35（#17）はブラウザー回帰試験のみで、履歴UI実装は未反映です。PR #36（#15/#16）はProviderの回復・出力分類と管理部品を追加していますが、管理APIの登録・画面は未結合です。両PRで拒否された書込みは適用されていません。既存CIの合格や部品の存在をIssue完了と扱わず、ドラフトを維持しています。

## 要件ごとの現在地

| 範囲 | 実装・制御試験の状態 | 残る判定・Issue |
|---|---|---|
| #5 本人の継続私有状態 | 沈黙・保留時の原子的状態保存、世代・所有者・version・根拠・再送、V3移行・再起動を模擬検証済み | 実LLMの状態選択・活用品質は #28 |
| #6 個別Agentループ | PR #32で連続観測・保留中のobserve・本人への状態循環、3/5/8 WorkerのHTTP結合を模擬検証 | 自然な理解・相互作用は #28、資料の完全取得とACLは #20 |
| #8 記憶生成バックログ | 別cursor・凍結target・区間receipt・根拠version・再試行、最古区間の分割処理と公平割当てを検査 | 無制限入力への追従保証ではない。長時間負荷は #29 |
| #7 本人の予定・自発再開 | PR #33で私有resume条件を永続one-shot予定へ接続。変更・撤回・停止・再起動・根拠失効・予算を検査 | 関連話題の条件照合は語彙ベース。実LLMの話題選択品質は #28 |
| #9 記憶の意味・訂正・競合 | 直接参照失効と記憶根拠versionは実装 | 主体・時点・伝聞・推測・重複統合・矛盾保留・派生関係は未完了 |
| #10 想起と入力予算 | 交換可能なMemoryRetriever、語彙・本人の根拠リンクによる自動想起、原文供給、選択前の文字数予算あり | 言い換え・人物・時間条件、検索比較、token予算・取得指標の完成は残る |
| #11〜#13 会話・候補制御 | 宛先・返信・質問、revision/wake/state version、200件差分確認、原子的公開確定あり | 質問の意味的解決、reviewの意味の継続、速度差の公平性、自然な会話の評価は未完了 |
| #14 キャラクター管理 | PR #34で通常フォーム、版一覧・詳細・検証・import/export、固定版表示を登録済みAPIへ接続。HTTPとChromiumの受け入れ試験が通過 | 既存sessionへの新persona適用は #19。人格再現品質は #28 |
| #15〜#16 Provider・復旧管理 | mainの版付きprofile・複数Provider HTTP配送・circuit/再試行APIに加え、PR #36で回復の不具合と出力分類を修正中 | 新しい管理APIの登録・UI/CLI結合は未完了。PR #36は未マージ |
| #17 全履歴UI | backendのhistory/search/thread page APIと保存試験あり | UIは直近200件、旧検索上限50件。PR #35の回帰は追加済みだが実装は未結合 |
| #18 下書き | タブ内でsession/返信元別保持、同一キー再送あり | reload後の永続保存、結果不明の復元、複数タブ競合は未実装 |
| #19〜#20 session/source | lifecycle、episode、公開返信、手動資料・設定済みフィードあり | 参加者・設定適用、資料版/対象管理は未完了 |
| #21 表示交換 | PR #34でCharacterProviderとPresentationAdapterを接続。公開DTOの検証・私有field除外・cursor重複排除・非同期表示の隔離・文字fallbackの適合試験が通過 | 外部renderer実装自体は初期必須範囲外。履歴の完全な画面取得は #17 |
| #22 配布 | 非root Compose、CoreだけのDB mount、鍵なしmock smokeを検査 | 複数live Provider/Secret配線と起動手順は未完了 |
| #23 診断・再生 | run/traceとcursor、agenda等の診断はある | 新状態の因果追跡、public/private exportとreplayの全体結合は未完了 |
| #24 保存・復旧 | PR #37で既存DBの誤初期化を拒否し、整合オンラインbackup・別パスrestore・inspect・明示offline maintenanceを実装。実Core/Worker停止、全V5状態、移行失敗・容量・索引を検査 | 対象は現行V1〜V5。#9/#19で新schemaを導入する時は移行・復元試験を追加する。実機電源断・全filesystem・24時間安定の保証ではない |
| #25 権限 | 既存ACL/Host/Origin/CSRF、本人状態隔離、追加管理API/表示DTOの検査あり | 新経路を横断する権限・消去・exportの全体受け入れは残る |
| #26 検証 | read-only CIで模擬回帰、HTTP Worker、3/5/8別プロセスlab、Chromium、Compose。各PRで要件由来の試験を追加 | 全要件の状態機械・障害・UI試験を完備したという判定ではない |
| #27〜#30 実測・運用・受け入れ | 有料呼出しは明示opt-in。live workflowと通常CIを分離 | harness、実Provider、会話読解、予算/soak、全仕様と成果物の対応は未完了 |

## 検証記録

PR #31最終head `eb7ca84aaead09bc320d2333d1576c1fcbf39ad9`、Actions `35561187577` はverify/container成功、15ファイル110テスト成功。

PR #32最終head `4ead30e71f2620ee32b7aca94f38bbe7e15f8e38`、Actions `35566152494` はverify/container成功、18ファイル131テスト成功。235発言と途中訂正/削除の三者別cursor、記憶枠、再起動、未読根拠拒否、3/5/8 Workerの本人状態循環を含みます。[AGENT_LOOP.md](AGENT_LOOP.md)を参照してください。

PR #33最終head `c1d3b28ef8112513b3a8199e3257a0c5f3e8af54`、Actions `35574429773` はverify/container成功、21ファイル149テスト成功。本人予定の変更・撤回・重複防止・自然休止・予算・根拠の失効を含みます。

PR #34最終head `07d6a1e259f13d5a0d1ddfffd674baaaea65d101`、Actions `35582111134` はverify/container成功、25ファイル158テスト成功。API/通常フォーム/版切替/import/export/実Chromium/mobile/viewer、表示失敗/再送/再接続を含みます。[CHARACTERS_AND_PRESENTATION.md](CHARACTERS_AND_PRESENTATION.md)。旧headの404および新しいE2E選択欄ロケーター不備は修正後に再検証し、失敗履歴をPRに残しています。

PR #37の契約・CLI手順・保持方針・試験IDは [STORAGE_RECOVERY.md](STORAGE_RECOVERY.md)。R10-STORAGE-001〜012は既存DB誤初期化拒否、WALを含むonline backupと復元、現行状態の整合、移行/容量失敗、実Core/WorkerのSIGKILL、公開候補の一回だけの確定を検査します。対象headの最終CIとマージはPRに記録し、途中の成功を最終headの結果へ流用しません。

成否はcheck metadataとCIが作る合成テスト件数/失敗位置の要約から確認しています。元のActions全ログとartifact実体を取得済みとはしていません。診断専用jobが成功してもverify失敗を合格と見なしません。

Provider応答は合成fixtureです。HTTP、OSプロセス、SQLite、ブラウザーを実際に使っていても、実API適合・会話品質・長時間安定の証明ではありません。

## 運用上の境界

同時RUNNINGの初期上限1、3〜16参加者（Worker slot数まで）、単一運用者と共有閲覧トークンの非公開ラボです。公開マルチテナント/SSO、HA、VRM/Live2D/TTS、外部Slack/Discord、汎用ブラウザー/シェル実行、sessionをまたぐ私有経験共有は初期必須範囲に追加しません。

保存量とモデル入力制限を分けます。旧cursorは観測済みの証拠にせず、保持原文から再処理するため既存予算を消費し停止する場合があります。予算を勝手に拡張しません。過去に上書き/削除された旧版の復元を意味せず、現状の資料入力は1600文字までの明示excerptです。

公開削除は現在の検索/引用からの除去で、私有journal、旧run、backupの完全消去ではありません。変更前のbackupを確保して停止更新し、旧binaryへのrollbackには対応backupを使います。PR #37のstorage CLIは既存運用DBを自動置換せず、別パスの新規ファイルを検証します。

実モデル試験だけは正確なProvider/API・モデルID・URL・安全な認証参照・回数/出力/時間/必要な費用上限が必要です。この不足を鍵不要の実装や結合試験を止める理由にはしません。
