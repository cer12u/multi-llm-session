# 実装状況と未実証事項

更新日：2026-09-24。全体の受け入れ管理は Issue #4。実装、結合試験、実API適合、会話品質を別に判定します。Issue数やテスト件数から完成率は算出しません。

## 基準

PR #3、#31（#5）、#32（#6/#8）、#33（#7）、#34（#14/#21）、#37（#24）、#35（#17）、#39（#18）、#40（#22）はmainへマージ済みです。PR #40のマージコミットは `13d16c970f2d9e147ae17e5ce514d31b3351e629`。

PR #38は記憶の意味・訂正・派生関係と予算付き想起を実際のAgentループへ接続する変更です。「回帰試験のみ・本体未反映」という以前の説明は現在のブランチには当てはまりません。通常検索の入力予算不足も修正し、実Workerの既存回帰を維持しています。最終headのCIとマージはPRの記録で確認してください。ブランチ上のコードや途中の緑のCIだけを完了と扱いません。

PR #36（#15/#16）はProviderの回復・出力分類と管理部品がある一方、新管理API登録・画面の結合は残っています。有料モデル呼出し、外部deploy、registry公開は行っていません。

## 要件ごとの現在地

| 範囲 | 実装・制御試験の範囲 | 残る判定・Issue |
|---|---|---|
| #5 本人の継続私有状態 | 沈黙・保留時の原子的保存、世代・所有者・version・根拠・再送、移行・再起動 | 実LLMの状態選択・活用品質は #28 |
| #6 個別Agentループ | 連続観測、保留中のobserve、本人への状態循環、3/5/8 WorkerのHTTP結合 | 自然な理解・相互作用は #28。資料全体と対象管理は #20 |
| #7 本人の予定 | 永続one-shot予定、変更・撤回・停止・再起動・重複防止・根拠失効・予算 | 関連話題照合は語彙ベース。話題選択品質は #28 |
| #8 記憶バックログ | 観測と別cursor、凍結target、区間receipt、根拠version、最古からの分割と公平割当て | 無制限入力への追従保証ではない。長時間負荷は #29 |
| #9 記憶・訂正・競合 | PR #38で所有Agent・対象・時点・self-report/hearsay/inference、add/merge/correct/conflict、旧履歴、派生メモ・私有状態への失効伝播を実結果処理へ接続 | 意味・正規化キー・別名はモデルの解釈。意味の正しさや真実の証明ではない。最終CIはPR参照 |
| #10 想起と入力予算 | PR #38で別名・人物・時間を含む交換可能な検索、原文付き自動想起、入力選択前のrequest/schema/output予算、LOOKUP余裕と明示失敗、検索比較指標を追加 | UTF-8保守推定でありモデル固有tokenizerではない。日付・人物解釈は限定的。実会話の取得品質は #28 |
| #11〜#13 会話・候補制御 | 宛先・返信・質問、revision/wake/state version、分割差分確認、原子的公開確定 | 質問の意味的解決、reviewの意味の継続、速度差、公平性、自然な会話評価は未完了 |
| #14 キャラクター管理 | 通常フォーム、版一覧・詳細・検証・import/export、固定版表示、HTTP/Chromium | 既存sessionへの新persona適用は #19。人格再現品質は #28 |
| #15〜#16 Provider・復旧 | 版付きprofile、複数Provider配送、circuit/再試行とPR #36の部品 | 新管理API登録・UI/CLI結合、全受け入れは未完了 |
| #17 全履歴UI | history/search/threadページ、原文リンク、読み位置、1,205原文・270検索結果・241返信。PR #40で再接続時の削除再確認・欠落区間回復も修正 | 全履歴の一定メモリ/DOM量を保証しない。画面閲覧は推論起動条件ではない |
| #18 下書き | IndexedDB、送信前の不変payload/key、結果照合・明示再送、版競合、logout/破棄競合、IME | 一運用者・端末内保存。端末間同期・暗号化・フォレンジック消去は含まない |
| #19〜#20 session/source | lifecycle、episode、公開返信、手動資料、設定済みfeed | 参加者・設定適用、資料版/対象管理は未完了 |
| #21 表示交換 | CharacterProvider/PresentationAdapter、公開DTO、重複排除、非同期表示隔離、文字fallback | 外部renderer自体は初期必須範囲外 |
| #22 配布 | 構成生成、版付きAPP_CONFIG、Worker別file-secret、Core専用DB、loopback、非rootの共有/異種3体HTTP試験 | 実Providerは #27。配置先deployは別許可。既定mockは維持 |
| #23 診断・再生 | run/trace、cursor、agenda、PR #38の記憶履歴・想起指標 | 新状態の因果追跡、public/private exportとreplayの横断結合は未完了 |
| #24 保存・復旧 | 誤初期化拒否、online backup、別パスrestore、inspect、offline maintenance、移行失敗・容量・実プロセス停止 | PR #38でV6の意味metadata/依存edge/履歴を追加検証。次のschemaも同時に試験拡張する。実電源断・全filesystem・24時間安定保証ではない |
| #25 権限 | ACL/Host/Origin/CSRF、本人状態隔離、管理API/表示DTO、記憶の所有者検証 | 新経路横断の権限・消去・export受け入れは残る |
| #26 検証 | read-only CI、模擬回帰、HTTP Worker、3/5/8プロセス、Chromium、Compose、各PRの要件試験 | 全要件の状態機械・障害・UI試験完備という判定ではない |
| #27〜#30 実測・完成判定 | live opt-inと通常CIを分離。合成検証と実測の記録を分ける | 実Provider、会話読解、予算/soak、全仕様・成果物対応は未完了 |

