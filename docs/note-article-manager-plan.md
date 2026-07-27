# note 記事管理 PWA（note-article-manager）実装プラン

## Context

note へ投稿した/投稿予定の記事は GitHub private リポジトリ `iiiitiiitiiti/note-articles`（154ファイル、正本。ローカルは Drive の `Bookmarklet plug-in/article`）で管理しているが、公開順キュー・公開済み状況は README.md のテキストにしか無く、一覧性がない。また記事を note に載せる際は毎回手作業でコピーしている。

これを解決する PWA を作る：**記事一覧＋公開ステータス管理＋「ボタン1個で note 転送（公開1歩手前まで）」**。

### 設計判断（deep-design 済み・ユーザー確認済み）

- **受け渡し方式は段階導入**。note に公式投稿 API は無い。非公式 API（`/api/v3/drafts`）で下書き自動作成は可能だが、2026年5月に認証の破壊的変更（reCAPTCHA v3 必須化）があった実績があり壊れやすく、規約グレー。
  - **Phase 1（本プラン）**: クリップボード方式。note エディタは markdown 貼り付け変換（h2/h3・リスト等）に対応しているため、「タイトル/本文をコピー → note エディタを開く → 貼り付け」で確実に公開1歩手前まで行ける。
  - **Phase 2（本プランのスコープ外・将来検討)**: 非公式 API による下書き自動作成。ブックマークレット資産（same-origin fetch なら cookie 問題を回避できる）との組み合わせを検討。
- **主端末は iPhone**（ホーム画面追加）。Mac ブラウザでも動くが最適化は iPhone 優先。
- **ステータスは `status.json` をリポジトリに新設**し、PWA から GitHub Contents API で書き戻す。README のキュー情報は初回に変換する。
- 不採用案: note 公開状況の RSS 自動検出（タイトル照合が不安定、書き戻し方式で十分）／Firebase バックエンド（静的+GitHub API で足りる。zoo-aquarium-log と違い共有不要の1人用）。

## 構成

- **新規公開リポジトリ** `note-article-manager`（`~/dev/note-article-manager`）＋ GitHub Pages 配信。
  - note-articles は private のため Pages 不可（無料プラン）。記事本文はビルドに含めず、**実行時に GitHub API から取得**するので公開リポジトリに記事は載らない。
- **スタック**: Vite + React + TypeScript + vite-plugin-pwa。md レンダリングは `marked` + `dompurify`（zoo-aquarium-log と同じ組み合わせを流用。参考: [package.json](~/dev/zoo-aquarium-log/package.json)）。
- **認証**: fine-grained PAT（note-articles の contents read/write のみ・有効期限つき）を初回起動時に入力させ `localStorage` に保存。トークンはデバイス外に出ない。
  - リスク受容事項: localStorage 保存は XSS で漏れうる（漏れると記事本文も書き換え可能な権限になる）。対策として **外部リソースゼロ**（CDN・外部フォント・解析なし）、CSP meta 設定、marked の raw HTML 無効化＋DOMPurify、設定画面に「トークン削除」ボタン、PAT を URL・ログに出さない。毎回入力は iPhone 運用に耐えないため保存自体は維持する。

## データ設計

`note-articles` リポジトリ直下に `status.json` を新設：

```json
{
  "schemaVersion": 1,
  "articles": {
    "design/01_....md": {
      "status": "queued",          // queued | published | draft(執筆中) | unset
      "queueOrder": 1,              // design/ のみ。README の掲載順キューを反映
      "publishedUrl": null,        // published のとき必須
      "publishedAt": null
    }
  }
}
```

- 初期生成は Node スクリプト（`scripts/init-status.mjs`、note-article-manager 側に置きローカル実行）。リポジトリツリーから全 md を列挙し（記事フォルダ以外の `_docs/`・`assets/`・ルート直下 README.md は除外）、design/ は README のファイル名先頭番号を queueOrder に変換（重複・欠番はスクリプトで検証）。公開済み情報が README に無いフォルダ（book-review 等）は `unset` で初期化し、PWA 上で後から埋める。
- PWA 側でツリーと status.json を突き合わせ、status.json に無い新規 md は `unset` として表示、md が消えた孤児エントリは無視＋警告表示（自動削除はしない）。
- PWA からの更新は Contents API の PUT（sha 付き更新、コミットメッセージは `status: <path> → published` 形式）。**更新は常に「1記事分のパッチ」として持ち、409（sha 競合）時は最新を再取得→パッチ再適用→再 PUT**。書き込みは直列化する（連打対策）。iPhone/Mac の2デバイス併用でも単純上書きによる取りこぼしを防ぐ。
- **掲載順の並べ替えは Phase 1 では UI 化しない**（design/ の順序は「前回」参照の連鎖という本文制約に縛られ、並べ替え判断は結局 Claude セッションで行うため）。従来通り README/status.json の編集で変更する。

## 画面・機能（Phase 1）

