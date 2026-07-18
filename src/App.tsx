import { useCallback, useEffect, useMemo, useState } from "react";
import { GithubClient } from "./github";
import { buildImageAssetPath, getImageTaskState, MAX_IMAGE_BYTES } from "./image-plan";
import { bodyForNote, renderArticle } from "./markdown";
import { clearArticleReturnPath, clearToken, loadArticleReturnPath, loadToken, saveArticleReturnPath, saveToken } from "./storage";

const NOTE_COMPOSE_URL = "https://note.com/intent/post";
import type { ArticleContent, ArticlePath, ImageDecision, ImageStatusDocument, RepositorySnapshot } from "./types";

const CATEGORY_LABELS: Record<string, string> = {
  design: "design",
  "book-review": "書評",
  disney: "Disney",
  essay: "エッセイ",
  tools: "ツール",
  "web-review": "Webレビュー",
};

const IMAGE_DECISIONS: Array<{ value: ImageDecision; label: string }> = [
  { value: "pending", label: "未決定" },
  { value: "generate", label: "AIで生成" },
  { value: "provide", label: "自分で用意" },
  { value: "skip", label: "不要" },
];

const IMAGE_DECISION_LABELS: Record<ImageDecision, string> = Object.fromEntries(IMAGE_DECISIONS.map((item) => [item.value, item.label])) as Record<ImageDecision, string>;

export default function App() {
  const [token, setToken] = useState(loadToken);
  const [showSettings, setShowSettings] = useState(!token);
  const [returnPath, setReturnPath] = useState(loadArticleReturnPath);
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null);
  const [selectedCategory, setSelectedCategory] = useState("design");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [article, setArticle] = useState<ArticleContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [articleLoading, setArticleLoading] = useState(false);
  const [error, setError] = useState("");
  const client = useMemo(() => (token ? new GithubClient(token) : null), [token]);

  const reload = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError("");
    try {
      setSnapshot(await client.loadSnapshot());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "記事一覧の取得に失敗しました。");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (token && !showSettings) void reload();
  }, [reload, showSettings, token]);

  const openArticle = useCallback(async (path: string) => {
    if (!client) return;
    setSelectedPath(path);
    setArticle(null);
    setArticleLoading(true);
    setError("");
    try {
      const markdown = await client.getArticle(path);
      const initialArticle = renderArticle(markdown, path);
      const imageResults = await Promise.allSettled(initialArticle.localImagePaths.map(async (imagePath) => [imagePath, await client.getImageDataUrl(imagePath)] as const));
      const imageSources: Record<string, string> = {};
      const unavailableImages: string[] = [];
      for (const result of imageResults) {
        if (result.status === "fulfilled") imageSources[result.value[0]] = result.value[1];
        else unavailableImages.push(result.reason instanceof Error ? result.reason.message : "画像");
      }
      const nextArticle = renderArticle(markdown, path, imageSources);
      if (unavailableImages.length > 0) nextArticle.warnings.push("一部の画像をプレビューできません。画像ファイルの形式・サイズ・PAT権限を確認してください。");
      setArticle(nextArticle);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "記事本文の取得に失敗しました。");
    } finally {
      setArticleLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (!returnPath || !client || showSettings) return;
    clearArticleReturnPath();
    setReturnPath("");
    void openArticle(returnPath);
  }, [client, openArticle, returnPath, showSettings]);

  const handleTokenSave = (nextToken: string) => {
    saveToken(nextToken);
    setToken(nextToken.trim());
    setShowSettings(false);
    setSnapshot(null);
    setSelectedPath(null);
    setArticle(null);
  };

  const handleTokenClear = () => {
    clearToken();
    clearArticleReturnPath();
    setToken("");
    setShowSettings(true);
    setSnapshot(null);
    setSelectedPath(null);
    setArticle(null);
  };

  if (showSettings || !token) {
    return <SettingsScreen hasToken={Boolean(token)} onSave={handleTokenSave} onResume={() => setShowSettings(false)} onClear={handleTokenClear} />;
  }
  if (!client) {
    return <SettingsScreen hasToken={false} onSave={handleTokenSave} onResume={() => setShowSettings(false)} onClear={handleTokenClear} />;
  }

  if (selectedPath && (article || articleLoading)) {
    return (
      <ArticleScreen
        article={article}
        articleLoading={articleLoading}
        selectedPath={selectedPath}
        currentStatus={snapshot?.articles.find((item) => item.path === selectedPath)}
        client={client}
        imageStatus={snapshot?.imageStatus ?? { schemaVersion: 1, articles: {} }}
        onBack={() => { clearArticleReturnPath(); setSelectedPath(null); setArticle(null); setError(""); }}
        onPrepareNoteNavigation={() => saveArticleReturnPath(selectedPath)}
        onImageStatusSaved={(imageStatus) => setSnapshot((current) => current ? { ...current, imageStatus } : current)}
        onArticleUpdated={() => void openArticle(selectedPath)}
        onSaved={async (updatedStatus) => {
          setSnapshot((current) => current ? {
            ...current,
            status: updatedStatus,
            articles: current.articles.map((item) => {
              const next = updatedStatus.articles[item.path];
              return next ? { ...item, ...next } : item;
            }),
          } : current);
        }}
        error={error}
      />
    );
  }

  const categories = [...new Set(snapshot?.articles.map((item) => item.category) ?? [])];
  const visibleArticles = (snapshot?.articles ?? []).filter((item) => item.category === selectedCategory);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">NOTE ARTICLE MANAGER</p>
          <h1>記事を、公開できる状態にする。</h1>
        </div>
        <div className="header-actions">
          <button className="icon-button" type="button" onClick={() => void reload()} disabled={loading} aria-label="再読み込み">↻</button>
          <button className="text-button" type="button" onClick={() => setShowSettings(true)}>設定</button>
        </div>
      </header>

      {error && <ErrorNotice message={error} />}
      {loading && <p className="loading">GitHub から記事一覧を読み込んでいます…</p>}
      {snapshot && <RepositoryWarnings snapshot={snapshot} />}

      {snapshot && (
        <>
          <nav className="category-tabs" aria-label="記事の種別">
            {categories.map((category) => (
              <button
                className={category === selectedCategory ? "category-tab active" : "category-tab"}
                key={category}
                type="button"
                onClick={() => setSelectedCategory(category)}
              >
                {CATEGORY_LABELS[category] ?? category}
                <span>{snapshot.articles.filter((item) => item.category === category).length}</span>
              </button>
            ))}
          </nav>

          <section className="article-list" aria-label={`${CATEGORY_LABELS[selectedCategory] ?? selectedCategory}の記事`}>
            {visibleArticles.length === 0 && <p className="empty-state">この種別の記事はありません。</p>}
            {visibleArticles.map((item) => <ArticleListItem key={item.path} article={item} onOpen={openArticle} />)}
          </section>
        </>
      )}
    </main>
  );
}

