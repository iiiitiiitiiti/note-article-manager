# note記事管理

GitHub private リポジトリに置いた note 記事を、iPhone から確認・転送・公開済み管理する PWA です。記事本文はこのリポジトリにもビルド成果物にも含めず、ログイン後に GitHub API から取得します。

## 使い始める

```sh
npm install
npm run dev
```

画面で、`iiiitiiitiiti/note-articles` の Contents read/write だけを許可した fine-grained PAT を入力します。トークンは利用端末の localStorage に保存されます。共有端末では使わないでください。

## 主な機能

- 記事はカテゴリ別に一覧表示し、数字付きファイルは接頭辞の数字順に並べる
- 公開状態は、通常記事が「公開待ち」、Disney記事が `IDEAS.md` のレビュー状態に応じて「公開待ち／レビュー待ち」になる
- 記事一覧で画像準備の総数・未決定数・判断内訳を確認し、「画像未決定のみ」で絞り込める
- 記事を開いたときだけ Markdown 本文を取得
- `【画像…】` のプレースホルダーごとに、AI生成／自分で用意／不要の判断を管理
- 生成用プロンプトをコピーし、用意した画像を記事リポジトリへ登録して本文へ差し込み
- 画像登録を段階管理し、途中失敗時は続きから再試行・記事再読み込み・孤児画像の確認ができる
- タイトルと本文を別々にクリップボードへコピー
- コピーに失敗したときは選択可能なテキストエリアへフォールバック
- 手動コピー後もnote執筆画面へ移動できる
- note の公開 URL を入力して、1記事分だけ `status.json` を GitHub へ書き戻し
- ETag キャッシュと Contents API の SHA を分離して扱い、409 競合時は最新状態へ変更意図を再適用
- GitHub APIの401／403／404／409／レート制限／5xx／通信断を対象別に表示し、必要に応じて「設定を開く」「再試行」を提示

## status.json の初期化

初回だけ、記事リポジトリのローカル clone に対して実行します。

```sh
node scripts/init-status.mjs \
  --repo /path/to/note-articles
```

スクリプトは `README.md` の design キュー、各記事ファイルの接頭辞番号、`disney/IDEAS.md` のレビュー状態を照合します。`_docs/`、`assets/`、ルートの README、`disney/IDEAS.md` は記事として扱いません。既存の `published` と `draft` は再生成時も保持し、`queued`・`review`・`unset` は現在のルールから再計算します。既存の `status.json` は `--force` を指定しない限り上書きしません。

画像タスクは `image-status.json` に保存されます。記事リポジトリへのpush時に自動再生成され、既存の判断と登録段階は保持されます。登録段階は「未開始／画像登録済み／本文差し込み済み／状態保存済み」で、GitHub Contents APIにトランザクションがないため途中状態が残る場合があります。その場合は記事詳細の復旧操作から続きを再試行してください。記事本文から参照されていない記事別画像は、削除せず孤児画像の候補として確認できます。画像ファイルは5MB以下の PNG/JPEG/WebP/GIF を `カテゴリ/images/` に登録します。AI生成そのものはアプリ内で実行せず、生成用プロンプトのコピーまでを行います。

## 検証

```sh
npm test
npm run lint
npm run build
```

iPhone Safari とホーム画面に追加したPWAの実機確認は、[iPhone実機E2Eチェックリスト](docs/iphone-e2e-checklist.md)に沿って行います。クリップボード、note アプリへの遷移、note 側の Markdown 貼り付け変換、GitHub APIへの実データ書き込みは、fine-grained PATを設定した端末で確認してください。

## GitHub API エラーからの復旧

- PATが無効・期限切れ、または権限不足の場合は、エラー内の「設定を開く」からPATを再入力します。
- レート制限、一時的なGitHub障害、タイムアウト、オフラインの場合は、表示された待機時間や通信状態を確認して「再試行」を押します。自動で連続再試行はしません。
- 409競合では最新状態を取得してから再実行します。公開状況や画像判断の入力内容は、再試行のために画面から消しません。

## セキュリティ上の前提

外部 CDN・外部フォント・解析タグは使っていません。CSP、Markdown の raw HTML 無効化、DOMPurify によるサニタイズを有効にしています。それでも localStorage の PAT は XSS や端末共有に弱いため、権限を Contents read/write に限定し、有効期限を設定してください。
