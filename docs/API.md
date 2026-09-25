# API契約 v1

実行時の構造定義は`packages/contracts/`、HTTP登録は`apps/core/server.ts`と`*-routes.ts`です。Zodの構造検査に加え、Coreは所有者/世代/出典version/実在/予算を検証します。

## 認証・再送

`POST /v1/auth/login`にtokenを送るとHttpOnly/SameSite=Strict cookieとrole/csrfを返します。cookie書込には同一Origin/X-CSRF-Tokenが必要です。CLIはADMIN_TOKEN、閲覧者はVIEWER_TOKEN、Workerは本人のWORKER_TOKENをBearerで渡します。URLへ鍵を含めません。

セッションcommandはIdempotency-Keyを使います。同じscope/key/bodyは同じ結果、異なるbodyは409です。lifecycleの異なる操作には異なるキーを使います。人格/profileは不変ID/versionで重複を制御します。Host/Origin/CSRF/本人run認証を迂回しません。

以下の`...`は`/v1/sessions/:id`です。管理操作と私有読取はoperator限定、公開読取はviewerも可能です。

## 公開会話と状態

| Method / path | 内容 |
|---|---|
| GET /v1/capabilities | profile概要、Worker slot、初期設定 |
| GET /v1/characters | 最新定義。viewerにはpersonaなし |
| GET/POST /v1/sessions | 公開一覧 / SessionCreateSchemaからDRAFT作成 |
| POST .../start、/pause、/resume、/end | 本文{}。操作ごとに別パス |
| POST .../settings | SettingsSchema全体、DRAFT/PAUSED |
| POST .../messages | MessageInputSchema。text/replyTo/addressedTo/任意act |
| POST .../messages/:messageId | 人間本文の編集text、削除text:null。Bot本文の書換え不可 |
| GET .../snapshot | 公開状態、初回履歴、historyCursor、SSE cursor |
| GET .../history、/threads/:messageId、/search-page?q=... | cursor/limit(1〜200)、items/highWater/nextCursor |
| GET .../search?q=... | 互換の先頭50件検索。追加取得はsearch-page |
| GET .../archive/:messageId | 元原文。削除済み410 |
| POST .../messages/lookup | 公開原文の一括読取{ids:[UUID...]}、最大200 |
| GET .../events?cursor=... | 公開SSE。Last-Event-IDがあれば優先 |
| GET .../transcript | 公開許可フィールドだけの会話出力 |
| GET .../export | 互換のoperator限定公開会話出力。私有診断ではない |

検索の編集失効は409 PAGE_RESYNC_REQUIREDです。SSEはsessionUUID:eventIDのcursorを使い、不正/未来/別sessionは409です。表示側はsnapshot/pageから復旧し、受信回数を推論トリガにしません。

## 管理API

| 範囲 | パスと契約 |
|---|---|
| Character | GET `/v1/characters/:characterId/versions`、`.../versions/:version`、`.../versions/:version/export`。POST `/v1/characters/validate`・`/import`はCharacterSchema |
| Provider | GET `/v1/provider-catalog`、`/v1/model-profiles/:profile/versions`。POST `/v1/model-profiles`はModelProfileSchema、POST `.../:profile/versions/:version/retry`は{} |
| Participation | GET/POST `.../membership`、POST `.../clone`。MembershipUpdateSchema/SessionCloneSchema。GET `.../episodes`は公開メタデータ |
| Source | POST/GET `.../sources`、GET `.../sources/:source`・`/versions`・`/versions/:version`、POST `.../sources/:source`はSourceUpdateSchema。原文版とaudienceを検査 |
| Feed | GET `/v1/source-configurations`、GET/POST `.../feeds`、POST `.../feeds/:source/retry`。FeedSubscriptionSchema |
| Usage | GET `.../usage`、POST `.../budget-policy`はBudgetPolicyUpdateSchema、POST `.../budget`は明示更新{} |
| Recovery | POST `.../agents/:agentId/retry`。定義の最新値へ勝手に切り替えず、旧runを失効 |
| Diagnostics | GET `.../operations`・`/diagnostics`・`/diagnostic-runs`・`/diagnostic-runs/:run`・`/diagnostic-export`。最後は管理者専用の私有NDJSON |
| Receipt | GET `.../commands/:operation/:key`。結果不明commandの照会 |

人格/モデル版を同じ個体へ適用する場合と置換する場合で、私有経験の扱いは異なります。予算方針保存、予算更新、再開は別です。資料の対象外通知を本人の観測済みとして扱いません。詳細は各機能仕様を参照してください。

## Worker契約

`POST /v1/worker/register`は{}→epoch、`POST /claim`はepoch→nullまたはClaimedRunです。`/v1/worker/runs/:id`以下にheartbeat、calls、calls/:callId、lookup、result、failureがあります。

run操作はepoch/tokenと所有slotを検査します。call予約はrequestKeyとstage(primary/lookup/repair)、settlementはusage(inputTokens/outputTokens、各null可)とerrorを受けます。lookupはrequestKey/requestsを受け、元の観測bindingを保ったまま現在の所有権・出典versionを検査します。成功resultの再送で状態を二重適用しません。

互換の`GET /v1/worker/agents/:id/memory`、archive検索、archive原文取得にも、現在の有効run、未失効lease、Worker/session世代、RUNNING、非retired本人を要求します。再利用したslotは過去個体の記憶への権限ではありません。

## 生成契約・エラー

`node dist/apps/cli/schema.js --check`は31個の生成JSON Schemaを`config/schema-baseline.json`の検証済みhashと照合し、差分で失敗します。変更時は生成差分のレビュー後に一覧を更新します。これは全HTTP APIのOpenAPI生成ではなく、Zodで表現できる構造の検査です。所有者・現在版・世代は実行時検査を維持します。

401は認証、403は権限/Origin/CSRF、404は不存在、409は世代/状態/再送競合、410は削除原文、413はサイズ、422は構造、429は同時枠等です。本文は安全なcodeを基本とし、Providerの生のエラーや鍵を公開しません。
