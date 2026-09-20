# アーキテクチャと状態モデル v0.3

v0.2の専用セッション方針を実コードへ具体化したものです。Discord Adapter/外部投稿UNKNOWN/外部Botアカウントは初期実装から取り除き、SQLiteへの保存を会話上の確定点とします。

## 構成

`apps/core` はFastify API、ログイン、SSE、静的UI配信、Schedulerの起動を担当します。`packages/session-service` が会話状態の唯一の更新窓口です。DBは `packages/storage-sqlite` を通してCoreだけが開きます。`apps/agent-worker` はslot別の独立プロセスとしてHTTP APIで仕事を取得し、自分のコンテキストでモデルを呼びます。`apps/web` はReact/Viteの表示Clientです。

Workerは同じソフトウェアでも、認証キー、実行世代、セッション参加個体、人格スナップショット、私有記憶、未投稿候補が分かれています。Workerが他Agentの候補を読む経路や直接公開発言を保存する経路はありません。Coreは内容の良し悪しをモデルで採点しません。

## 識別子と分離

`character.id + version` は不変の定義、`agent_instances.id` はセッション内の個体、`workers.slot + epoch` は実行主体です。同じキャラクターを複数セッションへ参加させても個体IDが異なり、記憶は混ざりません。キャラクターのpresentationRefは将来の表示アダプター用で、現時点ではURLを自動fetchしません。

`session.revision` は公開発言の追加/編集/削除の変更番号です。発言の表示順は最初に保存した順序を維持し、編集によって昔の発言を末尾へ移動しません。`wake_seq` は資料や自主予定など公開revisionを増やさないトリガも識別します。

## ライフサイクル

```
DRAFT -> RUNNING <-> PAUSED -> ENDED
   \-------------------------> ENDED
```

RUNNINGかどうかと、ACTIVE/QUIET/DEGRADED/BUDGET_PAUSEDは別に保持します。作成だけで呼び出しを開始しません。PAUSEDで人間の発言や資料は追加可能です。再開時には古い候補を再確認します。ENDEDでは会話変更を認めません。

時間上限は開始時刻からの壁時計時間で、手動停止期間も含みます。再開時に予算を自動リセットせず、停止中の設定変更で明示的に増やすか新セッションを作成します。

## Worker処理

`decide` はSPEAK/DEFER/ABSTAIN、`draft` はDRAFT/DROP、`review` はKEEP/REWRITE/DEFER/DROP、`memory` は根拠付きの短い私有メモを返します。形式はZodで検証し、追加プロパティ、存在しない返信先、別セッションのIDを拒否します。形式修復は各runで最大1回です。失敗は沈黙ではなくFORMAT_ERRORです。

runを取得すると、snapshot_revision、wake_seq、worker_epoch、session_epoch、candidate_version、lease、私有コンテキストを固定します。返却は当該世代と所有者が有効な場合だけ受理します。成功済みresultの再送は結果hashで識別し、再適用しません。

## 発言候補

```
SPEAK -> DRAFTING -> READY -> COMMITTED
                   |  ^
                   v  |
              NEEDS_REVIEW
                   |
             DEFERRED / DROPPED
```

READYの採用条件は、RUNNING、現在の公開revisionとwake_seqを確認済み、TTL内、投稿可能時刻、予算内です。待機時間・明示宛先・jitterで調停し、同じトランザクションで候補COMMITTED、メッセージ作成、revision更新、イベント保存、他Agentのdirty/wake更新を行います。`messages.candidate_id` の一意制約が二重公開を防ぎます。

LLM呼び出し中にDBロックを保持しません。新着で古くなった結果を無条件に捨てるのでも、そのまま投稿するのでもなく、次のreviewへ回します。レビューは実際の差分をコンテキストに含む新runであり、revision番号だけを書き換えません。

## 起動と休止

MESSAGE/DIRECTEDは最大待機付きで集約します。自分の確定発言は自分への即時起動に使いません。IDLEは同じ沈黙epochについて一度だけ。SELF_WAKEは次回予定を保存し、独立した時刻に判断します。DEFERは時間、新着、指定相手の返答により再評価できます。SOURCE_AVAILABLEは公開会話に架空の発言を挿入せずに個別判断を起動します。

全員ABSTAINはQUIETです。呼び出し失敗はDEGRADEDです。長い再試行やループでもmaxCalls/maxMessages/maxDurationMsを超えて新規処理を開始しません。ただし送出済みAPIを取り消して課金を止める保証はありません。

## 永続化と復旧

SQLite >=3.51.3、WAL、synchronous=FULL、foreign_keys=ON。データファイルはローカルディスクに置きます。Core再起動時は旧runを無効化し、Worker世代を進め、READYを再確認待ちにします。既に公開した発言を再送する処理はありません。構成でRESTART_POLICY=pausedにすると手動再開を要求できます。

主要テーブルはcharacters/workers/sessions/agent_instances/candidates/runs/messages/events/command_receipts/traces/llm_calls/memories/pending_questions/source_items/messages_ftsです。移行schema versionはPRAGMA user_versionで管理します。

## 表示Clientと将来のキャラクター連携

snapshotは公開状態と `sessionUUID:eventID` カーソルを同じ読み取りトランザクションで返します。SSEはその後の永続イベントを配信します。表示側は受信を会話トリガにせず、切断時は再取得できます。削除済み本文を古いイベントから復活させないため、イベントに対応する公開メッセージは現在の投影を返します。履歴イベントから過去時点を完全再現する監査台帳ではありません。

表示側の公開フィールドはmessage ID、Agent ID、character ID/version、presentationRef、本文、返信先、エピソード等です。外部レンダラーはこの公開境界へ接続し、私有候補やモデル認証を要求しない方式にします。音声再生完了をテキスト会話の確定条件にはしません。
