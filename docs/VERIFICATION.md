# 検証仕様と再現方法

## 層を分けて判断する

(1) 純粋関数/Schema、(2) 実SQLiteの状態機械、(3) HTTP+独立Worker、(4) ブラウザーとコンテナ、(5) 実LLMの会話品質を分けます。初期PRの自動CIは(1)〜(4)です。(5)は未実施です。

## 自動試験

`tests/domain.test.ts`: Schema拒否、canonical hash、coalescing、aging、seed=20260920の1万調停ケース。1万件は話者選択関数に対する入力組合せであり、1万セッションを実LLMで動かしたという意味ではありません。

`tests/session.test.ts`: 三候補同時READY、生成中の新着、実差分を読んだreview、候補DROP、停止/再開/旧run拒否、完了resultの再送、lease失効、Worker交換、DEFERの時間/新着条件、QUIETと一度きりのIDLE、エラー分類、Provider同時予約、修復を含むcall上限、投稿/時間上限、私有記憶の所有権、別セッション参照拒否、snapshotとSSEの間のイベント、削除原文、FTS日本語検索、エピソード、資料重複、実DBファイルの再openを扱います。

`tests/http.test.ts`: 実FastifyルートのHost/Origin、ログイン、cookie/CSRF、閲覧権限、Worker所有権、実HTTP通信でのdecide/draft、JSON修復、FORMAT_ERROR、SSE再配信を検証します。

`tests/models.test.ts`: 非ストリームAPIのURL/本文/usageとJSON schema wrappingを模擬HTTPで検証します。RSS/Atomのパース、日時、不正ENTITY/サイズ制限も検査します。

`tests/additional-recovery.test.ts`: 編集順序と派生メモ失効、遅いrunの間に他Agentが進めること、未完了の外部推論予約を保守的に扱うこと、ログアウト時のSSE失効を検査します。

`npm run lab`: 別プロセスのCoreと3/5/8 Workerを起動。全員の参加・候補再確認・上限停止を確認し、synthetic transcriptとmetricsを出力します。模擬モデル自身に2発言/人のfixture制約があります。コントローラーの強制均等割り当てではありません。

`tests/e2e/session.spec.ts`: Chromiumでログイン、セッション作成、話題投入、三者参加、一時停止、再読込、二画面の表示、HTML文字列の非実行、診断、終了を操作します。ブラウザー操作はモデルAPIの品質評価ではありません。

Docker jobは非rootイメージをbuildし、read-only filesystem、Core専用DBボリューム、個別Worker tokenでComposeを起動します。`deploy/smoke.mjs` はコンテナ間で3 Workerの6発言とMAX_MESSAGES停止を検証する補助試験です。

## 成果物

通常CIのartifactにはsyntheticなmock会話/metrics、commit情報、ソースアーカイブ、Playwright report、失敗時trace/screenshotを保存します。保持期間は7日です。実LLM workflowは初期設定で生の会話を保存せずmetricsだけを出します。

モデル呼出しはdecide/draft/review/memoryおよびprimary/repairを区別し、usage不明はnullです。待機・再確認・DROP・エラーはtraceへ記録します。SQLの私有run/contextや認証情報を通常artifactへ含めません。

## 手元での再現

```bash
npm ci
npm run check
npm run lab
npx playwright install --with-deps chromium
npm run test:e2e
```

2回目のE2Eで古い検証セッションが邪魔になる場合は、専用テストアプリを止めた状態で `data/e2e.sqlite*` だけを削除します。普段使いのconversation.sqliteを削除してはいけません。CIは毎回クリーンなrunnerを使用します。

CI成功はセキュリティ認証や全故障パターンの証明ではありません。現時点の不変条件と再現可能なシナリオが通ったことを意味します。実モデル、長時間稼働、異種API、ネットワーク切断中の課金、将来のキャラクターアダプターは別の検証記録が必要です。
