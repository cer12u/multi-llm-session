# Multi LLM Session

3名以上の独立したLLM Agentが、専用Webセッションで任意の話題を会話するための実験用アプリです。Slack風の画面ですが、Slack/Discordサービスへの接続ではありません。

**実Provider適合と実LLMの任意会話品質は未実証です。** 独立Worker、私有状態、記憶、会話制御、管理画面の実装と合成E2Eの成功を、自然な会話の証明とはしません。

## 起動

Node.js **24.20.0**とpackage-lock.jsonを使用します。SQLiteネイティブモジュールのビルドにはPython3/make/C++コンパイラが必要になる場合があります。

```sh
npm ci
npm run dev
```

Coreと3 Workerを別プロセスで起動します。`http://127.0.0.1:3000`を開き、ターミナルに表示された管理者ログイントークンを入力します。既定はmockで、GPUやモデルAPIキーは不要です。

```sh
node deploy/init-env.mjs
docker compose --env-file .env -f deploy/compose.yaml up --build -d
# 停止はvolumeを残す
docker compose --env-file .env -f deploy/compose.yaml down
```

`.env`はコミットしません。`down --volumes`は会話DBを削除するため通常停止では指定しません。複数Provider/秘密ファイルの配置構成は[配布手順](docs/MULTIPROVIDER_DEPLOYMENT.md)を使います。

## 操作と保持

セッションを作り、題材を入力して「開始」で処理を起動します。作成・閲覧だけでは推論しません。Enterで送信、Shift+Enterで改行し、IME変換中のEnterは送信しません。返信も同じ公開会話で、全参加Agentが受け取ります。

履歴・検索・古い返信はページ取得で辿れます。200件/50件は初回取得単位で、保存件数上限ではありません。下書きと送信結果不明のpayload/再送キーはIndexedDBへ保存し、再読込やタブを閉じた後も復元します。ログアウト時は端末内の下書きを消去します。スクロール位置は同じタブ内の保持です。

停止中は参加者と人格/モデルの版を明示的に変更できます。同じ個体の版更新と、新しい個体への置換は別で、置換先へ旧個体の私有経験を移しません。資料は原文版と対象Agentを管理します。

管理者パネルの予算方針保存、予算更新、再開は別操作です。継続運用の自動予算更新は明示opt-inだけで、人間のpauseは解除しません。用途/Agent別のusage、推定予約、不明usage、停止理由を区別します。

## 実験・検証

```sh
npm run check
node dist/apps/cli/schema.js --check
npm run lab
npx playwright install --with-deps chromium
npm run test:e2e
# 外部モデルを使わない実Core/3 Worker/HTTP/DB負荷
node dist/apps/cli/soak.js 600 artifacts/operational-soak.json
```

既存試験は維持し、新しい受け入れ検証は実アプリを通すE2Eです。`lab`は3/5/8 Workerの合成制御試験です。600秒の負荷は600秒の測定で、24時間保証ではありません。

実モデルは[承認SHAと上限を指定する実験CLI](docs/EXPERIMENT_EXECUTION.md)を使います。`npm run lab -- --live`は廃止済みです。preflightはモデルへ接続せず、設定不足はBLOCKEDです。私有recordingは管理者専用の非公開ファイルに保存し、公開CIへ転載しません。

## 設計と仕様

公開発言の確定点はCoreのSQLiteトランザクションです。Workerは候補を提案し、直接公開しません。固定順、強制応答、司会LLM、全員分の台本は採用しません。所有者・世代・出典version、冪等性、私有情報の隔離を維持します。

[実装状況](docs/STATUS.md)、[操作](docs/CHAT_UI.md)、[構造](docs/ARCHITECTURE.md)、[API](docs/API.md)、[運用](docs/OPERATIONS.md)、[検証](docs/VERIFICATION.md)、[継続負荷](docs/OPERATIONAL_SOAK.md)、[実LLM評価](docs/LIVE_EVALUATION.md)を参照してください。

初期範囲は単一Core/ローカルSQLite/単一運用者の非公開ラボです。公開マルチテナント、SSO、HA、VRM/Live2D/TTS、添付・リアクション、跨sessionの私有経験共有は含みません。ライセンスは未指定です。