## 検証記録

| PR | 確認済みの履歴 | 契約・試験対応 |
|---|---|---|
| #31 | Actions 35561187577、15ファイル110テスト、verify/container成功 | AGENT_PRIVATE_STATE.md |
| #32 | Actions 35566152494、18ファイル131テスト、verify/container成功 | AGENT_LOOP.md |
| #33 | Actions 35574429773、21ファイル149テスト、verify/container成功 | 本人予定の変更・撤回・根拠失効・自然休止 |
| #34 | Actions 35582111134、25ファイル158テスト、verify/container成功 | CHARACTERS_AND_PRESENTATION.md |
| #37 | Actions 35587592577、30ファイル176テスト、verify/container成功 | STORAGE_RECOVERY.md |
| #35 | Actions 35600336635、32ファイル183テスト、verify/container成功 | ARCHIVE_NAVIGATION.md |
| #39 | Actions 35606783854、34ファイル192テスト、verify/container成功 | DURABLE_DRAFTS.md |
| #40 | Actions 35611884468 / 35611884501、40ファイル205テスト、verify/container/multi-provider-compose成功 | MULTIPROVIDER_DEPLOYMENT.md、DEPLOYMENT_ACCEPTANCE.md |
| #38 | 最終headとCIはPRへ記録。既存Worker検索回帰を修正し、意味・想起・予算・V6復旧試験を追加 | MEMORY_PROVENANCE_AND_RECALL.md |

CI成否はcheck metadataと生成された合成要約から確認します。元のActions全ログやartifact実体を取得済みとはしていません。診断表示jobの成功を失敗したverifyの代わりにしません。途中の合格を新しいheadへ流用しません。

Provider応答は合成fixtureです。HTTP・OSプロセス・SQLite・ブラウザーが実物でも、実API適合・自然な会話・長時間運用の証明にはなりません。PR #38の検索比較は別名/人物/時点を与えた小規模fixtureで、生成を行わず、取得率・適合率・誤取得・レイテンシ・追加呼出しを記録します。

## 運用上の境界

同時RUNNINGの初期上限1、3〜16参加者、単一運用者と共有閲覧トークンの非公開ラボです。公開マルチテナント/SSO、HA、VRM/Live2D/TTS、Slack/Discord、汎用ブラウザー/シェル、sessionをまたぐ私有経験共有は必須範囲に追加しません。

保存量とモデル入力上限を分けます。旧cursorを観測済みの証拠にせず、保持原文を再処理する場合も既存予算を消費します。予算を自動拡張しません。上書き前の原文を旧メモから復元したとは扱いません。資料入力は現在1600文字の明示excerptです。記憶の旧版や不明な出典を確定事実へ昇格させません。

公開削除は現在の検索/引用からの除去であり、私有journal・旧run・backupの完全消去ではありません。停止更新前のbackupを確保し、旧binaryへのrollbackには対応backupを使います。storage CLIは既存DBを自動置換しません。配布構成・鍵原本・生成先はGit/build tree外に配置し、生成だけではsessionは開始されません。

実モデル試験には正確なProvider/API・モデルID・到達URL・安全なSecret参照と回数/出力/時間/費用上限が必要です。この不足を鍵不要の実装・合成結合試験を止める理由にはしません。
