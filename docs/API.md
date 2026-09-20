# API契約 v1

実行時に検証する定義は `packages/contracts/index.ts`、HTTP境界は `apps/core/server.ts` です。`node dist/apps/cli/schema.js` でJSON Schemaを `artifacts/contracts/` へ出力できます。Schemaだけでは表現しない、所有者・セッション一致・現行世代・返信先の実在などもCoreが検査します。

## 認証

ブラウザーはPOST `/v1/auth/login` に `{ "token": "入力したログイントークン" }` を送信します。成功するとHttpOnly/SameSite=Strict cookieと `{role, csrf}` を返します。書き込みでは同一Originと `X-CSRF-Token` を要求します。GET `/v1/auth/me` でログイン状態、POST `/v1/auth/logout` でログアウトできます。

CLIは `Authorization: Bearer <ADMIN_TOKEN>`、閲覧専用はVIEWER_TOKEN、Workerは自分のWORKER_TOKENを使います。URLにトークンを含めません。公開Host/Originを検査し、管理者・閲覧者・Workerの認証は互換にしません。内部コンテナ通信では正しいWorker認証を持つ `/v1/worker/` に限り内部Hostを認めます。

## 操作者向け操作

| Method / Path | 本文・意味 |
|---|---|
| GET /v1/capabilities | 利用可能なprofile ID、worker slot、初期設定。秘密のURL/鍵は返しません |
| GET /v1/characters | 最新版の定義。閲覧者にはpersonaを返しません |
| POST /v1/characters | CharacterSchema。既存versionは上書き不可 |
| GET /v1/sessions | 公開セッション一覧 |
| POST /v1/sessions | SessionCreateSchema。DRAFTを作成 |
| POST /v1/sessions/:id/start,pause,resume,end | 各々独立したパス。本文 `{}` |
| POST /v1/sessions/:id/settings | SettingsSchema全体。DRAFT/PAUSED限定 |
| POST /v1/sessions/:id/members | `{agentId, enabled}`。DRAFT/PAUSED限定 |
| POST /v1/sessions/:id/messages | `{text, replyTo: nullまたはmessage ID, addressedTo: [agent ID]}` |
| POST /v1/sessions/:id/messages/:messageId | `{text: 新本文}` で自分側の人間発言を編集。`{text:null}` は削除 |
| POST /v1/sessions/:id/sources | `{title,text,url?,publishedAt?}`。会話への投稿ではなく資料追加 |
| GET /v1/sessions/:id/snapshot | セッション・参加者・最近200件の公開メッセージ・cursor |
| GET /v1/sessions/:id/events?cursor=... | SSE。Last-Event-IDがあれば優先 |
| GET /v1/sessions/:id/search?q=... | 元発言の検索、最大50件 |
| GET /v1/sessions/:id/archive/:messageId | 元発言。削除済みは410 |
| GET /v1/sessions/:id/diagnostics | 管理者限定。未投稿候補、run、cursor、trace、metrics |
| GET /v1/sessions/:id/export | 管理者限定。manifest、確定会話、metricsのJSON |
| GET /v1/sessions/:id/commands/:operation/:key | 管理者限定。結果不明時の冪等操作結果照会 |

セッション変更操作には `Idempotency-Key` を必須とします。UUIDを推奨し、許可文字は英数字・`_.:-`、8〜128文字です。同じscope/key/bodyは同じ結果、同じscope/keyで本文を変えると409です。lifecycleは全actionで同じscopeを使用するため、pauseとresumeは違うkeyにします。キャラクター登録はid/versionによる不変性検査で重複を制御します。

### セッション作成の最小例

```json
{
  "title": "自由な会話",
  "participants": [
    {"characterId":"sora","profileId":"mock","slot":"worker-a"},
    {"characterId":"nagi","profileId":"mock","slot":"worker-b"},
    {"characterId":"rin","profileId":"mock","slot":"worker-c"}
  ]
}
```

レスポンスは `{id}`。slotは異なるものを3個以上指定します。別セッションに同じcharacter IDを使っても個体IDは新規です。

## Worker操作

Worker tokenからslotを確定します。BodyでslotやAgentの所有権を変更できません。

| Method / Path | 本文 |
|---|---|
| POST /v1/worker/register | `{}` → `{epoch}` |
| POST /v1/worker/claim | `{epoch}` → nullまたはClaimedRun |
| POST /v1/worker/runs/:id/heartbeat | `{epoch,token}` |
| POST /v1/worker/runs/:id/calls | `{epoch,token,requestKey,stage:"primary"または"repair"}` → `{id}` |
| POST /v1/worker/runs/:id/calls/:callId | `{token,usage:{inputTokens,outputTokens},error}` |
| POST /v1/worker/runs/:id/result | `{epoch,token,output}` |
| POST /v1/worker/runs/:id/failure | `{epoch,token,code}` |
| GET /v1/worker/agents/:id/memory | 自分の個体の記憶のみ |
| GET /v1/worker/agents/:id/archive?q=... | 自分のセッションに限定した検索 |
| GET /v1/worker/agents/:id/archive/:messageId | 自分のセッションに限定した原文取得 |

ClaimedRunはid/token/kind/workerEpoch/sessionEpoch/leaseMs/timeoutMs/contextChars/profile/contextを含みます。profileには鍵そのものを含めず、Workerが参照する環境変数名を指定します。同一slotで有効runは最大1件です。claimの応答が失われたとき、同じepochの再要求では同じrunを返します。

resultは事前のモデル呼出記録を必要とし、runごとのJSON Schemaに検証します。呼び出し失敗・形式修復も予算に含めます。usage不明はnullです。外部推論が止まったと確認できない予約は、保守的に期限まで占有として扱います。

## SSE

データは `id: sessionUUID:eventID` と `data: JSON` の組です。JSONはid/sessionId/kind/revision/createdAt/dataと、発言イベントであればmessageを含みます。候補や私有記憶は含みません。Agentの考えた本文を途中ストリーミングしません。

cursorが別セッション/未来/不正形式なら409 RESYNC_REQUIREDです。表示Clientはfresh snapshotから再接続します。画面側はメッセージIDで置換し、通知回数を発言件数やLLMトリガとして扱いません。

## 代表的なエラー

400/422は構造違反、401は認証不足、403は所有権/操作権/Origin/CSRF違反、404は存在しない資源、409はSTALE_WORKER/STALE_RUN/STALE_CANDIDATE/IDEMPOTENCY_CONFLICT/INVALID_LIFECYCLE/RESYNC_REQUIRED等、410は削除済み原文、429はProvider同時枠やログイン制限です。本文は `{code}` を基本にします。Providerの生のエラー本文や鍵を返しません。
