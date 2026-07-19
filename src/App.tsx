import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { GithubClient, type ConnectionTestResult } from "./github";
import { GithubApiError } from "./github-errors";
import { buildPublicationSchedule, DEFAULT_SCHEDULE } from "./schedule";
import { buildImageAssetPath, getImageTaskState, MAX_IMAGE_BYTES, summarizeImageTasks } from "./image-plan";
import { bodyForNote, renderArticle } from "./markdown";
import { clearArticleReturnPath, clearToken, loadArticleReturnPath, loadPublicationSchedule, loadToken, saveArticleReturnPath, savePublicationSchedule, saveToken } from "./storage";

const NOTE_COMPOSE_URL = "https://note.com/intent/post";
import type { ArticleContent, ArticleHealthReport, ArticlePath, ArticleStatus, ImageDecision, ImageInventory, ImageProgressSummary, ImageRegistrationStage, ImageStatusDocument, NoteTransferMode, PublicationScheduleConfig, RepositorySnapshot } from "./types";

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
const IMAGE_STAGE_LABELS: Record<ImageRegistrationStage, string> = {
  "not-started": "未開始",
  "asset-uploaded": "画像登録済み",
  "article-updated": "本文差し込み済み",
  completed: "状態保存済み",
};

type ArticleOperationError = {
  error: Error;
  retry: () => void;
  reloadArticle?: () => void;
  checkOrphans?: () => void;
};

type SyncPhase = "idle" | "checking" | "updated" | "unchanged" | "error";

type SyncState = {
  phase: SyncPhase;
  checkedAt: number | null;
  error: Error | null;
};

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const FOREGROUND_COOLDOWN_MS = 30 * 1000;

