# 上限付き実験の実行

`apps/cli/experiment.ts` は、承認したソースと接続設定を事前確認し、実Coreと各Workerを別プロセスで起動して、そのセッションの記録を非公開ディレクトリに残します。preflightだけでは接続・推論・セッション作成を行いません。設定不足はBLOCKEDで終了します。

## 実行手順

Node.js 24.20.0とlockfileを使い、信頼するコミットをcheckoutして`npm ci`を実行します。`config/evaluation/manifest.example.json`をリポジトリ外へコピーし、正確なProvider/API形式、モデルID、baseUrl、承認SHA、各上限を設定します。例のSHAとモデルURLは実行用ではありません。`approvedCommit`は`git rev-parse HEAD`の実値を指定します。

キーの値はmanifestやIssueへ記載せず、プロファイルが参照する環境変数または`LLM_API_KEY_FILE`等の専用secret-file参照で配置します。Core/Workerの操作用トークンは実験ごとに分離され、Workerには選択されたモデルのbindingだけを渡します。

```sh
node --import tsx apps/cli/experiment.ts preflight ../private/experiment.json
# READYを確認した後だけ、明示的に実行する。liveにはALLOW_LIVE_MODELS=1も必要。
ALLOW_LIVE_MODELS=1 node --import tsx apps/cli/experiment.ts execute ../private/experiment.json ../private/run-001
```

出力の親ディレクトリは事前に用意します。出力先はリポジトリ外の新規ディレクトリで、既存出力を上書きしません。実行ソースのSHA不一致・変更済み/未追跡の実行コード・鍵不足・上限不整合は拒否します。古いdistを承認SHAの実装と取り違えないよう、実験入口は上記のソース実行を必須にします。通常の製品起動は引き続きビルド済みコードを使えます。

`purpose:smoke`は自発時刻起動を無効にします。`purpose:conversation`で自発予定を調べる場合は、その時刻がdurationMs内に入るようsettingsを設定し、`quietStopMs:null`にします。会話を続けるための全員強制発言・最低発言数は追加しません。終了時は通常のend操作で新規推論・公開確定を止めます。既に外部へ送られた処理の取消・課金停止は保証できません。

## 出力と判断

出力ディレクトリは0700、各JSON/記録は0600です。`manifest.json`は承認SHA、設定hash、実効上限、人格/プロファイル定義を保持します。`result.json`は実行時間・終了理由・用途別usageと実母数、`resources.json`はCoreのCPU/RAM/DB/バックログとLinuxの各子プロセスのRSS/CPU tick/socket数を記録します。Linux以外等で取得できない指標はnullです。`private-recording.ndjson`は容量内で取得できた場合の、replay検査を通した私有診断です。終了時に製品のonline backupでWALを含む整合snapshotを`private-database.sqlite`へ新規保存し、integrity/schemaを確認します。元の`session.sqlite`も非公開で保持します。

失敗した実行も`failure.json`と私有DBを残し、成功例だけを選別しません。stdoutは件数・終了理由等だけで、記憶やプロンプトの本文を表示しません。原データを公開Actions artifactへアップロードしないでください。

EXECUTEDは実行済みという意味です。`semanticAcceptance:NOT_EVALUATED`、`humanReviewed:false`は人間の読解評価が済むまで変更しません。syntheticは本物のLLMの品質を意味しません。source SHAの検証はモデルサーバーや推論seedによる再現性の保証でもありません。

API形式は既存のOllama Native `/api/chat`とOpenAI互換Chat Completionsに限ります。通常JSON/strict schema/出力上限パラメーター等は保存したprofileの能力宣言に従います。実サービスへの適合確認は別の実測です。料金・サブスクリプション残量は計算せず、tokenの保守的な予約と実測/不明を分けます。金額の上限はProvider側でも設定してください。

## 評価ケース

20の導入題材は`config/evaluation/scenarios.json`、判断手順は`CONVERSATION_EVALUATION.md`です。初期題材だけのケースはscenario/initialTextをmanifestへ移して実行できます。`controlledPreparation`付きケースの追加入力・編集・資料や履歴準備は、この実験CLIが自動実行する機能ではありません。既存の専用アプリ/API/CLIで明示的に設定したセッションへ操作し、診断exportを保存して行います。この差を実施済みと扱わないでください。

現時点で、実LLMの応答品質・長時間安定性はこのコードや合成E2Eの成功からは判定しません。長時間試験は実行前にduration・入力件数・障害条件・CPU/RAM/DB/遅延の許容範囲を固定し、観測した実時間でのみ報告します。短いsmokeを24時間運用の合格とはしません。

## 長い実験と記録容量

`recordingMaxBytes`は任意のmanifest項目で、既定値は134217728（128MiB）、範囲は1024〜134217728bytesです。実験側の記録上限を小さくする設定であり、Coreの診断容量制限を引き上げるものではありません。設定hashにも含めます。呼出し/token/実時間の上限は別の`bounds`を維持します。

終了時はDBバックアップを先に保存・検証します。診断exportがCoreの413または指定した記録byte上限で拒否された場合も、`result.json`と`resources.json`を保存します。`recordingStatus:SIZE_LIMIT`、`privateRecording:null`、警告を明記し、完全なNDJSON/replayを保存したとは扱いません。正常に保存した場合は`recordingStatus:SAVED`です。途中までのNDJSONは一時ファイルから公開せず削除し、DB・原文・私有状態は消しません。

バックアップ/権限/通信/破損replayなど容量以外の失敗を成功へ変換しません。EXECUTEDと記録形式の成否は別で、自然な会話や人間評価の合格を意味しません。DBバックアップ自体に固定容量制限や自動削除はなく、保存先の空き容量を確保してください。巨大DBの保存時間・ディスク容量を無制限に保証するものではありません。

```sh
# 元DBを上書きせず、別パスへ復元して製品CLIで点検する。
node dist/apps/cli/storage.js restore ../private/run-001/private-database.sqlite ../private/restored.sqlite
node dist/apps/cli/storage.js inspect ../private/restored.sqlite
```

実験E2Eは同じ実Core/3 Worker/HTTP経路で通常保存と小さい記録上限の2実行を行い、結果・usageの保持、一時ファイルの除去、復元CLIによる3所有者の私有状態と原文の保持を検査します。上限に達しなかった短い試験だけで大容量時の成功を推定しません。
