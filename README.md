# note記事管理

GitHub private リポジトリに置いた note 記事を、iPhone から確認・転送・公開済み管理する PWA です。記事本文はこのリポジトリにもビルド成果物にも含めず、ログイン後に GitHub API から取得します。

## 使い始める

```sh
npm install
npm run dev
```

画面で、`iiiitiiitiiti/note-articles` の Contents read/write だけを許可した fine-grained PAT を入力します。保存するか、現在のセッションだけで使うかを選べます。保存済みトークンは設定画面から接続テストできます。

## 主な機能

- 記事はカテゴリ別に一覧表示し、数字付きファイルは接頭辞の数字順に並べる
- 公開状態は、通常記事が「公開待ち」、Disney記事が `IDEAS.md` のレビュー状態に応じて「公開待ち／レビュー待ち」になる
- 記事一覧で画像準備の総数・未決定数・判断内訳を確認し、「画像未決定のみ」で絞り込める
- 記事をファイル名・パスと公開状況で検索・複合フィルターできる
- 公開待ち・レビュー待ち・公開済み・画像未決定の件数をダッシュボードで確認し、全体公開順またはカテゴリ内順から予定日を算出できる
- 公開間隔は毎日・毎週・2週間ごと・曜日指定（毎週）から選べ、複数の曜日へ公開予定と通知を割り当てられる。全カテゴリの公開順を決めるAI用プロンプトは [公開順決定プロンプト](docs/publication-order-prompt.md) にまとめている
- 公開予定日の朝にiPhoneへ通知するWeb Push購読を登録できる（初回だけGitHub SecretsとPagesの公開変数設定が必要）
- 全記事を対象に、note非対応要素・壊れた画像参照・未決定画像・画像登録途中を検査できる
- 記事を開いたときだけ Markdown 本文を取得
- `【画像…】` のプレースホルダーごとに、AI生成／自分で用意／不要の判断を管理
- 生成用プロンプトをコピーし、用意した画像を記事リポジトリへ登録して本文へ差し込み
- 画像登録を段階管理し、途中失敗時は続きから再試行・記事再読み込み・孤児画像の確認ができる
- タイトルと本文を別々にクリップボードへコピー
- 本文は note 貼り付け用と原文 Markdown を選択でき、未対応要素があると note 用コピーを止めて対象行と手動対応を示す
- コピーに失敗したときは選択可能なテキストエリアへフォールバック
- タイトルと本文をコピーでき、最初のコピー時だけnote執筆画面へ移動する。同じ記事の2回目以降は新しい執筆画面を開かず、既存の下書きへ貼り付ける本文だけをコピーする
- note の公開 URL を入力して、1記事分だけ `status.json` を GitHub へ書き戻し
- ETag キャッシュと Contents API の SHA を分離して扱い、409 競合時は最新状態へ変更意図を再適用
- 記事一覧・表示中の画面は5分間隔でGitHubへ条件付き確認を行い、Safari／PWAのフォアグラウンド復帰時にも確認する。復帰直後30秒以内の重複確認は抑制し、1回の確認でGit Tree・`status.json`・`image-status.json`のみを取得する（304時は本文・画像を取得しない）
- GitHub APIの401／403／404／409／レート制限／5xx／通信断を対象別に表示し、必要に応じて「設定を開く」「再試行」を提示
- 設定画面で保存済みPATの接続・読み取り・書き込み権限を確認し、期限切れと権限不足を区別して案内
- 画像アセットをGit Tree・記事本文・`image-status.json`と照合し、未参照・壊れた参照・状態だけ残った候補を確認できる。削除は対象を選び、明示確認した場合だけ実行する

## status.json の初期化

初回だけ、記事リポジトリのローカル clone に対して実行します。

```sh
node scripts/init-status.mjs \
  --repo /path/to/note-articles
```

スクリプトは `README.md` の design キュー、各記事ファイルの接頭辞番号、`disney/IDEAS.md` のレビュー状態を照合します。`_docs/`、`assets/`、ルートの README、`disney/IDEAS.md` は記事として扱いません。既存の `published` と `draft` は再生成時も保持し、`queued`・`review`・`unset` は現在のルールから再計算します。既存の `status.json` は `--force` を指定しない限り上書きしません。