export default function App() {
  const [token, setToken] = useState(loadToken);
  const [showSettings, setShowSettings] = useState(!token);
  const [returnPath, setReturnPath] = useState(loadArticleReturnPath);
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null);
  const [selectedCategory, setSelectedCategory] = useState("design");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | ArticleStatus>("all");
  const [showPendingImagesOnly, setShowPendingImagesOnly] = useState(false);
  const [schedule, setSchedule] = useState<PublicationScheduleConfig>(() => loadPublicationSchedule(DEFAULT_SCHEDULE));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [article, setArticle] = useState<ArticleContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [articleLoading, setArticleLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [pendingSnapshot, setPendingSnapshot] = useState<RepositorySnapshot | null>(null);
  const [syncState, setSyncState] = useState<SyncState>({ phase: "idle", checkedAt: null, error: null });
  const syncInFlightRef = useRef(false);
  const lastCheckedAtRef = useRef(0);
  const selectedPathRef = useRef<string | null>(null);
  const client = useMemo(() => (token ? new GithubClient(token) : null), [token]);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  const sync = useCallback(async (reason: "initial" | "manual" | "automatic") => {
    if (!client) return;
    if (syncInFlightRef.current) return;
    const now = Date.now();
    if (reason === "automatic" && now - lastCheckedAtRef.current < FOREGROUND_COOLDOWN_MS) return;
    syncInFlightRef.current = true;
    setLoading(reason !== "automatic");
    setSyncState((current) => ({ ...current, phase: "checking", error: null }));
    try {
      const result = await client.checkForUpdates();
      const checkedAt = Date.now();
      lastCheckedAtRef.current = checkedAt;
      if (result.changed && selectedPathRef.current) {
        setPendingSnapshot(result.snapshot);
      } else if (result.changed) {
        setSnapshot(result.snapshot);
        setPendingSnapshot(null);
      }
      setSyncState({ phase: result.changed ? "updated" : "unchanged", checkedAt, error: null });
      if (!selectedPathRef.current) setError(null);
    } catch (loadError) {
      const syncError = toError(loadError, "記事一覧の自動更新に失敗しました。");
      lastCheckedAtRef.current = Date.now();
      setSyncState({ phase: "error", checkedAt: lastCheckedAtRef.current, error: syncError });
      if (!selectedPathRef.current) setError(syncError);
    } finally {
      setLoading(false);
      syncInFlightRef.current = false;
    }
  }, [client]);

  useEffect(() => {
    if (token && !showSettings) void sync("initial");
  }, [showSettings, sync, token]);

  useEffect(() => {
    if (!token || showSettings || !client) return;
    const checkForeground = () => {
      if (document.visibilityState === "visible") void sync("automatic");
    };
    const intervalId = window.setInterval(() => void sync("automatic"), SYNC_INTERVAL_MS);
    document.addEventListener("visibilitychange", checkForeground);
    window.addEventListener("focus", checkForeground);
    window.addEventListener("pageshow", checkForeground);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", checkForeground);
      window.removeEventListener("focus", checkForeground);
      window.removeEventListener("pageshow", checkForeground);
    };
  }, [client, showSettings, sync, token]);

  const applyPendingSnapshot = () => {
    if (!pendingSnapshot) return;
    setSnapshot(pendingSnapshot);
    setPendingSnapshot(null);
    setSyncState((current) => ({ ...current, phase: "updated" }));
  };

  const reload = () => void sync("manual");

  const openArticle = useCallback(async (path: string) => {
    if (!client) return;
    setSelectedPath(path);
    setArticle(null);
    setArticleLoading(true);
    setError(null);
    try {
      const markdown = await client.getArticle(path);
      const initialArticle = renderArticle(markdown, path);
      const imageResults = await Promise.allSettled(initialArticle.localImagePaths.map(async (imagePath) => [imagePath, await client.getImageDataUrl(imagePath)] as const));
      const imageSources: Record<string, string> = {};
      const unavailableImages: string[] = [];
      const unavailableImageErrors: Error[] = [];
      for (const result of imageResults) {
        if (result.status === "fulfilled") imageSources[result.value[0]] = result.value[1];
        else {
          const imageError = toError(result.reason, "画像を取得できませんでした。");
          unavailableImages.push(imageError.message);
          unavailableImageErrors.push(imageError);
        }
      }
      const nextArticle = renderArticle(markdown, path, imageSources);
      if (unavailableImages.length > 0) nextArticle.warnings.push(`画像のプレビューに失敗しました。${unavailableImages.join(" / ")}`);
      setArticle(nextArticle);
      const actionableImageError = unavailableImageErrors.find((imageError) => imageError instanceof GithubApiError && imageError.action !== "none");
      if (actionableImageError) setError(actionableImageError);
    } catch (loadError) {
      setError(toError(loadError, "記事本文の取得に失敗しました。"));
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

  const testConnection = useCallback(async (): Promise<ConnectionTestResult> => {
    if (!client) throw new Error("保存済みトークンがありません。");
    return client.testConnection();
  }, [client]);

  const handleTokenSave = (nextToken: string, persist: boolean) => {
    if (persist) saveToken(nextToken);
    else clearToken();
    setToken(nextToken.trim());
    setShowSettings(false);
    setSnapshot(null);
    setPendingSnapshot(null);
    setSelectedPath(null);
    setArticle(null);
    setError(null);
    setSyncState({ phase: "idle", checkedAt: null, error: null });
    lastCheckedAtRef.current = 0;
  };

  const handleTokenClear = () => {
    clearToken();
    clearArticleReturnPath();
    setToken("");
    setShowSettings(true);
    setSnapshot(null);
    setPendingSnapshot(null);
    setSelectedPath(null);
    setArticle(null);
    setError(null);
    setSyncState({ phase: "idle", checkedAt: null, error: null });
    lastCheckedAtRef.current = 0;
  };

  const openSettings = () => {
    applyPendingSnapshot();
    setShowSettings(true);
    setSelectedPath(null);
    setArticle(null);
    setError(null);
  };

  const updateSchedule = (next: PublicationScheduleConfig) => {
    setSchedule(next);
    savePublicationSchedule(next);
  };

  if (showSettings || !token) {
    return <SettingsScreen hasToken={Boolean(token)} onSave={handleTokenSave} onTestConnection={testConnection} onResume={() => setShowSettings(false)} onClear={handleTokenClear} />;
  }
  if (!client) {
    return <SettingsScreen hasToken={false} onSave={handleTokenSave} onTestConnection={testConnection} onResume={() => setShowSettings(false)} onClear={handleTokenClear} />;
  }

  if (selectedPath && (article || articleLoading || error)) {
    return (
      <ArticleScreen
        article={article}
        articleLoading={articleLoading}
        selectedPath={selectedPath}
        currentStatus={snapshot?.articles.find((item) => item.path === selectedPath)}
        client={client}
        imageStatus={snapshot?.imageStatus ?? { schemaVersion: 1, articles: {} }}
        onBack={() => { applyPendingSnapshot(); clearArticleReturnPath(); setSelectedPath(null); setArticle(null); setError(null); }}
        onPrepareNoteNavigation={() => saveArticleReturnPath(selectedPath)}
        onImageStatusSaved={(imageStatus) => {
          setSnapshot((current) => current ? { ...current, imageStatus } : current);
          setPendingSnapshot((current) => current ? { ...current, imageStatus } : current);
        }}
        onArticleUpdated={() => void openArticle(selectedPath)}
        onSaved={async (updatedStatus) => {
          const applyStatus = (current: RepositorySnapshot | null) => current ? {
            ...current,
            status: updatedStatus,
            articles: current.articles.map((item) => {
              const next = updatedStatus.articles[item.path];
              return next ? { ...item, ...next } : item;
            }),
          } : current;
          setSnapshot(applyStatus);
          setPendingSnapshot(applyStatus);
        }}
        error={error}
        onRetry={() => void openArticle(selectedPath)}
        onSyncRetry={reload}
        onOpenSettings={openSettings}
        syncState={syncState}
        hasPendingSnapshot={Boolean(pendingSnapshot)}
        onApplyPendingSnapshot={applyPendingSnapshot}
      />
    );
  }

  const categories = [...new Set(snapshot?.articles.map((item) => item.category) ?? [])];
  const categoryArticles = (snapshot?.articles ?? []).filter((item) => item.category === selectedCategory);
  const pendingImageArticleCount = categoryArticles.filter((item) => summarizeImageTasks(snapshot?.imageStatus ?? { schemaVersion: 1, articles: {} }, item.path).pending > 0).length;
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase("ja");
  const visibleArticles = categoryArticles.filter((item) => {
    const matchesStatus = statusFilter === "all" || item.status === statusFilter;
    const matchesQuery = !normalizedQuery || `${item.path} ${articleDisplayName(item)}`.toLocaleLowerCase("ja").includes(normalizedQuery);
    const matchesImage = !showPendingImagesOnly || summarizeImageTasks(snapshot?.imageStatus ?? { schemaVersion: 1, articles: {} }, item.path).pending > 0;
    return matchesStatus && matchesQuery && matchesImage;
  });

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">NOTE ARTICLE MANAGER</p>
          <h1>記事を、公開できる状態にする。</h1>
        </div>
        <div className="header-actions">
          <button className="icon-button" type="button" onClick={() => void reload()} disabled={loading || syncState.phase === "checking"} aria-label="再読み込み">↻</button>
          <button className="text-button" type="button" onClick={openSettings}>設定</button>
        </div>
      </header>

      {error && <ErrorNotice error={error} onRetry={reload} onOpenSettings={openSettings} />}
      {loading && <p className="loading">GitHub から記事一覧を読み込んでいます…</p>}
      <SyncStatus state={syncState} onRetry={reload} />
      {snapshot && <RepositoryWarnings snapshot={snapshot} />}
      {snapshot && <DashboardPanel snapshot={snapshot} schedule={schedule} onScheduleChange={updateSchedule} />}
      <HealthCheckPanel client={client} />
      <ImageInventoryPanel client={client} />

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
            <button
              className={showPendingImagesOnly ? "category-filter active" : "category-filter"}
              type="button"
              aria-pressed={showPendingImagesOnly}
              onClick={() => setShowPendingImagesOnly((current) => !current)}
            >
              画像未決定のみ<span>{pendingImageArticleCount}</span>
            </button>
          </nav>

          <section className="list-controls" aria-label="記事の検索と絞り込み">
            <label htmlFor="article-search">記事を検索</label>
            <input id="article-search" type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="ファイル名・パスで検索" />
            <label htmlFor="status-filter">公開状況</label>
            <select id="status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | ArticleStatus)}>
              <option value="all">すべて</option>
              <option value="queued">公開待ち</option>
              <option value="review">レビュー待ち</option>
              <option value="published">公開済み</option>
              <option value="draft">執筆中</option>
              <option value="unset">未設定</option>
            </select>
            <span className="list-result-count">{visibleArticles.length}件表示</span>
          </section>

          <section className="article-list" aria-label={`${CATEGORY_LABELS[selectedCategory] ?? selectedCategory}の記事`}>
            {visibleArticles.length === 0 && <p className="empty-state">{normalizedQuery || statusFilter !== "all" || showPendingImagesOnly ? "条件に一致する記事はありません。" : "この種別の記事はありません。"}</p>}
            {visibleArticles.map((item) => <ArticleListItem key={item.path} article={item} imageProgress={summarizeImageTasks(snapshot.imageStatus, item.path)} onOpen={openArticle} />)}
          </section>
        </>
      )}
    </main>
  );
}