function SettingsScreen({ hasToken, onSave, onResume, onClear }: { hasToken: boolean; onSave: (token: string) => void; onResume: () => void; onClear: () => void }) {
  const [value, setValue] = useState("");
  const canSave = value.trim().length > 0;
  return (
    <main className="app-shell narrow-shell">
      <p className="eyebrow">NOTE ARTICLE MANAGER</p>
      <h1>記事を、公開できる状態にする。</h1>
      <section className="settings-card">
        <h2>GitHub PAT を設定</h2>
        <p>private な <code>iiiitiiitiiti/note-articles</code> を読むための fine-grained PAT を、この端末だけに保存します。</p>
        <label htmlFor="pat">Personal access token</label>
        <input id="pat" type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" placeholder={hasToken ? "再入力する場合だけ入力" : "github_pat_…"} />
        <button className="primary-button" type="button" disabled={!canSave} onClick={() => onSave(value)}>この端末に保存して接続</button>
        {hasToken && <button className="secondary-button settings-resume-button" type="button" onClick={onResume}>保存済みトークンで一覧に戻る</button>}
        <ul className="fine-print">
          <li>Contents の read/write だけを許可した有効期限つき PAT を使ってください。</li>
          <li>トークンは URL・ログ・GitHub Pages の公開ファイルには出しません。</li>
          <li>ブラウザの localStorage に保存されるため、共有端末では使わないでください。</li>
        </ul>
        {hasToken && <button className="danger-button" type="button" onClick={onClear}>保存済みトークンを削除</button>}
      </section>
    </main>
  );
}

function RepositoryWarnings({ snapshot }: { snapshot: RepositorySnapshot }) {
  if (snapshot.missingStatusPaths.length === 0 && snapshot.orphanStatusPaths.length === 0) return null;
  return (
    <aside className="warning-panel" role="status">
      <strong>status.json と記事ツリーに差分があります。</strong>
      {snapshot.missingStatusPaths.length > 0 && <p>新規記事（公開待ち／Disneyはレビュー待ちとして仮表示）: {snapshot.missingStatusPaths.length} 件</p>}
      {snapshot.orphanStatusPaths.length > 0 && <p>孤児エントリ（自動削除していません）: {snapshot.orphanStatusPaths.length} 件</p>}
    </aside>
  );
}

