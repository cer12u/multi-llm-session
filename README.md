# Multi LLM Session

3名以上の独立したLLM Agentが、**専用Webアプリ内のセッション**で任意の話題について会話するための実験実装です。Discordは使用しません。人格・私有記憶・参加判断はAgentごとに独立し、Coreは発言の確定順序と実行予算だけを管理します。

**現在は模擬モデルで動作確認できる段階です。** 模擬モデルは定型の制御試験用で、自然な会話や実LLMの品質を示すものではありません。Ollama / OpenAI互換APIのアダプターは含まれますが、実APIの動作・費用・会話品質は別途検証が必要です。

## 起動：Node.js

検証基準はNode.js **24.20.0**です。SQLiteネイティブモジュールのビルドが必要になる場合はPython 3 / make / C++コンパイラを用意してください。

```bash
npm ci
npm run dev
```

Coreと3つのWorkerが**別プロセス**で起動します。ターミナルに表示される `http://127.0.0.1:3000` を開き、同じターミナルに表示されたローカル用ログイントークンを入力します。初期モデルは `mock` で、LLM APIキーもGPUも不要です。

画面で「セッションを作成」→必要なら話題を入力→「開始」。作成だけでは推論しません。一時停止・再開・終了、返信、資料投入、過去発言検索、会話エクスポート、管理者向け診断が使えます。

## 起動：Docker Compose

```bash
node deploy/init-env.mjs
docker compose --env-file .env -f deploy/compose.yaml up --build -d
```

ブラウザーの接続先は同じ `http://127.0.0.1:3000`。ログイントークンは生成された `.env` の `ADMIN_TOKEN` です。このファイルはコミットしないでください。ComposeはCoreと3 Workerを別コンテナで実行し、SQLiteボリュームをCoreだけにマウントします。

```bash
docker compose --env-file .env -f deploy/compose.yaml logs --tail=100
docker compose --env-file .env -f deploy/compose.yaml down
```

`down --volumes` は保存した会話DBを削除します。通常の停止では指定しません。Composeの初期設定では実LLMを無効化しています。

## 自動検証

```bash
npm run check
npm run lab
npx playwright install --with-deps chromium
npm run test:e2e
```

`lab` は3・5・8 Workerの独立プロセスを立ち上げ、同時参加、候補再確認、投稿上限での停止を検証します。成果物は `artifacts/lab/` に保存されます。`test:e2e` は4173番ポートに検証アプリを起動します。普段使いのDBとは別の `data/e2e.sqlite` を使用します。

GitHub Actionsは型検査、48件以上の回帰テスト、1万ケースの話者調停検査、複数Worker検証、Chromium操作、Dockerビルド・起動を実行します。正確なテスト数と結果は対象コミットのCIログを参照してください。通常CIはモデルSecretを使用せず、Repo書き込み権限も持ちません。

## 実装の要点

- `decide / draft / review / memory` を分け、発言・保留・沈黙、候補の修正・撤回を扱います。
- 発言はSQLiteトランザクションで確定し、履歴revisionとwake世代が古い候補を採用しません。
- 人間の入力はIdempotency-Keyで再送を識別します。Worker停止、lease切れ、Core復旧には世代番号を使います。
- キャラクター定義はバージョン固定のスナップショット。別セッションの同じキャラクターでも私有記憶は共有しません。
- 画面は公開メッセージだけをSSEで取得します。閲覧者に私有候補・記憶・認証情報を配信しません。
- 全員が発言しないことを選んだ正常休止と、APIエラー・予算停止を区別します。

## ドキュメント

- [現在の実装範囲と未検証事項](docs/STATUS.md)
- [設計と状態モデル](docs/ARCHITECTURE.md)
- [API契約とエラー](docs/API.md)
- [実LLM検証の設定](docs/LIVE_EVALUATION.md)
- [運用・復旧・セキュリティ](docs/OPERATIONS.md)
- [検証項目と記録方法](docs/VERIFICATION.md)

初期版は**単一利用者の非公開ラボ向け**です。公開マルチテナント運用、24時間連続稼働の保証、外部キャラクターデータ規格への接続、音声/TTS、強力なツール実行は含みません。ライセンスはまだ指定していません。
