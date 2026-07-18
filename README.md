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
- 記事を開いたときだけ Markdown 本文を取得
- `【画像…】` のプレースホルダーごとに、AI生成／自分で用意／不要の判断を管理
- 生成用プロンプトをコピーし、用意した画像を記事リポジトリへ登録して本文へ差し込み
- タイトルと本文を別々にクリップボードへコピー
- コピーに失敗したときは選択可能なテキストエリアへフォールバック
- note の公開 URL を入力して、1記事分だけ `status.json` を GitHub へ書き戻し
- ETag キャッシュと Contents API の SHA を分離して扱い、409 競合時は最新状態へ変更意図を再適用

## status.json の初期化

初回だけ、記事リポジトリのローカル clone に対して実行します。

```sh
node scripts/init-status.mjs \
  --repo /path/to/note-articles
```

スクリプトは `README.md` の design キュー、各記事ファイルの接頭辞番号、`disney/IDEAS.md` のレビュー状態を照合します。`_docs/`、`assets/`、ルートの README、`disney/IDEAS.md` は記事として扱いません。既存の `published` と `draft` は再生成時も保持し、`queued`・`review`・`unset` は現在のルールから再計算します。既存の `status.json` は `--force` を指定しない限り上書きしません。

画像タスクは `image-status.json` に保存されます。記事リポジトリへのpush時に自動再生成され、既存の判断は保持されます。画像ファイルは5MB以下の PNG/JPEG/WebP/GIF を `カテゴリ/images/` に登録します。AI生成そのものはアプリ内で実行せず、生成用プロンプトのコピーまでを行います。

## 検証

```sh
npm test
npm run lint
npm run build
```

iPhone Safari のクリップボード、note アプリへの遷移、note 側の Markdown 貼り付け変換は実機での確認が必要です。GitHub API への実データ書き込みも、fine-grained PAT を設定した端末で確認してください。

## セキュリティ上の前提

外部 CDN・外部フォント・解析タグは使っていません。CSP、Markdown の raw HTML 無効化、DOMPurify によるサニタイズを有効にしています。それでも localStorage の PAT は XSS や端末共有に弱いため、権限を Contents read/write に限定し、有効期限を設定してください。