画像タスクは `image-status.json` に保存されます。記事リポジトリへのpush時に自動再生成され、既存の判断と登録段階は保持されます。登録段階は「未開始／画像登録済み／本文差し込み済み／状態保存済み」で、GitHub Contents APIにトランザクションがないため途中状態が残る場合があります。その場合は記事詳細の復旧操作から続きを再試行してください。記事本文から参照されていない記事別画像は、一覧の「画像アセット管理」から削除候補として確認できます。削除は自動ではなく、Gitの履歴から復元できます。画像ファイルは5MB以下の PNG/JPEG/WebP/GIF を `カテゴリ/images/` に登録します。AI生成そのものはアプリ内で実行せず、生成用プロンプトのコピーまでを行います。連携方針は [AI画像生成連携の設計](docs/ai-image-generation-design.md) にまとめています。

## PATの作成・接続確認

GitHubの Settings → Developer settings → Personal access tokens → Fine-grained tokens から、次の条件で作成します。

- Repository access: `Only select repositories` → `iiiitiiitiiti/note-articles`
- Repository permissions: `Contents` を `Read and write`
- Expiration: 期限を設定し、期限が来たら新しいPATへ更新

アプリの設定画面では、保存済みトークンを再入力する前に「保存済みトークンをテスト」を押せます。読み取りに失敗した場合は、PATの期限・対象リポジトリ・Contents権限を確認してください。読み取りは成功して書き込みが「未確認」と表示される場合は、実際の公開状況や画像判断の保存時に書き込み権限が判定されます。PATはURLや公開ファイルへ送らず、ログにも記録しません。

「次回起動時もこのトークンを使う」のチェックを外すと、PATはlocalStorageへ保存されず、タブを閉じるまでの接続になります。既存の保存済みPATは、設定画面の接続テスト・再入力・削除からそのまま利用できます。

## note貼り付け用Markdownの範囲

見出し、段落、改行、箇条書き、引用、コード、リンク、強調はnote貼り付け用本文へ変換します。記事に表、Markdown画像、raw HTMLがある場合は、対象行と手動対応を表示し、note用本文のコピーを止めます。原文Markdownへ切り替えると、変換前の本文を確認・コピーできます。

画像は、記事詳細の画像準備で登録する画像と、note側で本文へ手動アップロードする画像を別の作業として扱います。アプリはnoteの非公式APIや執筆画面への自動入力を行わないため、note側の画像挿入・表の作り直し・HTMLの置き換えは手動で確認してください。

## 公開ダッシュボードと通知

ダッシュボードでは、公開待ち記事を公開順から予定日に並べ、開始日時と公開間隔からこの端末向けの予定を表示します。全カテゴリを選んだ場合は、`status.json` の `publicationOrder` を優先し、未設定の記事はカテゴリ内の `queueOrder` 順で後ろに続きます。予定設定はlocalStorageに保存され、GitHubのstatus.jsonは変更しません。レビュー待ちの記事は、レビュー通過後に公開待ちへ変わった時点で予定へ入ります。

公開間隔は「毎日」「毎週」「2週間ごと」「曜日を指定（毎週）」から選べます。曜日指定では、選択した曜日ごとに1記事ずつ予定を割り当てます。通知を有効にしている場合は、同じ公開予定日の通知が設定時刻に送られます。

通知時刻は日本時間の09:00を初期値とし、15分単位で変更できます。通知を有効にすると、PWAのService WorkerがPush購読を作成し、`notification-config.json`としてprivate記事リポジトリへ保存します。private記事リポジトリのGitHub Actionsは15分ごとに当日の公開予定を確認し、対象記事ごとに一度だけ「〇〇の公開予定日です」と通知します。公開済みになった記事は通知対象から外れます。

初回だけ、次の設定が必要です。

1. `npx --yes web-push@3.6.7 generate-vapid-keys`でVAPID鍵を1組だけ生成する。秘密鍵は再生成せず、GitHub以外へ公開しない。
2. publicリポジトリ `iiiitiiitiiti/note-article-manager` の Settings → Secrets and variables → Actions → Variables に、公開鍵を `VITE_VAPID_PUBLIC_KEY` として登録する。
3. private記事リポジトリ `iiiitiiitiiti/note-articles` の Actions Secrets に、秘密鍵を `VAPID_PRIVATE_KEY`、通知の連絡先を `VAPID_SUBJECT`（例: `mailto:iiiitiiitiiti@users.noreply.github.com`）として登録する。
4. iPhoneでPagesをホーム画面に追加し、PWAから公開スケジュールを設定して「公開予定通知を有効にする」を押す。表示された通知許可を許可する。

GitHub Pagesだけでは時刻になった通知を送れないため、送信処理はprivate記事リポジトリのActionsで実行します。VAPID公開鍵は購読に使う公開情報ですが、秘密鍵とPATは公開ファイルへ置きません。GitHub Actionsの実行遅延に備え、設定時刻から1時間以内の実行を同じ通知枠として扱い、再実行による重複送信を抑止します。

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
