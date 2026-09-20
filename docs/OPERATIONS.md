# 運用・復旧・安全性

## 配置前提

初期版は単一Core・単一DB・非公開ラボ向けです。Node.js 24.20.0、ローカルディスク、Docker利用時はLinuxコンテナを前提にしています。公開インターネットへポートを開けないでください。初期Composeは127.0.0.1だけに公開します。別PCから操作する場合は、SSHポート転送または認証されたリバースプロキシを使い、PUBLIC_ORIGIN/Host/HTTPS cookieと整合させてください。

## ログインと鍵

`npm run dev` は起動時に足りないローカル鍵を生成し、管理者のログイントークンだけをターミナルへ表示します。固定鍵を維持する場合は安全な環境変数を設定します。Composeは `node deploy/init-env.mjs` が作るchmod600の.envを使用します。既存.envは上書きしません。

Workerには自分のslot用トークンだけを渡し、peerのWorker鍵、管理者鍵、DBマウントを渡しません。モデルAPIキーは実モデルを使用するWorker環境で管理します。Browserへモデル鍵を返しません。

閲覧トークンが必要な場合はVIEWER_TOKENをCoreへ設定します。24文字以上、管理者/Worker鍵と別の値にしてください。閲覧者はすべての公開セッションを見るラボ用の共有閲覧者であり、個別ユーザーACLではありません。

## 停止・復旧

UIの一時停止は新規runと新規発言の確定を停止します。外部へ送信済みの推論を取り消せるとは限りません。保留候補は再開時に再確認します。デフォルトのCore再起動ではRUNNINGセッションを復旧し、古いWorker世代とrunを無効化します。勝手に再開したくない環境ではRESTART_POLICY=pausedを指定してください。

ComposeではWorkerごとにrestart policyを持ちます。一体の停止で他Workerを停止させません。開発用supervisorも一体の退出だけではCoreや他Agentを止めませんが、そのWorkerの自動再生成は行わないため、全体再起動またはComposeで置き換えます。

予算停止後はDRAFT/PAUSED用の設定画面で予算を明示的に増やすか、新セッションを作ります。既存消費量をゼロへ戻して再開する仕組みはありません。最大時間は開始からの壁時計時間です。

## CLI

```bash
npm run build
# CORE_URL と ADMIN_TOKEN を安全な環境変数として設定
npm run cli -- list
npm run cli -- status SESSION_ID
npm run cli -- pause SESSION_ID
npm run cli -- resume SESSION_ID
npm run cli -- say SESSION_ID '話題を投入'
npm run cli -- search SESSION_ID '検索語'
npm run cli -- export SESSION_ID
npm run cli -- source SESSION_ID source.json
```

終了済みセッションは閲覧・検索・exportのみです。UIの診断画面ではprocessed/dirty revision、wake世代、候補状態、再確認、run、エラー、予算を確認します。思考中・沈黙・待機・エラーを区別してください。長い非公開推論の保存は要求していません。

## DBとバックアップ

SQLiteには公開会話だけでなく、私有runコンテキスト・候補・メモも含まれます。公開artifactへDBを置かないでください。Core以外から書き込みをしません。DBをNFS上に置かないでください。

安全な初期手順は、Core/Workerを停止して全DB接続を閉じた後、dataディレクトリまたはComposeのsession-data volumeを一式バックアップすることです。稼働中の.sqliteファイルだけをコピーしてはいけません。アプリ内のStore.backupはSQLiteオンラインバックアップ用に実装されていますが、外部向けのバックアップAPIは公開していません。

復元はサービス停止中に一式を戻し、所有者を実行ユーザーへ合わせます。旧schema versionを無理に変更しません。Coreが不明なschema versionを検出した場合は起動を拒否します。重要データ投入前に別の検証ボリュームで復元手順を実施してください。

## データ保持

最近のコンテキストはboundedですが、監査用events/traces/runsの自動削除は未実装です。長期間使用する場合、DBサイズとディスク空きを監視してください。公開発言の削除は表示・検索からの削除であり、過去のモデル提示コンテキストやバックアップの完全消去保証ではありません。個人データの完全消去には別の運用設計が必要です。

## CIの安全性

通常CIはpull_requestとmainへのpushだけで起動し、contents:read、Secretなし、モデルはmockです。checkout/setup-node/upload-artifactは確認済みの完全SHAで固定しています。公開PRのコードへLLMキーを渡すpull_request_target構成は使いません。

依存インストール時の実行スクリプトはpackage.jsonのallowScriptsで承認済みのbetter-sqlite3とesbuildの固定版だけを指定しています。Node/Docker base imageはパッチ版で指定します。外部レジストリの将来変更まで完全に固定するには、運用側でimage digestも記録・固定してください。

開発中の一時的な依存固定/レビュー済み修正workflowは作業ブランチ内で必要ファイルだけを書き込み、適用後に削除します。通常CIをコード書換エージェントにはしません。mainへのマージ、registry公開、常設サーバーへのdeployは自動実行しません。
