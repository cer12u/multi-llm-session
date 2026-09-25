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

出力ディレクトリは0700、各JSON/記録は0600です。`manifest.json`は承認SHA、設定hash、実効上限、人格/プロファイル定義を保持します。`result.json`は実行時間・終了理由・用途別usageと実母数、`resources.json`はCoreのCPU/RAM/DB/バックログとLinuxの各子プロセスのRSS/CPU tick/socket数を記録します。Linux以外等で取得できない指標はnullです。`private-recording.ndjson`は記録状態のreplay検査を通した私有診断です。`session.sqlite`も非公開で保持します。

失敗した実行も`failure.json`と私有DBを残し、成功例だけを選別しません。stdoutは件数・終了理由等だけで、記憶やプロンプトの本文を表示しません。原データを公開Actions artifactへアップロードしないでください。

EXECUTEDは実行済みという意味です。`semanticAcceptance:NOT_EVALUATED`、`humanReviewed:false`は人間の読解評価が済むまで変更しません。syntheticは本物のLLMの品質を意味しません。source SHAの検証はモデルサーバーや推論seedによる再現性の保証でもありません。

API形式は既存のOllama Native `/api/chat`とOpenAI互換Chat Completionsに限ります。通常JSON/strict schema/出力上限パラメーター等は保存したprofileの能力宣言に従います。実サービスへの適合確認は別の実測です。料金・サブスクリプション残量は計算せず、tokenの保守的な予約と実測/不明を分けます。金額の上限はProvider側でも設定してください。

## 評価ケース

20の導入題材は`config/evaluation/scenarios.json`、判断手順は`CONVERSATION_EVALUATION.md`です。初期題材だけのケースはscenario/initialTextをmanifestへ移して実行できます。`controlledPreparation`付きケースの追加入力・編集・資料や履歴準備は、この実験CLIが自動実行する機能ではありません。既存の専用アプリ/API/CLIで明示的に設定したセッションへ操作し、診断exportを保存して行います。この差を実施済みと扱わないでください。

現時点で、実LLMの応答品質・長時間安定性はこのコードや合成E2Eの成功からは判定しません。長時間試験は実行前にduration・入力件数・障害条件・CPU/RAM/DB/遅延の許容範囲を固定し、観測した実時間でのみ報告します。短いsmokeを24時間運用の合格とはしません。
