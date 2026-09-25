# 実際のHTTPルートとOpenAPI

`GET /v1/openapi.json`を管理者認証で取得するか、`npm run cli -- openapi`で標準出力へ取得します。これはユーザーデータではなく、登録済みAPIの契約です。閲覧者・Workerのtokenでは取得できません。ブラウザーからは既存の管理者cookieも使用できます。新たな外部接続・推論は開始しません。

```sh
# CORE_URLとADMIN_TOKENは既存の安全な設定を使用する。
npm run cli -- openapi > multi-llm-session.openapi.json
# サーバー・モデル鍵なしで、現在のソースの実ルート登録から生成する。
node dist/apps/cli/schema.js artifacts/contracts --check
```

## 対象と生成元

OpenAPI 3.1.1 / JSON Schema 2020-12形式です。`apps/core/openapi.ts`がFastifyのonRouteで実際の登録を収集し、`packages/contracts/openapi.ts`の説明との一致を検査します。説明だけ存在する削除済みルート、説明のない追加ルートがあれば`OPENAPI_ROUTE_DRIFT`で生成を失敗させます。現在のhealth/v1 APIは76操作です。画面の`/`・`/assets/*`とGETから自動生成されるHEADはAPI操作数から除外し、その範囲を出力に明記します。

リクエストのbody・page/query・Worker envelopeは既存のZodまたは`packages/contracts/http.ts`を参照します。後者はHTTPハンドラー自身が同じ定義でparseします。入力は`io: input`で生成し、settingsやprofileの既定値がリクエスト必須項目へ誤変換されないようにします。応答のpublic DTOは型と対応するschemaを持ちます。

パス引数、query、Idempotency-Key、Bearer/cookieの代替認証、cookie書込のCSRF/Origin、読取専用POST、ログアウトの例外、SSEと私有NDJSONのmedia typeを記録します。Worker結果はrun種別ごとの出力schemaも参照できます。Origin/Host・所有者・世代・出典version・ライフサイクルの検査は実行時に残り、OpenAPIだけで代替しません。

**生成用メタデータはFastifyのvalidator/serializerへ登録しません。** そのため仕様追加で実応答のフィールドを削除したり、別のバリデーターへ置き換えたりしません。HTTP仕様の取得にも既存の管理者認可を使います。モデルURL、credentialの実値、保存したpersona/私有状態を仕様に埋め込みません。

## CIと実アプリ確認

既存の31 JSON Schemaに加えて、`openapi.json`もレビュー済みhash baselineと照合します。差分がある場合は生成物とルート実装を確認してbaselineを更新します。schema hashの一致だけで動作や安全性の合格にはしません。

`tests/e2e/openapi.spec.ts`は実Core/SQLiteのHTTPと別CLIプロセスを使用します。全登録APIとの対応・参照解決・サーバー出力とオフライン生成の一致を確認した上で、仕様どおりに既定値を省略してsession作成、原文投稿と同じキーでの再送、viewerによる読取POST、未知フィールド拒否、character検証を行います。API取得が推論を増やさないことと、無認証/viewer/異なるOriginの拒否も確認します。

## 明示的な限界

全API操作、入力契約、認証、応答形式を対象にしますが、private diagnostics・可変metadata・receiptなどの内部フィールドすべてを厳密なDTOとして生成するものではありません。これらは拡張可能な応答として`x-response-shape`に明示しています。OpenAPIのrole拡張を解釈しないclient generatorでも、サーバーのrole検査は回避できません。

zodのrefine、人物/所有者/出典の一致、Unicode文字数、URL安全性、現在のrunとの整合性はJSON Schemaだけでは全て表現できません。HTTP E2Eと実行時検査を維持します。実Provider適合・会話の自然さ・実LLM長時間運用の評価は別で、仕様生成の成功から判定しません。
