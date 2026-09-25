# 実Provider適合・実会話評価

通常CIは合成データだけを使用します。実APIへの接続、自然な任意会話、人による読解評価、長時間運用は別の実行結果で判定します。

## 実行入口

ローカルで原データを保持する実行は[EXPERIMENT_EXECUTION.md](EXPERIMENT_EXECUTION.md)のmanifest付きCLIを使います。以前の`npm run lab -- --live`は廃止しました。`npm run lab`は従来の3/5/8プロセスの模擬制御試験専用で、自然な会話品質を判定しません。

Actionsの`Explicit live model evaluation`は手動のみです。mainの正確なapproved_sha、秘密値を含まないmanifest_json、課金確認、既存のENABLE_LIVE_EVAL変数とlive-evaluation環境を要求します。PRのコードへ自動でキーを渡しません。確認対象は最大120呼出し・30公開発言・15分・保守予約200万tokenのsmokeで、manifestが小さい上限ならその値を使います。キー参照は既存のLLM_API_KEY Secretだけです。workflowやmanifestを保存しただけでは推論しません。

Actionsは集計だけをartifactへ保存し、私有recording/DB/persona/promptは公開artifactへ置かず、最後にrunnerの一時データを削除します。したがってActionsのsmoke成果物は会話の人間読解に必要な原データを保存する経路ではありません。人間評価・再生用の原データが必要な実験は、非公開出力を保持するローカルCLIで実行します。

## 判定を混同しない

Provider適合では実際のモデルID・API形式・JSON/schema・打切り・修復・LOOKUP・usage有無・エラーを用途別に記録します。3つのWorkerがHTTP接続したという制御証拠と、サービスが期待する形式を実モデルが返した実証は別です。短い疎通で全種類のエラーが発生しなかった場合、その分岐を実API検証済みにしません。

会話評価は[CONVERSATION_EVALUATION.md](CONVERSATION_EVALUATION.md)と20題材を使い、私有状態・出典・第三者の影響、成功/失敗/無発言を人が確認します。モデルjudgeや合成の固定台詞だけでは合格にしません。EXECUTEDやCI successはsemantic acceptanceではありません。

長時間試験は事前に負荷・実時間・許容範囲を固定し、CPU/RAM、DB増加、未処理量、接続数、復旧時間を測定します。短いE2Eやsmokeから24時間安定を推定して完了と扱いません。現在の実測の有無と対象commitはIssue #27/#28/#29および各PRの記録で確認してください。