function SettingsScreen({ hasToken, onSave, onTestConnection, onResume, onClear }: { hasToken: boolean; onSave: (token: string, persist: boolean) => void; onTestConnection: () => Promise<ConnectionTestResult>; onResume: () => void; onClear: () => void }) {
  const [value, setValue] = useState("");
  const [persist, setPersist] = useState(true);
  const [testState, setTestState] = useState<{ phase: "idle" | "testing" | "success" | "error"; result?: ConnectionTestResult; error?: Error }>({ phase: "idle" });
  const canSave = value.trim().length > 0;
  const runConnectionTest = async () => {
    setTestState({ phase: "testing" });
    try {
      setTestState({ phase: "success", result: await onTestConnection() });
    } catch (error) {
      setTestState({ phase: "error", error: toError(error, "接続テストに失敗しました。") });
    }
  };
  return (
    <main className="app-shell narrow-shell">
      <p className="eyebrow">NOTE ARTICLE MANAGER</p>
      <h1>記事を、公開できる状態にする。</h1>
      <section className="settings-card">
        <h2>GitHub PAT を設定</h2>
        <p>private な <code>iiiitiiitiiti/note-articles</code> を読むための fine-grained PAT を、この端末のブラウザから接続します。</p>
        <label htmlFor="pat">Personal access token</label>
        <input id="pat" type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" placeholder={hasToken ? "再入力する場合だけ入力" : "github_pat_…"} />
        {hasToken && <>
          <button className="secondary-button" type="button" disabled={testState.phase === "testing"} onClick={() => void runConnectionTest()}>{testState.phase === "testing" ? "接続を確認中…" : "保存済みトークンをテスト"}</button>
          {testState.phase === "success" && testState.result && <p className="connection-result" role="status">読み取り: 利用可能 ／ 書き込み: {writeAccessLabel(testState.result.writeAccess)}（{testState.result.repository}）</p>}
          {testState.phase === "error" && testState.error && <ErrorNotice error={testState.error} onRetry={() => void runConnectionTest()} />}
        </>}
        <button className="primary-button" type="button" disabled={!canSave} onClick={() => onSave(value, persist)}>{persist ? "この端末に保存して接続" : "このセッションだけで接続"}</button>
        <label className="checkbox-label"><input type="checkbox" checked={persist} onChange={(event) => setPersist(event.target.checked)} /> 次回起動時もこのトークンを使う</label>
        {hasToken && <button className="secondary-button settings-resume-button" type="button" onClick={onResume}>保存済みトークンで一覧に戻る</button>}
        <ul className="fine-print">
          <li>Contents の read/write だけを許可した有効期限つき PAT を使ってください。</li>
          <li>トークンは URL・ログ・GitHub Pages の公開ファイルには出しません。</li>
          <li>保存する場合はブラウザの localStorage に保存されます。共有端末では保存しないでください。</li>
          <li>期限切れや権限不足は、保存済みトークンのテストで先に確認できます。</li>
        </ul>
        {hasToken && <button className="danger-button" type="button" onClick={onClear}>保存済みトークンを削除</button>}
      </section>
    </main>
  );
}

