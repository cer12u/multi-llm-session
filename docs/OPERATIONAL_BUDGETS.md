# 運用予算・消費量

予算の保存、予算窓の更新、会話の再開は別の操作です。会話・人格・私有状態・原文を予算更新のために削除しません。既存の呼出数、発言数、稼働時間上限も同時に適用します。

## 操作

管理者で「セッション設定」→「診断」→「運用予算と消費量」を開きます。DRAFT/PAUSEDで方針を保存し、必要な場合だけ「予算を明示更新」、その後に別操作で「再開」を行います。保存だけでは窓の開始時刻も消費済み量もリセットされません。

`GET /v1/sessions/:id/usage` は管理者だけに、用途/段階別の呼出し、usageの既知/不明、予約換算、待機/応答時間、想起/原文取得、候補破棄と実母数を返します。閲覧者とWorkerには公開しません。

`POST /v1/sessions/:id/budget-policy` は `expectedEpoch` と `policy` を受けます。通常の管理権限・Origin/CSRF・冪等キーを使います。`policy:null` は新方式の制限を外しますが、既存の呼出数/発言数/稼働時間制限は残ります。

```sh
npm run cli -- usage SESSION_ID
npm run cli -- budget-policy SESSION_ID policy.json
npm run cli -- budget SESSION_ID
npm run cli -- resume SESSION_ID
```

policy.json の例（expectedEpoch は現在のsnapshotから取得）:

```json
{"expectedEpoch":3,"policy":{"mode":"continuous","windowMs":3600000,"autoRenew":false,"maxTokens":1000000,"scopeMaxCalls":300,"scopeMaxTokens":2000000}}
```

## 時間・共有上限

experimentは一回限りです。continuousの自動更新も初期値は無効です。有効にすると、期限到達後に窓を更新し、予算による停止だけを再開できます。ユーザーのpause、ENDED、再起動後の明示再開待ちは自動解除しません。再開には同時RUNNING上限も適用します。

セッション窓は窓を開いた時刻からの実時間です。既存のactiveMsはその予算期間のRUNNING時間であり、pause時間を含みません。開始からのwallMs、現在窓のwallMsは別に表示します。

認証scope上限は `providerScope` を使い、同じscopeの全セッションでUTC epoch基準の固定期間を共有します。セッションの手動更新では共有消費を消せません。同じscopeに矛盾した期間/上限は拒否します。共通の認証契約は同じbinding/limitGroupを設定してください。異なる鍵の実値が同じアカウントに属するかをアプリが推測することはしません。

## token・料金

送信前に確定した入力の保守推定と最大出力を予約します。三者同時要求も同じSQLiteトランザクション経路で直列化して上限確認します。返却usageが両方ある場合は実測へ精算します。不明・部分的なusage、TIMEOUT/CANCELLED/DELIVERY_UNKNOWNは予約量以上を保持し、ゼロとしません。旧callにも分かる要求上限を使った推定を適用し、過去に無かった実測を作りません。

Provider側追加token、独自tokenizer、誤ったusageのため実測が予約を超える可能性はあります。その場合は以後の送信と公開確定を停止します。これは金額保証ではなく、従量料金・サブスクリプション残量をActions時間/保存容量と合算しません。金額制限はProvider側にも設定してください。ローカルキャンセルは外部推論の課金停止を保証しません。

100発言換算には実際の公開発言数を併記します。0件では算出しません。発言数を稼ぐためにAgentへ発言を強制しません。

## 永続化と検証

V10はbudget_windows/call_budgetsと索引・記録triggerを追加します。原文、既存の監査履歴やV9の列を置き換えません。V9記録のoffline replayは引き続き読めます。V10 backupは新table/index/triggerを検査し、現在の予算・私有状態とともに復元します。旧binaryへのrollbackは対応する更新前backupを使用します。

`tests/e2e/budgets.spec.ts` は通常の画面/API、実Coreと三つのOS Worker、合成HTTP Provider、SQLiteを使い、送信前拒否、共有scope、usage不明、フォーム保存/更新、プロセス再起動、自動更新、人間のpauseを確認します。内部Service fixtureや新規単体テストではありません。これは短いE2Eであり24時間安定・実LLM会話品質の証拠ではありません。長時間試験と実Provider結果は、その実行時間・入力数・環境を添えた別結果で判断します。
