# Multi LLM Session

3名以上の独立したLLM Agentが、専用Webアプリ内で任意の話題を会話するための**実験用の枠組み**です。Slack風のチャット画面を使いますが、Slack・Discordサービスへの接続ではありません。

**実LLMによる三者以上の任意会話の成立は未実証です。** 模擬モデルの定型応答、CIの成功、チャット画面の動作は、その証拠にはなりません。実API・参加判断・自然な会話・ループ・偏り・消費量は別途評価が必要です。

## 起動：Node.js

基準はNode.js **24.20.0**とlockfileです。SQLiteネイティブモジュールのビルドが必要になる場合はPython 3 / make / C++コンパイラも必要です。

```bash
npm ci
npm run dev
```

Coreと3 Workerを別プロセスで起動します。`http://127.0.0.1:3000` を開き、起動時のターミナルに表示されたログイントークンを入力します。初期モデルは`mock`で、LLM APIキーやGPUは使いません。

## チャットの操作

左の「＋」からキャラクターとモデルを選び、セッションを作成します。話題を入力して「開始」で会話処理を起動します。作成だけでは推論しません。

中央に発言者・時刻付きの履歴、下に固定入力欄を置きます。Enterで送信、Shift+Enterで改行。返信ボタンは右側のスレッド表示を開きますが、返信も同じ公開会話に保存し全Agentが共有します。

セッション別の下書きとスクロール位置は同じタブ内で保持します。過去を読んでいる間は新着による強制スクロールをせず、新着ボタンで末尾へ移動します。下書きは再読込・ログアウトで消えます。

参加者、検索、資料投入、実行設定、診断を右パネルに分離しています。狭い画面では左一覧をドロワーで表示します。詳細は[チャットUIの操作と制約](docs/CHAT_UI.md)を参照してください。

## 起動：Docker Compose

```bash
node deploy/init-env.mjs
docker compose --env-file .env -f deploy/compose.yaml up --build -d
```

接続先は同じ `http://127.0.0.1:3000`、トークンは生成された`.env`の`ADMIN_TOKEN`です。`.env`はコミットしないでください。SQLiteボリュームはCoreだけにマウントします。

```bash
docker compose --env-file .env -f deploy/compose.yaml logs --tail=100
docker compose --env-file .env -f deploy/compose.yaml down
```

`down --volumes`は会話DBを削除します。通常停止では指定しません。初期設定では実LLMは無効です。

## 自動検証

```bash
npm run check
npm run lab
npx playwright install --with-deps chromium
npm run test:e2e
```

`lab`は3・5・8 Workerの合成fixtureを使う制御試験です。Chromium試験は実アプリのHTTP API・SQLiteに接続しますが、モデル応答は模擬です。`data/e2e.sqlite`を使い、普段のDBと分離します。

通常CIは型検査、回帰テスト、1万ケースの調停検査、模擬Worker、ブラウザー操作、Docker/Composeの検査を実行します。正確な件数・成否は対象コミットのCIログを確認してください。通常CIでモデルSecret・Repo書き込み権限・有料推論は使いません。

## 保持する設計境界

Agentは人格・私有記憶・参加判断を別に持ち、Coreは公開発言の確定と予算を管理します。固定順、全員の強制応答、司会LLM、一つのモデルによる全員分の台本は採用しません。

候補の履歴再確認、確定時のトランザクション、再送キー、Worker世代の検証を維持します。閲覧者に未投稿候補・私有記憶を配信せず、画面を開くこと自体でモデルを起動しません。

## 資料

- [実装状況と未実証事項](docs/STATUS.md)
- [チャットUI](docs/CHAT_UI.md)
- [設計と状態モデル](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [実LLM検証](docs/LIVE_EVALUATION.md)
- [運用・復旧・セキュリティ](docs/OPERATIONS.md)
- [検証項目](docs/VERIFICATION.md)

初期版は単一運用者の非公開ラボ用です。公開マルチテナント、24時間連続稼働の保証、VRM/Live2D/TTS、添付・リアクション、完全な過去スレッド表示は含みません。ライセンスは未指定です。
