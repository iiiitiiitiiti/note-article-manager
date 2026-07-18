# note記事管理

GitHub private リポジトリに置いた note 記事を、iPhone から確認・転送・公開済み管理する PWA です。記事本文はこのリポジトリにもビルド成果物にも含めず、ログイン後に GitHub API から取得します。

## 使い始める

```sh
npm install
npm run dev
```

画面で、`iiiitiiitiiti/note-articles` の Contents read/write だけを許可した fine-grained PAT を入力します。トークンは利用端末の localStorage に保存されます。共有端末では使わないでください。

## 主な機能

- `design/` は `status.json` の `queueOrder` 順、それ以外はフォルダ別に一覧表示
- 記事を開いたときだけ Markdown 本文を取得
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

スクリプトは `README.md` の design キューと実ファイルを照合します。`_docs/`、`assets/`、ルートの README、`disney/IDEAS.md` は記事として扱いません。既存の `status.json` は `--force` を指定しない限り上書きしません。

## 検証

```sh
npm test
npm run lint
npm run build
```

iPhone Safari のクリップボード、note アプリへの遷移、note 側の Markdown 貼り付け変換は実機での確認が必要です。GitHub API への実データ書き込みも、fine-grained PAT を設定した端末で確認してください。

## セキュリティ上の前提

外部 CDN・外部フォント・解析タグは使っていません。CSP、Markdown の raw HTML 無効化、DOMPurify によるサニタイズを有効にしています。それでも localStorage の PAT は XSS や端末共有に弱いため、権限を Contents read/write に限定し、有効期限を設定してください。