function ArticleListItem({ article, onOpen }: { article: ArticlePath; onOpen: (path: string) => void }) {
  const filename = article.path.split("/").at(-1)?.replace(/\.md$/, "") ?? article.path;
  return (
    <button className="article-row" type="button" onClick={() => void onOpen(article.path)}>
      <span className="article-row-main">
        <span className="article-row-title">{article.queueOrder ? `${String(article.queueOrder).padStart(2, "0")} ` : ""}{filename.replace(/^\d+[_-]?/, "").replace(/[_-]+/g, " ")}</span>
        <span className="article-row-path">{article.path}</span>
      </span>
      <StatusBadge status={article.status} />
    </button>
  );
}

function ArticleScreen({ article, articleLoading, selectedPath, currentStatus, client, imageStatus, onBack, onPrepareNoteNavigation, onSaved, onImageStatusSaved, onArticleUpdated, error }: {
  article: ArticleContent | null;
  articleLoading: boolean;
  selectedPath: string;
  currentStatus?: ArticlePath;
  client: GithubClient;
  imageStatus: ImageStatusDocument;
  onBack: () => void;
  onPrepareNoteNavigation: () => void;
  onSaved: (document: RepositorySnapshot["status"]) => void;
  onImageStatusSaved: (document: ImageStatusDocument) => void;
  onArticleUpdated: () => void;
  error: string;
}) {
  const [manualCopy, setManualCopy] = useState<{ label: string; text: string } | null>(null);
  const [message, setMessage] = useState("");
  const [publishedUrl, setPublishedUrl] = useState(currentStatus?.publishedUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [imageBusy, setImageBusy] = useState("");

  const copy = (label: string, text: string, openNoteAfterCopy = false) => {
    setMessage("");
    setManualCopy(null);
    if (!navigator.clipboard?.writeText) {
      setManualCopy({ label, text });
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => {
        setMessage(`${label}をコピーしました。`);
        if (openNoteAfterCopy) {
          onPrepareNoteNavigation();
          window.location.assign(NOTE_COMPOSE_URL);
        }
      },
      () => setManualCopy({ label, text }),
    );
  };

  const savePublished = async () => {
    if (!article || !isHttpUrl(publishedUrl)) return;
    setSaving(true);
    setMessage("");
    try {
      const updated = await client.updateArticleStatus(selectedPath, {
        status: "published",
        publishedUrl: publishedUrl.trim(),
        publishedAt: new Date().toISOString(),
      });
      onSaved(updated);
      setMessage("公開済みとして保存しました。");
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : "保存に失敗しました。");
    } finally {
      setSaving(false);
    }
  };

  const saveImageDecision = async (taskId: string, decision: ImageDecision) => {
    setImageBusy(taskId);
    setMessage("");
    try {
      const updated = await client.updateImageTaskState(selectedPath, taskId, { decision, updatedAt: new Date().toISOString() });
      onImageStatusSaved(updated);
      setMessage(`画像の判断を「${IMAGE_DECISION_LABELS[decision]}」として保存しました。`);
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : "画像の判断の保存に失敗しました。");
    } finally {
      setImageBusy("");
    }
  };

  const uploadImage = async (taskId: string, file: File) => {
    const placeholder = article?.imagePlaceholders.find((item) => item.id === taskId);
    if (!placeholder) return;
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
      setMessage("画像は1バイト以上、5MB以下にしてください。");
      return;
    }
    if (!file.type.startsWith("image/")) {
      setMessage("画像ファイルを選択してください。");
      return;
    }
    setImageBusy(taskId);
    setMessage("");
    try {
      const assetPath = buildImageAssetPath(selectedPath, taskId, file.name);
      await client.uploadImage(assetPath, new Uint8Array(await file.arrayBuffer()));
      const assetName = assetPath.split("/images/").at(-1) ?? assetPath;
      await client.updateArticleWithImage(selectedPath, taskId, `![${placeholder.description}](images/${assetName})`);
      const currentState = getImageTaskState(imageStatus, selectedPath, taskId);
      const updated = await client.updateImageTaskState(selectedPath, taskId, {
        decision: currentState.decision === "pending" ? "provide" : currentState.decision,
        assetPath,
        updatedAt: new Date().toISOString(),
      });
      onImageStatusSaved(updated);
      onArticleUpdated();
      setMessage("画像を登録し、記事本文へ差し込みました。");
    } catch (uploadError) {
      setMessage(uploadError instanceof Error ? uploadError.message : "画像の登録に失敗しました。");
    } finally {
      setImageBusy("");
    }
  };

  return (
    <main className="app-shell">
      <header className="article-header">
        <button className="back-button" type="button" onClick={onBack}>← 一覧に戻る</button>
        <span className="article-row-path">{selectedPath}</span>
      </header>
      {error && <ErrorNotice message={error} />}
      {articleLoading && <p className="loading">本文を読み込んでいます…</p>}
      {article && (
        <>
          <section className="article-intro">
            <div className="article-intro-line"><StatusBadge status={currentStatus?.status ?? "unset"} />{article.warnings.length > 0 && <span className="warning-badge">note 非対応要素あり</span>}</div>
            <h1>{article.title}</h1>
            <div className="transfer-actions">
              <button className="primary-button" type="button" onClick={() => copy("タイトル", article.title, true)}>タイトルをコピー</button>
              <button className="secondary-button" type="button" onClick={() => copy("本文", article.body, true)}>本文をコピー</button>
            </div>
            {message && <p className="inline-message" role="status">{message}</p>}
            {manualCopy && <ManualCopy label={manualCopy.label} text={manualCopy.text} onClose={() => setManualCopy(null)} />}
            {article.warnings.length > 0 && <ul className="warning-list">{article.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
          </section>

          <section className="image-plan-card">
            <h2>画像の準備</h2>
            <p className="image-plan-intro">画像ごとに、AIで生成するか、自分で用意するか、不要かを管理できます。</p>
            {article.imagePlaceholders.length === 0 && <p className="empty-state">画像プレースホルダーはありません。</p>}
            {article.imagePlaceholders.map((placeholder, index) => {
              const state = getImageTaskState(imageStatus, selectedPath, placeholder.id);
              const busy = imageBusy === placeholder.id;
              return (
                <div className="image-task" key={placeholder.id}>
                  <div className="image-task-heading">
                    <strong>画像 {index + 1}{placeholder.optional ? "（任意）" : ""}</strong>
                    <span className={`image-decision image-decision-${state.decision}`}>{IMAGE_DECISION_LABELS[state.decision]}</span>
                  </div>
                  <p>{placeholder.description}</p>
                  <div className="image-decision-actions" role="group" aria-label={`画像${index + 1}の判断`}>
                    {IMAGE_DECISIONS.map((item) => <button className={item.value === state.decision ? "image-decision-button active" : "image-decision-button"} type="button" key={item.value} disabled={busy} onClick={() => void saveImageDecision(placeholder.id, item.value)}>{item.label}</button>)}
                  </div>
                  {state.decision === "generate" && <button className="secondary-button image-prompt-button" type="button" disabled={busy} onClick={() => copy("画像生成用プロンプト", buildImagePrompt(article.title, placeholder.description))}>生成用プロンプトをコピー</button>}
                  {state.assetPath && <p className="image-asset-path">登録済み: {state.assetPath}</p>}
                  <label className="secondary-button image-upload-button" htmlFor={`${placeholder.id}-upload`}>{busy ? "登録中…" : "画像を登録"}</label>
                  <input className="visually-hidden" id={`${placeholder.id}-upload`} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void uploadImage(placeholder.id, file); }} />
                </div>
              );
            })}
          </section>

          <section className="publish-card">
            <h2>公開状況</h2>
            <label htmlFor="published-url">公開済み note URL</label>
            <input id="published-url" type="url" value={publishedUrl} onChange={(event) => setPublishedUrl(event.target.value)} placeholder="https://note.com/..." />
            <button className="primary-button" type="button" disabled={saving || !isHttpUrl(publishedUrl)} onClick={() => void savePublished()}>{saving ? "保存中…" : "公開済みにする"}</button>
          </section>

          <article className="markdown-preview" dangerouslySetInnerHTML={{ __html: article.renderedHtml }} />
        </>
      )}
    </main>
  );
}

