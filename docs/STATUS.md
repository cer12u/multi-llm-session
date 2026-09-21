# 実装状況と未実証事項

更新日：2026-09-21。全体の受け入れ管理は Issue #4。未実装、結合済みの制御、実APIの適合、会話品質を別に判定します。Issue数やテスト件数から完成率は算出しません。

## 基準

PR #3、#31（#5）、#32（#6/#8）、#33（#7）はmainへマージ済み。PR #33のマージコミットは `3c1e66a78c8b46574ea2cb4df0e606b90224758d`。PR #34は #14 のキャラクター管理と #21 の表示交換境界を実アプリへ接続する変更です。ブランチへの実装、CI通過、mainへのマージ、外部deployは別です。各最終headの判定・マージSHAはPRの記録を参照してください。有料モデル呼出し、外部deploy、registry公開は行っていません。

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
| #14 キャラクター管理 | PR #34で通常フォーム、版一覧・詳細・検証・import/export、固定版表示を登録済みAPIへ接続。HTTPとChromiumの受け入れ試験を追加 | 既存sessionへの新persona適用は #19。人格再現品質は #28 |
| #15〜#16 Provider・復旧管理 | 版付きprofile、複数Provider HTTP配送、circuit/再試行APIは存在 | profile編集、適用表示、理由表示と安全な再試行のUI/CLI結合は残る |
| #17 全履歴UI | backendのhistory/search/thread page APIと保存試験あり | UIは直近200件、旧検索上限50件。全page・古い返信・原文位置への導線は未結合 |
| #18 下書き | タブ内でsession/返信元別保持、同一キー再送あり | reload後の永続保存、結果不明の復元、複数タブ競合は未実装 |
| #19〜#20 session/source | lifecycle、episode、公開返信、手動資料・設定済みフィードあり | 参加者・設定適用、資料版/対象管理は未完了 |
| #21 表示交換 | PR #34でCharacterProviderとPresentationAdapterを接続。公開DTOの検証・私有field除外・cursor重複排除・非同期表示の隔離・文字fallbackと適合試験を追加 | 外部renderer実装自体は初期必須範囲外。履歴の完全な画面取得は #17 |
| #22 配布 | 非root Compose、CoreだけのDB mount、鍵なしmock smokeを検査 | 複数live Provider/Secret配線と起動手順は未完了 |
| #23〜#25 診断・保存・権限 | 既存ACL/Host/Origin、追加移行、private state、入力receiptとcursor診断あり | 新経路を含むexport/replay、backup/restore、権限の全体受け入れは残る |
| #26 検証 | read-only CIで模擬回帰、HTTP Worker、3/5/8別プロセスlab、Chromium、Compose。各PRで要件由来の試験を追加 | 全要件の状態機械・障害・UI試験を完備したという判定ではない |
| #27〜#30 実測・運用・受け入れ | 有料呼出しは明示opt-in。live workflowと通常CIを分離 | harness、実Provider、会話読解、予算/soak、全仕様と成果物の対応は未完了 |

## 検証記録

PR #31最終head `eb7ca84aaead09bc320d2333d1576c1fcbf39ad9`、Actions `35561187577` はverify/container成功、15ファイル110テスト成功。

PR #32最終head `4ead30e71f2620ee32b7aca94f38bbe7e15f8e38`、Actions `35566152494` はverify/container成功、18ファイル131テスト成功。235発言と途中訂正/削除の三者別cursor、記憶枠、再起動、未読根拠拒否、3/5/8 Workerの本人状態循環を含みます。[AGENT_LOOP.md](AGENT_LOOP.md)を参照してください。

PR #33最終head `c1d3b28ef8112513b3a8199e3257a0c5f3e8af54`、Actions `35574429773` はverify/container成功、21ファイル149テスト成功。本人予定の変更・撤回・重複防止・自然休止・予算・根拠の失効を含みます。

PR #34の契約・API・操作・試験IDは [CHARACTERS_AND_PRESENTATION.md](CHARACTERS_AND_PRESENTATION.md)。旧head `a49daa8` の404回帰はAPI未登録を示す失敗であり、合格ではありません。APIと画面を接続した後の対象headで再検証し、最終成否をPRへ記録します。過去の合格件数を今回の判定に流用しません。

成否はcheck metadataとCIが作る合成テスト件数/失敗位置の要約から確認しています。元のActions全ログとartifact実体を取得済みとはしていません。診断専用jobが成功してもverify失敗を合格と見なしません。

Provider応答は合成fixtureです。HTTP、OSプロセス、SQLite、ブラウザーを実際に使っていても、実API適合・会話品質・長時間安定の証明ではありません。

## 運用上の境界

同時RUNNINGの初期上限1、3〜16参加者（Worker slot数まで）、単一運用者と共有閲覧トークンの非公開ラボです。公開マルチテナント/SSO、HA、VRM/Live2D/TTS、外部Slack/Discord、汎用ブラウザー/シェル実行、sessionをまたぐ私有経験共有は初期必須範囲に追加しません。

保存量とモデル入力制限を分けます。旧cursorは観測済みの証拠にせず、保持原文から再処理するため既存予算を消費し停止する場合があります。予算を勝手に拡張しません。過去に上書き/削除された旧版の復元を意味せず、現状の資料入力は1600文字までの明示excerptです。

公開削除は現在の検索/引用からの除去で、私有journal、旧run、backupの完全消去ではありません。保持・消去は #24/#25。変更前のbackupを確保して停止更新し、旧binaryへのrollbackには対応backupを使います。

実モデル試験だけは正確なProvider/API・モデルID・URL・安全な認証参照・回数/出力/時間/必要な費用上限が必要です。この不足を鍵不要の実装や結合試験を止める理由にはしません。