function writeAccessLabel(access: ConnectionTestResult["writeAccess"]): string {
  if (access === "available") return "利用可能";
  if (access === "unavailable") return "不足（保存時に失敗します）";
  return "未確認（保存時に判定）";
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

function ImageInventoryPanel({ client }: { client: GithubClient }) {
  const [inventory, setInventory] = useState<ImageInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<Error | null>(null);

  const loadInventory = async () => {
    setLoading(true);
    setError(null);
    try {
      setInventory(await client.getImageInventory());
      setSelected([]);
    } catch (loadError) {
      setError(toError(loadError, "画像アセットを棚卸しできませんでした。"));
    } finally {
      setLoading(false);
    }
  };

  const deleteSelected = async () => {
    const targets = inventory?.issues.filter((issue) => issue.kind === "unreferenced" && issue.sha && selected.includes(issue.path)) ?? [];
    if (targets.length === 0 || !window.confirm(`未参照画像を${targets.length}件削除します。記事本文から参照されていないことを確認しましたか？`)) return;
    setDeleting(true);
    setError(null);
    try {
      for (const target of targets) await client.deleteImage(target.path, target.sha as string);
      await loadInventory();
    } catch (deleteError) {
      setError(toError(deleteError, "画像アセットの削除に失敗しました。"));
    } finally {
      setDeleting(false);
    }
  };

  const deletable = inventory?.issues.filter((issue) => issue.kind === "unreferenced" && issue.sha) ?? [];
  return (
    <Accordion className="image-inventory-card" label="画像アセット管理">
      <p className="image-plan-intro">Git Tree・記事本文・image-status.jsonを照合し、未参照画像や壊れた参照を確認します。自動削除は行いません。</p>
      <button className="secondary-button" type="button" disabled={loading || deleting} onClick={() => void loadInventory()}>{loading ? "棚卸し中…" : "画像アセットを確認"}</button>
      {error && <ErrorNotice error={error} onRetry={() => void loadInventory()} />}
      {inventory && <>
        <p className="inline-message">記事 {inventory.scannedArticles}件・画像ファイル {inventory.scannedAssets}件を確認しました。問題候補 {inventory.issues.length}件。</p>
        {inventory.issues.length === 0 && <p className="orphan-image-empty">未参照・壊れた参照・状態だけ残った画像はありません。</p>}
        {inventory.issues.length > 0 && <ul className="inventory-list">
          {inventory.issues.map((issue) => <li key={`${issue.kind}-${issue.path}`} className="inventory-item">
            {issue.kind === "unreferenced" && issue.sha && <input type="checkbox" checked={selected.includes(issue.path)} onChange={() => setSelected((current) => current.includes(issue.path) ? current.filter((path) => path !== issue.path) : [...current, issue.path])} aria-label={`${issue.path}を削除対象に選択`} />}
            <div><strong>{imageInventoryIssueLabel(issue.kind)}</strong> <code>{issue.path}</code>
              {issue.articlePaths.length > 0 && <small>本文の参照: {issue.articlePaths.join("、")}</small>}
              {issue.statusArticlePaths.length > 0 && <small>画像状態の登録: {issue.statusArticlePaths.join("、")}</small>}
              {issue.kind === "unreferenced" && <small>削除は選択後に明示確認が必要です。Gitの履歴から復元できます。</small>}
            </div>
          </li>)}
        </ul>}
        {deletable.length > 0 && <button className="danger-button inventory-delete-button" type="button" disabled={deleting || selected.length === 0} onClick={() => void deleteSelected()}>{deleting ? "削除中…" : `選択した未参照画像を削除（${selected.length}件）`}</button>}
      </>}
    </Accordion>
  );
}

function imageInventoryIssueLabel(kind: ImageInventory["issues"][number]["kind"]): string {
  if (kind === "unreferenced") return "未参照";
  if (kind === "broken-reference") return "壊れた参照";
  return "状態のみ";
}

function DashboardPanel({ snapshot, schedule, onScheduleChange }: { snapshot: RepositorySnapshot; schedule: PublicationScheduleConfig; onScheduleChange: (next: PublicationScheduleConfig) => void }) {
  const summaries = snapshot.articles.reduce((result, article) => {
    result[article.status] += 1;
    return result;
  }, { queued: 0, review: 0, published: 0, draft: 0, unset: 0 } as Record<ArticleStatus, number>);
  const pendingImages = snapshot.articles.filter((article) => summarizeImageTasks(snapshot.imageStatus, article.path).pending > 0).length;
  const scheduled = buildPublicationSchedule(snapshot.articles, schedule);
  const categories = [...new Set(snapshot.articles.map((article) => article.category))];
  return (
    <section className="dashboard-panel" aria-labelledby="dashboard-heading">
      <div className="dashboard-heading-line">
        <div><p className="eyebrow">PUBLICATION DASHBOARD</p><h2 id="dashboard-heading">公開の進み具合</h2></div>
        <span className="dashboard-total">全 {snapshot.articles.length} 件</span>
      </div>
      <div className="dashboard-metrics">
        <DashboardMetric label="公開待ち" value={summaries.queued} tone="queued" />
        <DashboardMetric label="レビュー待ち" value={summaries.review} tone="review" />
        <DashboardMetric label="公開済み" value={summaries.published} tone="published" />
        <DashboardMetric label="画像未決定" value={pendingImages} tone="image" />
      </div>
      <Accordion className="schedule-card" label="公開スケジュールを設定">
        <p className="image-plan-intro">公開待ちの記事を、ファイル名の接頭辞順で予定日に並べます。設定はこの端末に保存されます。</p>
        <div className="schedule-fields">
          <label htmlFor="schedule-start">開始日時</label>
          <input id="schedule-start" type="datetime-local" value={schedule.startAt} onChange={(event) => onScheduleChange({ ...schedule, startAt: event.target.value })} />
          <label htmlFor="schedule-interval">公開間隔</label>
          <select id="schedule-interval" value={schedule.intervalDays} onChange={(event) => onScheduleChange({ ...schedule, intervalDays: Number(event.target.value) })}>
            <option value="1">毎日</option>
            <option value="7">毎週</option>
            <option value="14">2週間ごと</option>
          </select>
          <label htmlFor="schedule-category">対象カテゴリ</label>
          <select id="schedule-category" value={schedule.category} onChange={(event) => onScheduleChange({ ...schedule, category: event.target.value })}>
            <option value="all">全カテゴリ</option>
            {categories.map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category] ?? category}</option>)}
          </select>
        </div>
        {scheduled.length === 0 && <p className="inline-message">開始日時を設定すると、公開待ち記事の予定が表示されます。</p>}
        {scheduled.length > 0 && <ol className="schedule-list">{scheduled.slice(0, 8).map((item) => <li key={item.path}><time dateTime={item.scheduledAt}>{formatScheduleTime(item.scheduledAt)}</time><span>{articleDisplayName({ path: item.path, category: item.category, status: "queued", queueOrder: item.queueOrder, publishedUrl: null, publishedAt: null })}</span></li>)}</ol>}
        {scheduled.length > 8 && <p className="inline-message">ほか {scheduled.length - 8} 件</p>}
        <p className="notification-note">iPhoneのバックグラウンド通知は、別途Web Push送信サーバーの設定が必要です。現在はこの画面で公開予定を確認できます。</p>
      </Accordion>
    </section>
  );
}

function DashboardMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className={`dashboard-metric dashboard-metric-${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function HealthCheckPanel({ client }: { client: GithubClient }) {
  const [report, setReport] = useState<ArticleHealthReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const checkHealth = async () => {
    setChecking(true);
    setError(null);
    try {
      setReport(await client.getArticleHealthReport());
    } catch (checkError) {
      setError(toError(checkError, "記事の健全性を確認できませんでした。"));
    } finally {
      setChecking(false);
    }
  };
  return (
    <Accordion className="health-card" label="記事の健全性チェック">
      <p className="image-plan-intro">全記事をGitHubから読み込み、note非対応要素、壊れた画像参照、未決定の画像、途中登録を確認します。</p>
      <button className="secondary-button" type="button" disabled={checking} onClick={() => void checkHealth()}>{checking ? "確認中…" : "全記事を確認"}</button>
      {error && <ErrorNotice error={error} onRetry={() => void checkHealth()} />}
      {report && <>
        <p className="inline-message">記事 {report.scannedArticles}件を確認しました（{formatScheduleTime(report.checkedAt)}）。問題 {report.issues.length}件。</p>
        {report.issues.length === 0 && <p className="orphan-image-empty">問題は見つかりませんでした。</p>}
        {report.issues.length > 0 && <ul className="health-list">{report.issues.map((issue) => <li key={`${issue.kind}-${issue.path}`}><strong>{healthIssueLabel(issue.kind)}</strong><code>{issue.path}</code><span>{issue.message}</span><small>{issue.details.join("、")}</small></li>)}</ul>}
      </>}
    </Accordion>
  );
}

function healthIssueLabel(kind: ArticleHealthReport["issues"][number]["kind"]): string {
  if (kind === "note-unsupported") return "note非対応";
  if (kind === "missing-image") return "画像参照切れ";
  if (kind === "image-pending") return "画像未決定";
  if (kind === "image-registration") return "画像登録途中";
  return "画像プレースホルダー";
}

function formatScheduleTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function ArticleListItem({ article, imageProgress, onOpen }: { article: ArticlePath; imageProgress: ImageProgressSummary; onOpen: (path: string) => void }) {
  return (
    <button className="article-row" type="button" onClick={() => void onOpen(article.path)}>
      <span className="article-row-main">
        <span className="article-row-title">{articleDisplayName(article)}</span>
        <span className="article-row-path">{article.path}</span>
      </span>
      <span className="article-row-side">
        <StatusBadge status={article.status} />
        <ImageProgressBadge summary={imageProgress} />
      </span>
    </button>
  );
}

function articleDisplayName(article: ArticlePath): string {
  const filename = article.path.split("/").at(-1)?.replace(/\.md$/, "") ?? article.path;
  return `${article.queueOrder ? `${String(article.queueOrder).padStart(2, "0")} ` : ""}${filename.replace(/^\d+[_-]?/, "").replace(/[_-]+/g, " ")}`;
}

function ImageProgressBadge({ summary }: { summary: ImageProgressSummary }) {
  if (summary.total === 0) {
    return <span className="image-progress image-progress-none" role="group" aria-label="画像準備: 画像タスクなし">画像準備なし</span>;
  }
  const label = `画像準備: 全${summary.total}件、未決定${summary.pending}件、AI生成${summary.generate}件、自分で用意${summary.provide}件、不要${summary.skip}件`;
  return (
    <span className={summary.pending > 0 ? "image-progress image-progress-pending" : "image-progress"} role="group" aria-label={label}>
      <span>画像 {summary.pending > 0 ? `未決定 ${summary.pending}/${summary.total}` : `${summary.total}件確認済み`}</span>
      <span className="image-progress-details" aria-hidden="true">AI {summary.generate}・用意 {summary.provide}・不要 {summary.skip}</span>
    </span>
  );
}

function SyncStatus({ state, hasPendingSnapshot = false, onApplyPendingSnapshot, onRetry }: { state: SyncState; hasPendingSnapshot?: boolean; onApplyPendingSnapshot?: () => void; onRetry?: () => void }) {
  const time = state.checkedAt ? formatSyncTime(state.checkedAt) : "未確認";
  const errorMessage = state.error instanceof GithubApiError ? state.error.reason : state.error?.message;
  let message = "";
  if (state.phase === "checking") message = "確認中…";
  else if (state.phase === "error") message = `同期に失敗しました。${errorMessage ?? "再試行してください。"}`;
  else if (hasPendingSnapshot) message = "更新があります。現在の画面は保持しています。";
  else if (state.phase === "updated") message = "更新を反映しました。";
  else if (state.phase === "unchanged") message = "変更なし";

  return (
    <div className={`sync-status sync-${state.phase}${hasPendingSnapshot ? " sync-pending" : ""}`} role={state.phase === "error" ? "alert" : "status"}>
      <span className="sync-status-label">自動更新</span>
      <span>最終確認: {time}</span>
      {message && <span>{message}</span>}
      {hasPendingSnapshot && onApplyPendingSnapshot && <button className="secondary-button" type="button" onClick={onApplyPendingSnapshot}>更新を反映</button>}
      {state.phase === "error" && onRetry && <button className="secondary-button" type="button" onClick={onRetry}>再試行</button>}
    </div>
  );
}

function formatSyncTime(timestamp: number): string {
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp);
}

function ArticleScreen({ article, articleLoading, selectedPath, currentStatus, client, imageStatus, onBack, onPrepareNoteNavigation, onSaved, onImageStatusSaved, onArticleUpdated, error, onRetry, onSyncRetry, onOpenSettings, syncState, hasPendingSnapshot, onApplyPendingSnapshot }: {
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
  error: Error | null;
  onRetry: () => void;
  onSyncRetry: () => void;
  onOpenSettings: () => void;
  syncState: SyncState;
  hasPendingSnapshot: boolean;
  onApplyPendingSnapshot: () => void;
}) {
  const [manualCopy, setManualCopy] = useState<{ label: string; text: string; openNoteAfterCopy: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const [operationError, setOperationError] = useState<ArticleOperationError | null>(null);
  const [publishedUrl, setPublishedUrl] = useState(currentStatus?.publishedUrl ?? "");
  const [transferMode, setTransferMode] = useState<NoteTransferMode>("note");
  const [saving, setSaving] = useState(false);
  const [imageBusy, setImageBusy] = useState("");
  const [orphanImages, setOrphanImages] = useState<Record<string, string[]>>({});
  const [orphanCheckBusy, setOrphanCheckBusy] = useState("");

  useEffect(() => {
    setOrphanImages({});
    setTransferMode("note");
  }, [selectedPath]);

  const reloadArticle = () => {
    setOperationError(null);
    setOrphanImages({});
    onArticleUpdated();
  };

  const openNote = () => {
    onPrepareNoteNavigation();
    window.location.assign(NOTE_COMPOSE_URL);
  };

  const copy = (label: string, text: string, openNoteAfterCopy = false) => {
    setMessage("");
    setOperationError(null);
    setManualCopy(null);
    if (!navigator.clipboard?.writeText) {
      setManualCopy({ label, text, openNoteAfterCopy });
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => {
        setMessage(`${label}をコピーしました。`);
        if (openNoteAfterCopy) {
          openNote();
        }
      },
      () => setManualCopy({ label, text, openNoteAfterCopy }),
    );
  };

  const savePublished = async () => {
    if (!article || !isHttpUrl(publishedUrl)) return;
    setSaving(true);
    setMessage("");
    setOperationError(null);
    try {
      const updated = await client.updateArticleStatus(selectedPath, {
        status: "published",
        publishedUrl: publishedUrl.trim(),
        publishedAt: new Date().toISOString(),
      });
      onSaved(updated);
      setMessage("公開済みとして保存しました。");
    } catch (saveError) {
      setOperationError({ error: toError(saveError, "保存に失敗しました。"), retry: () => void savePublished() });
    } finally {
      setSaving(false);
    }
  };

  const saveImageDecision = async (taskId: string, decision: ImageDecision) => {
    setImageBusy(taskId);
    setMessage("");
    setOperationError(null);
    try {
      const updated = await client.updateImageTaskState(selectedPath, taskId, { decision, updatedAt: new Date().toISOString() });
      onImageStatusSaved(updated);
      setMessage(`画像の判断を「${IMAGE_DECISION_LABELS[decision]}」として保存しました。`);
    } catch (saveError) {
      setOperationError({ error: toError(saveError, "画像の判断の保存に失敗しました。"), retry: () => void saveImageDecision(taskId, decision) });
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
    setOperationError(null);
    try {
      const assetPath = buildImageAssetPath(selectedPath, taskId, file.name);
      await client.uploadImage(assetPath, new Uint8Array(await file.arrayBuffer()));
      const currentState = getImageTaskState(imageStatus, selectedPath, taskId);
      const assetUploaded = await client.updateImageTaskState(selectedPath, taskId, {
        decision: currentState.decision === "pending" ? "provide" : currentState.decision,
        assetPath,
        registrationStage: "asset-uploaded",
        updatedAt: new Date().toISOString(),
      });
      onImageStatusSaved(assetUploaded);
      await client.updateArticleWithImage(selectedPath, taskId, imageMarkdownFor(placeholder.description, assetPath));
      const articleUpdated = await client.updateImageTaskState(selectedPath, taskId, {
        assetPath,
        registrationStage: "article-updated",
        updatedAt: new Date().toISOString(),
      });
      onImageStatusSaved(articleUpdated);
      const completed = await client.updateImageTaskState(selectedPath, taskId, {
        assetPath,
        registrationStage: "completed",
        updatedAt: new Date().toISOString(),
      });
      onImageStatusSaved(completed);
      reloadArticle();
      setMessage("画像を登録し、記事本文へ差し込みました。");
    } catch (uploadError) {
      setOperationError({
        error: toError(uploadError, "画像の登録に失敗しました。"),
        retry: () => void uploadImage(taskId, file),
        reloadArticle,
        checkOrphans: () => void checkOrphanImages(taskId),
      });
    } finally {
      setImageBusy("");
    }
  };

  const resumeImageRegistration = async (taskId: string) => {
    const placeholder = article?.imagePlaceholders.find((item) => item.id === taskId);
    const currentState = getImageTaskState(imageStatus, selectedPath, taskId);
    if (!placeholder || !currentState.assetPath || !["asset-uploaded", "article-updated"].includes(currentState.registrationStage)) return;
    setImageBusy(taskId);
    setMessage("");
    setOperationError(null);
    try {
      let stage = currentState.registrationStage;
      if (stage === "asset-uploaded") {
        await client.updateArticleWithImage(selectedPath, taskId, imageMarkdownFor(placeholder.description, currentState.assetPath));
        const articleUpdated = await client.updateImageTaskState(selectedPath, taskId, {
          assetPath: currentState.assetPath,
          registrationStage: "article-updated",
          updatedAt: new Date().toISOString(),
        });
        onImageStatusSaved(articleUpdated);
        stage = "article-updated";
      }
      if (stage === "article-updated") {
        const completed = await client.updateImageTaskState(selectedPath, taskId, {
          assetPath: currentState.assetPath,
          registrationStage: "completed",
          updatedAt: new Date().toISOString(),
        });
        onImageStatusSaved(completed);
        setMessage("途中状態から画像登録を再開し、完了しました。");
        reloadArticle();
      }
    } catch (resumeError) {
      setOperationError({
        error: toError(resumeError, "画像登録の再開に失敗しました。"),
        retry: () => void resumeImageRegistration(taskId),
        reloadArticle,
        checkOrphans: () => void checkOrphanImages(taskId),
      });
    } finally {
      setImageBusy("");
    }
  };

  const checkOrphanImages = async (taskId: string) => {
    setOrphanCheckBusy(taskId);
    setOperationError(null);
    try {
      const markdown = await client.getArticle(selectedPath);
      const assets = await client.getArticleImageAssets(selectedPath);
      const linkedImages = new Set(renderArticle(markdown, selectedPath).localImagePaths);
      const orphaned = assets.filter((assetPath) => !linkedImages.has(assetPath));
      setOrphanImages((current) => ({ ...current, [taskId]: orphaned }));
      setMessage(orphaned.length > 0 ? `孤児画像の候補が${orphaned.length}件あります。` : "孤児画像の候補はありません。");
    } catch (orphanError) {
      setOperationError({ error: toError(orphanError, "孤児画像を確認できませんでした。"), retry: () => void checkOrphanImages(taskId) });
    } finally {
      setOrphanCheckBusy("");
    }
  };

  return (
    <main className="app-shell">
      <header className="article-header">
        <button className="back-button" type="button" onClick={onBack}>← 一覧に戻る</button>
        <span className="article-row-path">{selectedPath}</span>
      </header>
      <SyncStatus state={syncState} hasPendingSnapshot={hasPendingSnapshot} onApplyPendingSnapshot={onApplyPendingSnapshot} onRetry={onSyncRetry} />
      {error && <ErrorNotice error={error} onRetry={onRetry} onOpenSettings={onOpenSettings} />}
      {operationError && <ErrorNotice error={operationError.error} onRetry={operationError.retry} onOpenSettings={onOpenSettings} onReloadArticle={operationError.reloadArticle} onCheckOrphans={operationError.checkOrphans} />}
      {articleLoading && <p className="loading">本文を読み込んでいます…</p>}
      {article && (
        <>
          <section className="article-intro">
            <div className="article-intro-line"><StatusBadge status={currentStatus?.status ?? "unset"} />{article.warnings.length > 0 && <span className="warning-badge">note 非対応要素あり</span>}</div>
            <h1>{article.title}</h1>
            <div className="transfer-mode" role="group" aria-label="コピーする本文形式">
              <span>本文の形式</span>
              <button className={transferMode === "note" ? "mode-button active" : "mode-button"} type="button" aria-pressed={transferMode === "note"} onClick={() => setTransferMode("note")}>note貼り付け用</button>
              <button className={transferMode === "markdown" ? "mode-button active" : "mode-button"} type="button" aria-pressed={transferMode === "markdown"} onClick={() => setTransferMode("markdown")}>原文Markdown</button>
            </div>
            <div className="transfer-actions">
              <button className="primary-button" type="button" onClick={() => copy("タイトル", article.title, true)}>タイトルをコピー</button>
              <button className="secondary-button" type="button" disabled={transferMode === "note" && article.warningDetails.length > 0} onClick={() => copy(transferMode === "note" ? "note用本文" : "原文Markdown", transferMode === "note" ? article.body : article.sourceMarkdown, true)}>{transferMode === "note" ? "note用本文をコピー" : "原文Markdownをコピー"}</button>
            </div>
            {transferMode === "note" && article.warningDetails.length > 0 && <p className="inline-message transfer-blocked" role="status">note用本文は要手動対応の要素があるためコピーできません。原文Markdownをコピーするか、下の対象を確認してください。</p>}
            {message && <p className="inline-message" role="status">{message}</p>}
            {manualCopy && <ManualCopy label={manualCopy.label} text={manualCopy.text} onClose={() => setManualCopy(null)} onOpenNote={manualCopy.openNoteAfterCopy ? openNote : undefined} />}
            {article.warningDetails.length > 0 && <ul className="warning-list">{article.warningDetails.map((warning) => <li key={`${warning.kind}-${warning.line}-${warning.target}`}><strong>{warning.message}</strong> <span>{warning.target}</span><br /><span>{warning.action}</span></li>)}</ul>}
          </section>

          {article.imagePlaceholders.length > 0 && <Accordion className="image-plan-card" label="画像の準備">
                <p className="image-plan-intro">画像ごとに、AIで生成するか、自分で用意するか、不要かを管理できます。</p>
                {article.imagePlaceholders.map((placeholder, index) => {
                  const state = getImageTaskState(imageStatus, selectedPath, placeholder.id);
                  const busy = imageBusy === placeholder.id;
                  return (
                    <div className="image-task" key={placeholder.id}>
                      <div className="image-task-heading">
                        <strong>画像 {index + 1}{placeholder.optional ? "（任意）" : ""}</strong>
                        <div className="image-task-badges">
                          <span className={`image-registration-stage image-stage-${state.registrationStage}`}>{IMAGE_STAGE_LABELS[state.registrationStage]}</span>
                          <span className={`image-decision image-decision-${state.decision}`}>{IMAGE_DECISION_LABELS[state.decision]}</span>
                        </div>
                      </div>
                      <p>{placeholder.description}</p>
                      <div className="image-decision-actions" role="group" aria-label={`画像${index + 1}の判断`}>
                        {IMAGE_DECISIONS.map((item) => <button className={item.value === state.decision ? "image-decision-button active" : "image-decision-button"} type="button" key={item.value} disabled={busy} onClick={() => void saveImageDecision(placeholder.id, item.value)}>{item.label}</button>)}
                      </div>
                      {state.decision === "generate" && <button className="secondary-button image-prompt-button" type="button" disabled={busy} onClick={() => copy("画像生成用プロンプト", buildImagePrompt(article.title, placeholder.description))}>生成用プロンプトをコピー</button>}
                      {state.assetPath && <p className="image-asset-path">登録済み: {state.assetPath}</p>}
                      {["asset-uploaded", "article-updated"].includes(state.registrationStage) && state.assetPath && (
                        <div className="image-recovery">
                          <p><strong>途中状態：</strong>{IMAGE_STAGE_LABELS[state.registrationStage]}。まだ完了していません。</p>
                          <div className="image-recovery-actions">
                            <button className="secondary-button" type="button" disabled={busy} onClick={() => void resumeImageRegistration(placeholder.id)}>続きを再試行</button>
                            <button className="secondary-button" type="button" disabled={busy} onClick={reloadArticle}>記事を再読み込み</button>
                            <button className="secondary-button" type="button" disabled={orphanCheckBusy === placeholder.id} onClick={() => void checkOrphanImages(placeholder.id)}>{orphanCheckBusy === placeholder.id ? "確認中…" : "孤児画像を確認"}</button>
                          </div>
                          {orphanImages[placeholder.id] && (orphanImages[placeholder.id].length > 0 ? <ul className="orphan-image-list">{orphanImages[placeholder.id].map((orphanPath) => <li key={orphanPath}><code>{orphanPath}</code></li>)}</ul> : <p className="orphan-image-empty">孤児画像の候補はありません。</p>)}
                        </div>
                      )}
                      <label className="secondary-button image-upload-button" htmlFor={`${placeholder.id}-upload`}>{busy ? "登録中…" : "画像を登録"}</label>
                      <input className="visually-hidden" id={`${placeholder.id}-upload`} type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void uploadImage(placeholder.id, file); }} />
                    </div>
                  );
                })}
          </Accordion>}

          <Accordion className="publish-card" label="公開状況">
            <label htmlFor="published-url">公開済み note URL</label>
            <input id="published-url" type="url" value={publishedUrl} onChange={(event) => setPublishedUrl(event.target.value)} placeholder="https://note.com/..." />
            <button className="primary-button" type="button" disabled={saving || !isHttpUrl(publishedUrl)} onClick={() => void savePublished()}>{saving ? "保存中…" : "公開済みにする"}</button>
          </Accordion>

          <article className="markdown-preview" dangerouslySetInnerHTML={{ __html: article.renderedHtml }} />
        </>
      )}
    </main>
  );
}

function Accordion({ className, label, children }: { className: string; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  return (
    <section className={`${className}${open ? " accordion-open" : ""}`}>
      <h2 className="accordion-heading">
        <button className="accordion-trigger" type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((current) => !current)}>
          {label}
        </button>
      </h2>
      <div id={contentId} className="accordion-content" aria-hidden={!open} inert={!open}>
        <div className="accordion-content-inner">{children}</div>
      </div>
    </section>
  );
}

function buildImagePrompt(articleTitle: string, description: string): string {
  return `note記事「${articleTitle}」の本文画像を作成してください。\n\n画像の内容：${description}\n\n記事の雰囲気に合う、説明的で落ち着いた構図。文字を画像内に入れる場合は日本語を正確に表示し、権利上問題のある既存画像の転載や、実在人物・施設の誤認を招く表現は避けてください。`;
}

function ManualCopy({ label, text, onClose, onOpenNote }: { label: string; text: string; onClose: () => void; onOpenNote?: () => void }) {
  return (
    <div className="manual-copy">
      <div className="manual-copy-heading">
        <strong>{label}を手動コピー</strong>
        <div className="manual-copy-actions">
          {onOpenNote && <button className="secondary-button" type="button" onClick={onOpenNote}>note執筆画面を開く</button>}
          <button type="button" onClick={onClose}>閉じる</button>
        </div>
      </div>
      <textarea value={text} readOnly onFocus={(event) => event.currentTarget.select()} aria-label={`${label}の手動コピー用テキスト`} />
      <p>テキストエリアをタップして全選択し、コピーしてください。</p>
    </div>
  );
}

function StatusBadge({ status }: { status: ArticlePath["status"] }) {
  const labels = { queued: "公開待ち", review: "レビュー待ち", published: "公開済み", draft: "執筆中", unset: "未設定" };
  return <span className={`status-badge status-${status}`}>{labels[status]}</span>;
}

function ErrorNotice({ error, onRetry, onOpenSettings, onReloadArticle, onCheckOrphans }: { error: Error; onRetry?: () => void; onOpenSettings?: () => void; onReloadArticle?: () => void; onCheckOrphans?: () => void }) {
  const githubError = error instanceof GithubApiError ? error : null;
  const showRetry = Boolean(onRetry && (!githubError || githubError.action === "retry"));
  const showSettings = Boolean(onOpenSettings && githubError?.action === "settings");
  const showRecoveryActions = Boolean(onReloadArticle || onCheckOrphans);
  return (
    <div className="error-notice" role="alert">
      {githubError ? (
        <>
          <strong>対象: {githubError.operation}</strong>
          <p className="error-reason">{githubError.reason}</p>
          <p className="error-next-step"><strong>次の操作:</strong> {githubError.nextStep}</p>
        </>
      ) : <p className="error-reason">{error.message}</p>}
      {(showRetry || showSettings || showRecoveryActions) && (
        <div className="error-actions">
          {showRetry && <button className="secondary-button" type="button" onClick={onRetry}>再試行</button>}
          {onReloadArticle && <button className="secondary-button" type="button" onClick={onReloadArticle}>記事を再読み込み</button>}
          {onCheckOrphans && <button className="secondary-button" type="button" onClick={onCheckOrphans}>孤児画像を確認</button>}
          {showSettings && <button className="secondary-button" type="button" onClick={onOpenSettings}>設定を開く</button>}
        </div>
      )}
    </div>
  );
}

function imageMarkdownFor(description: string, assetPath: string): string {
  const assetName = assetPath.split("/images/").at(-1) ?? assetPath;
  return `![${description}](images/${assetName})`;
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
