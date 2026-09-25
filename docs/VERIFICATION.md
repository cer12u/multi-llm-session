# 検証と再現

既存の単体/SQLite/HTTP/プロセス/ブラウザー試験は維持します。残機能の追加検証は実アプリを通すE2Eを優先し、新しい単体テストを増やしません。実LLM適合と人間の会話読解は別の判定です。

```sh
npm ci
npm run check
node dist/apps/cli/schema.js --check
npm run lab
npx playwright install --with-deps chromium
npm run test:e2e
node dist/apps/cli/soak.js 600 artifacts/operational-soak.json
```

E2Eは普段のDBと分離します。テスト用DBを片付けるときも普段のconversation.sqliteを削除しません。CIはクリーンrunnerを使います。

## 対応と成果物

全要件の既存試験対応はREQUIREMENT_TEST_MATRIX.mdと各機能仕様にあります。固定seedの状態機械、200件超の記憶バックログ、所有者漏えい、実停止、履歴/下書き/再接続、管理操作の既存ケースを維持します。単なる候補配列や模擬台詞の数を独立した三者会話の証拠にしません。

追加E2Eは`budgets.spec.ts`（実Core/3 Worker/HTTP/画面の予算と復旧）、`experiment.spec.ts`（CLI/承認SHA/3所有者/私有記録）、`operator-cli.spec.ts`（文書化した人格/原文/ページ操作）です。内部serviceやDBを書き換えて期待状態を作るものではありません。

通常verifyはtypecheck、既存回帰、build、生成schemaの差分、3/5/8実Worker lab、Chromiumを実施します。別のcontainer/multi-provider-composeを含め、診断表示だけのjobを本体失敗の代用にしません。CIのSHAとPR head/merge-refを区別します。

`Synthetic operational soak`は別jobで実時間600秒の合成負荷を行い、途中の429/復旧、pause後Core強制終了と再起動、原文/記憶/状態、予算窓、資源量を記録します。条件と限界はOPERATIONAL_SOAK.md、実際の成功/失敗・headはPR #52を参照してください。

通常artifactは合成データ、stage結果、ソース、契約、E2E reportです。私有本番DB/鍵/プロンプトを入れません。live workflowは承認済みmainと上限付きsmokeの明示実行だけで、公開出力は集計です。人間読解用の私有原データは別のローカル実験CLIで保持します。

CI成功は全故障/全脆弱性や無期限安定の保証ではありません。600秒の測定を24時間と呼ばず、実Provider、自然な会話、金額の保証には別の実測とProvider側制限が必要です。
