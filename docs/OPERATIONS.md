# 運用・復旧・安全性

## 配置と認証

単一Core/ローカルSQLite/非公開ラボを対象にします。Node.js24.20.0とlockfileを使います。初期Composeは127.0.0.1へだけ公開します。別PCの操作はSSH転送または認証されたproxyを使い、PUBLIC_ORIGIN/Host/Origin/HTTPS cookieを整合させます。

`npm run dev`は不足する内部鍵を生成し、管理者ログイントークンをターミナルへ表示します。Composeは`node deploy/init-env.mjs`の新規.envを使用します。鍵や.envをコミットしません。モデル鍵は専用の環境変数/secret-file参照で配置し、Workerには本人の内部tokenと必要なモデルbindingだけを渡します。DBはCore専用です。

VIEWER_TOKENは単一ラボの共有閲覧用で、個人別ACLではありません。管理者/Workerの鍵と別にします。persona・私有資料・診断・設定操作を閲覧者へ渡しません。

## 停止と予算

pauseは新規runと公開確定を停止し、再開時は古い候補を再確認します。外部送信済みの推論/課金が止まったとは限りません。デフォルトのCore復旧は再開可能状態を回復し、`RESTART_POLICY=paused`なら手動再開を要求します。

時間上限はRUNNING時間と実時間の予算窓を分けます。方針保存、明示的な予算更新、resumeは別操作です。履歴・私有状態・累計消費を消さず、continuousの自動更新も明示opt-inだけです。人間がpauseした状態を解除しません。OPERATIONAL_BUDGETS.mdを参照してください。

## CLI

CORE_URL/ADMIN_TOKENを安全に設定した後、`npm run cli -- ...`を使います。

| 用途 | コマンド |
|---|---|
| 会話 | `list`、`create FILE`、`status SESSION`、`start/pause/resume/end SESSION`、`say SESSION TEXT` |
| 原文 | `original SESSION MESSAGE`、`history SESSION [CURSOR]`、`thread SESSION MESSAGE [CURSOR]`、`search-page SESSION QUERY [CURSOR]` |
| 人格 | `characters`、`character-validate FILE`、`character-import FILE`、`character-versions ID`、`character-get/character-export ID VERSION` |
| Provider | `profiles`、`profile-versions ID`、`profile-save FILE`、`retry-provider ID VERSION`、`retry-agent SESSION AGENT` |
| 継続 | `members/episodes SESSION`、`members-apply/clone SESSION FILE`、`usage SESSION`、`budget-policy SESSION FILE`、`budget SESSION` |
| 資料 | `source SESSION FILE`、`sources/feeds SESSION`、`source-get/source-versions SESSION SOURCE`、`source-update SESSION SOURCE FILE`、`feed-save SESSION FILE`、`feed-retry SESSION FEED` |
| 記録 | `transcript SESSION`、`diagnostic-runs SESSION`、`diagnostic-run SESSION RUN`、`diagnostic-export SESSION PRIVATE.ndjson`、`replay PRIVATE.ndjson PRIVATE.json` |

入力FILEの構造は各機能の契約に従います。cursorは応答のnextCursorをそのまま渡します。管理者CLIの出力には許可されたpersona/原文が含まれます。stdoutや私有ファイルを公開ログへ無差別に保存しないでください。

## DBとbackup

```sh
node dist/apps/cli/storage.js inspect data/conversation.sqlite
node dist/apps/cli/storage.js backup data/conversation.sqlite backups/new.sqlite
node dist/apps/cli/storage.js restore backups/new.sqlite restored/session.sqlite
node dist/apps/cli/storage.js inspect restored/session.sqlite
# サービス停止とbackup確保の後だけ
node dist/apps/cli/storage.js maintain restored/session.sqlite --offline
```

現行schemaはV10です。online backupはSQLite APIからWAL込みの整合snapshotを作り、検証して新規ファイルへ保存します。稼働中の.sqlite本体だけをコピーしません。restoreも新しいパスへ作成し、既存DBを上書きしません。切替はCore/Worker停止後に行い、旧WALを混ぜず、所有権/DB_PATHを合わせます。

DBには私有状態/候補/入力/記憶が含まれます。NFSや公開artifactへ置きません。schema番号を書き換えず、不完全DBを新規DBで隠しません。旧binaryへのrollbackは対応する移行前backupを使います。STORAGE_RECOVERY.mdと各移行仕様を参照してください。

## 測定・保持

`node dist/apps/cli/soak.js 600 artifacts/operational-soak.json`は外部モデルを呼ばない実Core/3 Worker/HTTP/一時DBの合成負荷です。条件・上限・結果はOPERATIONAL_SOAK.mdと対象PR/CI成果物で確認します。600秒を24時間保証にしません。

原文と監査journalは入力上限のために消去しません。DB/WAL容量と空き容量を監視し、backup rotationは運用者が管理します。公開削除・配信取消・logoutは過去のrecordingやbackupの完全消去ではありません。

通常CIはread-only/合成データです。実モデルは別の承認SHA/設定/上限と明示実行を要求し、ライブworkflowをPRから自動起動しません。registry公開と常設deployは別の承認事項です。