1. **一覧画面**: フォルダ（種別）タブ＋ステータスバッジ。design/ タブは queueOrder 順に表示し「次に公開する記事」が先頭に来る。一覧は Git Tree API（再帰1回）で取得し、本文は開いた記事だけ遅延取得。status.json とツリーには ETag（If-None-Match）を使う。
2. **記事画面**: md プレビュー（marked + dompurify、raw HTML 無効化）。記事内にテーブル・md 画像記法・raw HTML が含まれる場合は「note では変換されない要素あり」と**記事ごとに警告バッジ**を出す。
3. **note 転送**: 「タイトルをコピー」「本文をコピー」ボタン（note はタイトル欄が別なので2ボタン。本文コピー時に H1 とフロントマターを除去）→「note で開く」ボタンで `https://note.com/notes/new` を開く（iPhone で note アプリが開くかは**未検証**。開かなければ Safari の note Web エディタで貼り付け、という運用も可）。iOS Safari の制約により `clipboard.writeText` は**クリックイベント直下で同期的に呼ぶ**（本文は記事を開いた時点で取得済みにしておく）。失敗時（NotAllowedError 等）は本文を選択可能なテキストエリアで表示する手動コピーにフォールバック。
4. **ステータス変更**: 記事画面から「公開済みにする」（note URL 入力欄つき）→ status.json を書き戻し。
5. **PWA**: manifest + service worker（アプリシェルのみキャッシュ。private な記事本文は SW の永続キャッシュに入れない）でホーム画面追加対応。GitHub Pages のサブパス配信に合わせ Vite `base` と SW `scope` を設定。

## 実装ステップ

| # | ステップ | 完了確認 | 担当（§7 采配） |
|---|---|---|---|
| 1 | `~/dev/note-article-manager` を Vite + React + TS + vite-plugin-pwa で雛形作成、GitHub 公開リポジトリ作成 | `npm run dev` が起動 | Sonnet サブエージェント |
| 2 | `scripts/init-status.mjs` 実装 → note-articles に `status.json` を生成・コミット | 生成 JSON の件数=md 件数、design/ の順序が README と一致（目視） | Sonnet |
| 3 | GitHub API クライアント＋PAT 設定画面（localStorage） | dev サーバーで一覧が実データ表示 | Sonnet |
| 4 | 一覧・記事・転送・ステータス書き戻しの各画面 | Playwright MCP で操作確認、書き戻しコミットが note-articles に載る | Sonnet（UI 見直しは Fable） |
| 5 | PWA 化＋GitHub Pages デプロイ（deploy スキル準拠） | 公開 URL 表示・iPhone ホーム追加はユーザー確認 | Sonnet、最終確認 Fable |
| 6 | vault へ entities ページ追加（[[note-article-manager]]）、Worklog 追記、Windows への引き継ぎ要否確認 | INDEX.md に1行追加 | Fable |

実装は3ファイル超のため、着手時に **deep-code** を呼ぶ。

## 検証

- 実装前の下調べ: 記事154ファイル中のテーブル・md 画像記法・raw HTML・フロントマターの実使用状況を grep で確認し、警告バッジと本文整形の仕様に反映する。
- `npm run lint`（tsc）＋ dev サーバーで Playwright MCP による画面操作（一覧→記事→コピー→ステータス変更）。
- status.json 書き戻しは、まず**テストブランチ**に対して行い 409 競合（2回連続更新で sha ずれを再現）も確認してから main 向けに切り替える。書き戻し後 `gh api` でコミットを確認。
- iPhone 実機での「note アプリ遷移」「長文日本語のクリップボードコピー」「貼り付けで markdown 変換」は**完了条件に含め**、ユーザー確認に委ねる（結果を README とプラン記録に残す）。

## リスク・未検証事項

- `note.com/notes/new` が iPhone で note アプリを開くかは未検証（開かなくても Web エディタで成立）。
- note エディタの markdown 貼り付け変換は h2/h3・リスト等に限られる。テーブルは非対応（既に記事側ルールで排除済み）。画像は手動アップロードのまま。
- iOS の `clipboard.writeText` は1万字級の日本語で既知の固定上限は無いが実機未検証。フォールバック（手動コピー表示)を用意。
- PAT の失効時は設定画面から再入力。localStorage 保存のリスクは上記「認証」節の対策込みで受容する。

## Codex レビュー

§8 に従い ExitPlanMode 前に codex-skill でレビューを実施（codex exec v0.144.1 / gpt-5.6-luna / reasoning xhigh で実行し回答を取得。ただし回答末尾に「app-server を初期化できず、公式仕様を確認した独立レビューである」旨の注記があった。回答自体は出典つきで具体的だったため、内容を精査のうえ採用判断した）。

**主な指摘と反映**:

- PAT の localStorage 保存は条件付き許容（ログアウト手段・外部リソースゼロ・CSP・raw HTML 無効化・権限最小化）→ **反映**（構成の「認証」節にリスク受容事項として明記）
- 409 競合時の「全体再PUT」は他端末の変更を上書きしうる → **反映**（1記事分パッチ＋再取得→パッチ再適用、書き込み直列化）
- status.json に schemaVersion・孤児/新規検出・queueOrder 検証を追加 → **反映**
- 一覧は Tree API 1回＋本文遅延取得、status/tree に ETag → **反映**
- クリップボードはクリックイベント直下で同期呼び出し＋失敗時フォールバック → **反映**
- テーブル・画像・raw HTML の記事ごと警告バッジ、実使用状況の事前 grep → **反映**
- 実機検証（コピー・note 遷移・PWA scope）を完了条件へ → **反映**
- キュー並べ替え UI の欠落指摘 → **仕様として明記**（Phase 1 は UI 化しない。並べ替え判断は本文の「前回」参照制約に縛られ Claude セッションで行うため）

**見送った指摘**:

- status.json を別リポジトリに分離し PAT を read-only 化する案 → リポジトリ2つ・PAT 2本の運用複雑化が1人用途に見合わない
- OAuth＋バックエンド案 → 「静的＋GitHub API で完結」の制約に反するため Phase 1 では不採用（Codex 自身も同判断）
- CI での GitHub API モック → Phase 1 は CI 自体を最小限（tsc のみ）とするため対象外
