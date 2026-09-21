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

時間予算はactive時間を計測し、一時停止時間と区別します。停止中の `POST /v1/sessions/:id/budget` は予算窓だけを更新し、累計呼出し・原文・私有状態を消しません。更新だけで会話を再開しません。予算の常用窓・実消費の詳細管理は#29です。操作UI/CLIの対応範囲は対象コミットの仕様を確認してください。

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

SQLiteには公開会話だけでなく、私有runコンテキスト・候補・メモも含まれます。公開artifactへDBを置かないでください。運転中の状態を書き込むのはCoreだけです。DBをNFS上に置かないでください。

専用CLIの手順、対応するV1〜V5、失敗時の扱い、保持方針と試験対応は [STORAGE_RECOVERY.md](STORAGE_RECOVERY.md) を参照してください。

```sh
node dist/apps/cli/storage.js inspect data/conversation.sqlite
# 新規の出力名を使う。既存backupを上書きしない。
node dist/apps/cli/storage.js backup data/conversation.sqlite backups/verified-session.sqlite
node dist/apps/cli/storage.js restore backups/verified-session.sqlite restored/session.sqlite
node dist/apps/cli/storage.js inspect restored/session.sqlite
# Core/Workerを停止し、backupを確保した後だけ実行する。
node dist/apps/cli/storage.js maintain restored/session.sqlite --offline
```

backupはSQLiteのオンラインAPIからコミット済みWALを含む整合snapshotを作ります。稼働中の.sqlite本体だけをコピーしてはいけません。出力は検証後に新規ファイルとして公開し、別の既存DBやbackupを置換しません。restoreも別ディレクトリへの新規作成です。切替時はCore/Workerを停止し、旧WALを混入させず、DB_PATHと実行ユーザーの所有権を合わせてください。最初はRESTART_POLICY=pausedで検査する構成を推奨します。

旧schema versionを無理に変更しません。不明／不完全／破損したDBや移行失敗を初期DBへ黙って置換しません。新binaryで移行したDBを旧binaryへ戻すには、対応する移行前backupを別パスへ復元します。重要データ投入前に別の検証ボリュームで手順を実施してください。オンラインの書込中backup、別ディレクトリ復元、実Core/Worker停止、索引再構築・VACUUM・容量不足は合成データのCIで検査しています。実機電源断や全filesystemの保証とは別です。

## データ保持

最近のコンテキストはboundedですが、監査用events/traces/runsの自動削除は未実装です。長期間使用する場合、inspectの行数・page/file/WAL容量とディスク空きを監視してください。原文、記憶、状態journal、再送receipt、予定は入力制限を理由に消去しません。backupの保存先とrotationは運用者が管理し、別の検証済み復元元なしに唯一のbackupを削除しないでください。

公開発言の削除は表示・検索からの削除であり、過去のモデル提示コンテキストやバックアップの完全消去保証ではありません。個人データの完全消去には別の運用設計が必要です。#9/#19で今後追加される意味・session契約は、その実装と同時に移行・復元テストへ追加します。現行V5の復元試験を未来の未実装データの検証と混同しません。

## CIの安全性

通常CIはpull_requestとmainへのpushだけで起動し、contents:read、Secretなし、モデルはmockです。checkout/setup-node/upload-artifactは固定SHAです。公開PRのコードへLLMキーを渡すpull_request_target構成は使いません。

依存インストール時の実行スクリプトはpackage.jsonのallowScriptsで承認済みのbetter-sqlite3とesbuildの固定版だけを指定しています。Node/Docker base imageはパッチ版で指定します。外部レジストリの将来変更まで完全に固定するには、運用側でimage digestも記録・固定してください。

通常CIにコードを書き換える権限を渡しません。各stageの終了コードを保持し、診断専用jobの成功をverify失敗の代替にしません。mainマージはユーザーの明示許可に従い、検証対象headを指定します。registry公開と常設サーバーへのdeployは別の許可が必要です。
