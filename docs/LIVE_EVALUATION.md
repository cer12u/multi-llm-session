# 実LLM検証への切り替え

**このリポジトリを作成した段階では実LLMの呼び出しを行っていません。** 模擬検証の成功を、特定モデルの形式遵守や会話品質の成功と読み替えないでください。

## GitHub Actionsで実行する前の設定

`live-evaluation` Environmentを作成し、適切な実行承認を設定してください。利用プランによって承認機能の可否は異なるため、承認が利用できない場合もmain上の確認済みコード以外では実行しないでください。

RepoまたはEnvironment Variables:

| 名前 | 値 |
|---|---|
| ENABLE_LIVE_EVAL | 明示的に `true` |
| MODEL_PROVIDER | `ollama` または `openai` |
| MODEL_NAME | APIが受け付ける正確なモデルID |
| MODEL_BASE_URL | Ollamaは `/api` まで、OpenAI互換は一般に `/v1` までのベースURL |
| MODEL_JSON_MODE | `none` / `json` / `schema`。未確認のAPIにはnoneから開始 |

Secret: **LLM_API_KEY**。鍵の値をRepo・Issue・チャットへ記載しません。workflowはmainの確認済みコードを対象とし、`confirm_billable_calls` を明示的に承認した場合のみ実行されます。この実装PRは自動マージしないため、現在はworkflowがmainに存在しません。PR確認とマージ後の操作です。

初回の上限は1セッション、3 Agent、15分、合計120呼び出し、30件のBot発言です。decide/draft/review/memory/形式修復をすべて呼び出し数へ含めます。各APIの最大生成量にも上限を設定しますが、リモート側の推論キャンセルや正確な金額上限を保証するものではありません。Provider自身の利用上限設定も併用してください。

実モデルworkflowは初期設定でmetricsのみをartifactへ保存します。生の会話、人格、私有コンテキストの公開保存はしません。このRepoはPublicなので、workflowログへの記載内容にも注意してください。

## ローカルCLIでの明示実行

必要な環境変数を安全に設定したうえで、次を実行します。

```bash
npm ci
npm run check
npm run lab -- --live
```

上記に加えて `ALLOW_LIVE_MODELS=1` が必要です。`MODEL_PROVIDER`、`MODEL_NAME`、`MODEL_BASE_URL`、`LLM_API_KEY` を設定してください。生の会話JSONをローカルへ保存する場合だけ `EXPORT_LIVE_TRANSCRIPT=1` を明示します。通常の `npm run lab` は実モデル設定が環境にあってもmockへ戻し、有料APIを呼びません。

専用UIを実LLMにつなぐ場合も同じ環境変数を設定し、`npm run dev` で起動して参加者のprofileを `live` に変更します。さらに細かい構成はAPP_CONFIGで指定し、モデルごとのbaseUrl/model/apiKeyEnv/jsonModeを定義します。APIキーはJSONファイルに直書きしません。

## API互換性

Ollama: 非ストリーム `/chat`、message.content、prompt_eval_count/eval_countを利用します。baseUrlが `/api` の場合、実際のパスは `/api/chat` です。

OpenAI互換: 非ストリーム `/chat/completions`、choices[0].message.content、usageを利用します。現在はmax_tokensとtemperatureを送ります。これらを受け付けないモデル、Responses専用モデル、推論トークン制御の特殊仕様を持つProviderには専用アダプター調整が必要です。「互換APIを名乗る全サービスに対応済み」ではありません。

noneはプロンプト指示+JSONパース、jsonはAPIのJSON mode、schemaはresultオブジェクトで包んだJSON Schemaを要求します。モデルが返すJSONを検査し、最大1回修復します。APIで厳格なJSONを保証できることを共通前提にしていません。

## 最初に評価する内容

20種類以上の導入話題を用意し、自由な雑談、質問、訂正、複数話題、資料への感想、沈黙、昔の話題の再開を評価します。モデル・人格・設定・commitを記録し、実際のメッセージと短い制御ログから、遅延返信、重複、取りこぼした質問、参加機会、三体目の発言への反応を確認します。

全員の発言数を同数にすること、一定数まで強制的に続けること、毎回質問することを成功条件にしません。設定を調整した場合は、変更前後で同じ導入話題を使いますが、実モデル会話が完全再現できるとは仮定しません。