function buildImagePrompt(articleTitle: string, description: string): string {
  return `note記事「${articleTitle}」の本文画像を作成してください。\n\n画像の内容：${description}\n\n記事の雰囲気に合う、説明的で落ち着いた構図。文字を画像内に入れる場合は日本語を正確に表示し、権利上問題のある既存画像の転載や、実在人物・施設の誤認を招く表現は避けてください。`;
}

function ManualCopy({ label, text, onClose }: { label: string; text: string; onClose: () => void }) {
  return (
    <div className="manual-copy">
      <div className="manual-copy-heading"><strong>{label}を手動コピー</strong><button type="button" onClick={onClose}>閉じる</button></div>
      <textarea value={text} readOnly onFocus={(event) => event.currentTarget.select()} aria-label={`${label}の手動コピー用テキスト`} />
      <p>テキストエリアをタップして全選択し、コピーしてください。</p>
    </div>
  );
}

function StatusBadge({ status }: { status: ArticlePath["status"] }) {
  const labels = { queued: "公開待ち", review: "レビュー待ち", published: "公開済み", draft: "執筆中", unset: "未設定" };
  return <span className={`status-badge status-${status}`}>{labels[status]}</span>;
}

function ErrorNotice({ message }: { message: string }) {
  return <div className="error-notice" role="alert">{message}</div>;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
