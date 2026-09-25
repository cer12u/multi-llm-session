# 承認したコードからの配布物生成

配布物の生成は通常CIと実モデル評価から分離した`Verified distribution bundle` workflowで行います。手動実行はmainを選び、`approved_sha`に現在のmainの40桁SHAを指定します。不一致では生成しません。PR上では候補のインストール試験として実行し、実測したmerge-ref SHAを記録します。PR head・テスト用merge-ref・マージ後mainは同一とは限りません。

これは自分のリポジトリのActions artifactへの保存です。外部registryへのpush、GitHub Releaseの公開、常設サーバーへのdeployは行いません。モデルキーやGitHub書込権限は使用しません。履歴保持は7日で、永続的な配布保管場所ではありません。

## 生成物

`source.tar.gz`は承認したGitコミットだけのアーカイブで、未追跡・無視されたローカル設定や稼働DBを含めません。追跡済みの.envやDB/dataの混入も拒否します。`image.tar.gz`は非root実行する完成済みLinuxコンテナです。`manifest.json`と`SHA256SUMS`にソースSHA、lockfileのSHA-256、Node版、解決したbase image digest、実際のbuild用Dockerfile hash、完成image ID、OS/architectureとファイルhashを記録します。

両FROMを取得済みbase imageのimmutable digestへ固定してビルドします。元のソースアーカイブは変更しません。aptリポジトリの将来状態やbuild時刻まで完全固定していないため、将来の再ビルドがバイト単位で同じimageになるとは保証しません。保存済みimageを再利用する場合はmanifestのIDと照合できます。

## クリーンな環境への配置

Nodeビルド環境なしで実行する場合も、Linux Docker/Composeとアーカイブ展開ツールが必要です。別architectureのホストへnative実行できるとは限りません。

```sh
# bundleの展開先で実行。hash照合は破損検出であり発行者の署名ではない。
sha256sum -c SHA256SUMS
docker load -i image.tar.gz
mkdir source
tar xzf source.tar.gz -C source
# manifest.jsonのimage.tagをIMAGE_TAGへ設定する。
IMAGE_TAG=multi-llm-session:bundle-承認した40桁SHA
docker image inspect "$IMAGE_TAG" --format '{{.Id}}'
# 自分の環境に既存ciタグがある場合は上書きせず、Compose overrideでimageを指定する。
cd source
node deploy/init-env.mjs
```

`deploy/init-env.mjs`にはNode.jsが必要です。Nodeをホストへ導入しない場合は、読み込んだimageで同じスクリプトを実行します。

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work "$IMAGE_TAG" node deploy/init-env.mjs
```

生成された.envのADMIN_TOKENでログインします。値を公開ログへ転記しません。四つのサービスのimageを指定する`bundle.override.json`を配置します。

```json
{"services":{"core":{"image":"IMAGE_TAG","environment":{"RESTART_POLICY":"paused"}},"agent-a":{"image":"IMAGE_TAG"},"agent-b":{"image":"IMAGE_TAG"},"agent-c":{"image":"IMAGE_TAG"}}}
```

上の4箇所のIMAGE_TAGをmanifestの実値へ置換して、次を実行します。アプリのソースコードを編集する必要はありません。

```sh
docker compose --env-file .env -f deploy/compose.yaml -f bundle.override.json up -d --no-build
# http://127.0.0.1:3000 で操作。停止時はvolumeを残す。
docker compose --env-file .env -f deploy/compose.yaml -f bundle.override.json down
```

実Providerの設定はMULTIPROVIDER_DEPLOYMENT.mdの生成コマンドを使い、imageにこのtagを指定します。配布物のインストール成功は実Provider疎通の成功を意味しません。

## 配布物そのもののE2E

`deploy/package-smoke.mjs`は別の一時ディレクトリにソースを展開し、保存したimageをloadしてから、固有名のComposeプロジェクトで起動します。認証付きAPIで三者の模擬会話を進め、製品CLIのonline backup/新規パスrestoreでDBを復元し、復元したDBで起動し直します。全公開原文と私有状態/記憶等9表の全列hashを前後比較します。内部ServiceやSQLを書き換えるfixtureではありません。

`install-e2e.json`はこの結果と実際のsource SHA/image IDを記録します。成功した場合だけ大きな配布artifactを公開し、失敗時も小さな証拠artifactを残します。通常はworkflowで実行してください。手元の再検証は空きport3000と独立したDocker環境が必要です。片付けで削除するのは試験が作った固有Compose volumeだけです。

```sh
# 明示SHA、既存ではない出力ディレクトリを指定する。
node deploy/package.mjs "$(git rev-parse HEAD)" ../new-bundle
node deploy/package-smoke.mjs ../new-bundle ../new-bundle/install-e2e.json
```

私有本番DBは配布物へ入れません。既存環境の移行・backup/restore・rollbackはOPERATIONS.mdに従います。実会話の読解評価、実Providerの形式遵守、長時間の実LLM運用と最終完成判定は別です。
