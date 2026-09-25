# アーキテクチャと状態モデル

`apps/core`はAPI/認証/SSE/表示配信とScheduler、`packages/session-service`は原子的な会話更新、`packages/storage-sqlite`は永続化、`apps/agent-worker`は独立した推論実行、`apps/web`は公開投影と管理UIです。ブラウザー接続は推論の起動条件ではありません。

## 所有者と確定点

character ID/versionは不変定義、Agent UUIDはセッション内の所有者、Worker slot/epochは実行主体です。同じ人格の版適用は本人の状態を維持し、個体置換は新UUIDを割り当て、旧私有状態を移しません。公開作者は投稿時の定義を保存します。

Workerは自分の入力から候補を提案します。Coreは候補version、公開revision、wake、私有state、人格/モデル、参加者、実際に取得した出典version、lease/世代、予算を照合し、SQLiteトランザクションで公開発言を一度だけ確定します。ネットワークや推論の完了をDBロック内で待ちません。

## 個別Agentループ

`observe`は保留中も入力を読み私有状態を更新します。観測と記憶の処理位置は独立した永続cursorです。`decide`はSPEAK/DEFER/ABSTAIN、`draft`はDRAFT/DROP、`review`はKEEP/REWRITE/DEFER/DROP、`memory`は出典付き解釈を返します。

部分reviewはKEEPだけでは進めず、候補全文の再構成を次区間へ引き継ぎます。待機開始時刻は再確認でリセットしません。有限の指名猶予と待機年齢を使い、全員同数や固定順を強制しません。無限の新着で内容が失効し続ける場合まで投稿を保証しません。

本人の未解決事項・目的・予定・記憶は次の本人入力へ戻します。他者の解釈は共有の真実ではなく、根拠訂正・失効を現在の想起と候補へ伝播します。記憶の意味処理と人格再現の品質は実LLM評価で判定します。

## ライフサイクルと予算

DRAFTからRUNNING、RUNNINGとPAUSEDの往復、最後にENDEDです。作成・読取だけで推論しません。停止中も人間原文/資料を登録できます。ENDEDを勝手に再開しません。

従来のmaxDurationMsは予算期間内のRUNNING時間で、一時停止中を除きます。V10の運用予算は別途実時間の窓、token、共有scope上限を扱います。呼出前に保守的に予約し、部分/不明usageは予約を保持します。方針変更、予算更新、再開は別で、continuousの自動更新はopt-inかつ人間のpauseを解除しません。推論の取消は課金停止保証ではありません。

## 永続化と復旧

CoreだけがローカルSQLiteの会話状態を書き込みます。WAL、synchronous=FULL、foreign_keys=ONを維持します。V10は原文・所有者・私有状態/記憶・予定・資料版/対象・取得job・診断journal・予算予約を含みます。投入済みDBを追加移行し、不明/破損DBを新規DBへ置き換えません。

再起動は旧run/Worker世代を失効させます。`RESTART_POLICY=paused`は手動再開を要求します。online backupはコミット済みWALを含み、restoreは新しいパスへの作成です。旧binaryへの復帰は対応する移行前backupを使用します。

## 公開表示と私有診断

SSEは公開DTOであり、私有候補や思考過程を配信しません。snapshot/page/cursorから欠落を回復します。公開イベント投影は私有監査journalとは別です。

V9以降の私有変更journalは記録状態の再生に使用します。replayは記録順・完全性・独立した最終投影hashを検査し、LLMやSQL/外部commandを再実行しません。V10は予算記録も含みます。取得済み秘密データの完全消去や、確率的LLMの再生成保証ではありません。

詳細はAGENT_PRIVATE_STATE.md、MEMORY_PROVENANCE_AND_RECALL.md、CANDIDATE_REVIEW.md、SESSION_MEMBERSHIP.md、SOURCES.md、OBSERVABILITY.md、OPERATIONAL_BUDGETS.md、SECURITY_BOUNDARIES.mdを参照してください。
