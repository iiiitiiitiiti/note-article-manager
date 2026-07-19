import { mergeArticlePaths, validateStatusDocument, withArticleStatus } from "./status";
import { emptyImageStatusDocument, extractLocalImagePaths, filterArticleImageAssets, IMAGE_STATUS_PATH, MAX_IMAGE_BYTES, replaceImagePlaceholder, validateImageStatusDocument, withImageTaskState } from "./image-plan";
import { createGithubApiError, createGithubNetworkError } from "./github-errors";
import type { ArticleStatusEntry, ImageInventory, ImageInventoryIssue, ImageStatusDocument, ImageTaskState, RepositorySnapshot, StatusDocument } from "./types";

const API_ROOT = "https://api.github.com";
const OWNER = "iiiitiiitiiti";
const REPOSITORY = "note-articles";
const BRANCH = "main";
const STATUS_PATH = "status.json";
const MAX_WRITE_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

interface CachedResponse<T> {
  etag: string | null;
  value: T;
  changed: boolean;
}

export interface SnapshotLoadResult {
  snapshot: RepositorySnapshot;
  changed: boolean;
}

interface ContentsResponse {
  content?: string;
  encoding?: string;
  sha: string;
}

interface TreeResponse {
  tree?: DirectoryEntry[];
  truncated?: boolean;
}

interface DirectoryEntry {
  path?: string;
  type?: string;
  sha?: string;
}

interface RepositoryMetadata {
  full_name?: string;
  permissions?: {
    push?: boolean;
  };
}

export type WriteAccess = "available" | "unavailable" | "unconfirmed";

export interface ConnectionTestResult {
  repository: string;
  readAccess: "available";
  writeAccess: WriteAccess;
}

export class GithubClient {
  private readonly token: string;
  private treeCache?: CachedResponse<DirectoryEntry[]>;
  private statusCache?: CachedResponse<{ document: StatusDocument; sha: string }>;
  private imageStatusCache?: CachedResponse<{ document: ImageStatusDocument; sha: string | null }>;
  private writeQueue: Promise<unknown> = Promise.resolve();

  public constructor(token: string) {
    this.token = token;
  }

  public async loadSnapshot(): Promise<RepositorySnapshot> {
    return (await this.checkForUpdates()).snapshot;
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    await this.getStatusFile(true, "GitHub接続テスト（読み取り）");
    const response = await this.request<RepositoryMetadata>(
      `/repos/${OWNER}/${REPOSITORY}`,
      {},
      undefined,
      [],
      "GitHub接続テスト（権限）",
    );
    const push = response.data.permissions?.push;
    return {
      repository: response.data.full_name ?? `${OWNER}/${REPOSITORY}`,
      readAccess: "available",
      writeAccess: push === true ? "available" : push === false ? "unavailable" : "unconfirmed",
    };
  }

  public async checkForUpdates(): Promise<SnapshotLoadResult> {
    const [paths, status, imageStatus] = await Promise.all([this.getArticlePaths(), this.getStatusFile(), this.getImageStatusFile()]);
    const merged = mergeArticlePaths(paths.value, status.value.document);
    return {
      snapshot: {
        articles: merged.articles,
        status: status.value.document,
        imageStatus: imageStatus.value.document,
        missingStatusPaths: merged.missingStatusPaths,
        orphanStatusPaths: merged.orphanStatusPaths,
      },
      changed: paths.changed || status.changed || imageStatus.changed,
    };
  }

  public async getArticle(path: string): Promise<string> {
    const file = await this.getArticleFile(path);
    return file.content;
  }

  public async getArticleFile(path: string, operation = "記事本文"): Promise<{ content: string; sha: string }> {
    const response = await this.request<ContentsResponse>(
      `/repos/${OWNER}/${REPOSITORY}/contents/${encodePath(path)}?ref=${BRANCH}`,
      {},
      undefined,
      [],
      operation,
    );
    if (response.status !== 200 || !response.data.content || response.data.encoding !== "base64") {
      throw new Error(`${operation}を取得できませんでした: ${path}`);
    }
    return { content: decodeBase64Utf8(response.data.content), sha: response.data.sha };
  }

  public async getImageDataUrl(path: string): Promise<string> {
    const file = await this.getArticleFile(path, `画像「${path}」`);
    const normalized = file.content.replace(/\s/g, "");
    if (normalized.length * 0.75 > MAX_IMAGE_BYTES) throw new Error(`画像が大きすぎるためプレビューできません: ${path}`);
    return `data:${mimeTypeForPath(path)};base64,${normalized}`;
  }

  public async getArticleImageAssets(articlePath: string): Promise<string[]> {
    const category = articlePath.split("/", 1)[0];
    const response = await this.request<DirectoryEntry[]>(
      `/repos/${OWNER}/${REPOSITORY}/contents/${encodePath(`${category}/images`)}?ref=${BRANCH}`,
      {},
      undefined,
      [404],
      "孤児画像の確認",
    );
    if (response.status === 404) return [];
    if (response.status !== 200 || !Array.isArray(response.data)) throw new Error("画像一覧を取得できませんでした。");
    return filterArticleImageAssets(articlePath, response.data);
  }

  public async getImageInventory(): Promise<ImageInventory> {
    const tree = await this.getRepositoryTree();
    const articlePaths = tree.value
      .filter((entry) => entry.type === "blob" && typeof entry.path === "string" && isArticlePath(entry.path))
      .map((entry) => entry.path as string)
      .sort((left, right) => left.localeCompare(right, "ja"));
    const assets = tree.value
      .filter((entry) => entry.type === "blob" && typeof entry.path === "string" && isImageAssetPath(entry.path))
      .map((entry) => ({ path: entry.path as string, sha: entry.sha ?? null }));
    const imageStatus = await this.getImageStatusFile();
    const articleContents = await Promise.all(articlePaths.map(async (path) => ({
      path,
      content: (await this.getArticleFile(path, "画像アセット棚卸し")).content,
    })));
    const references = new Map<string, string[]>();
    for (const article of articleContents) {
      for (const imagePath of extractLocalImagePaths(article.content, article.path)) {
        references.set(imagePath, [...(references.get(imagePath) ?? []), article.path]);
      }
    }
    const statusReferences = new Map<string, string[]>();
    for (const [articlePath, article] of Object.entries(imageStatus.value.document.articles)) {
      for (const task of Object.values(article.tasks)) {
        if (!task.assetPath) continue;
        statusReferences.set(task.assetPath, [...(statusReferences.get(task.assetPath) ?? []), articlePath]);
      }
    }

    const issues: ImageInventoryIssue[] = [];
    const knownAssets = new Set(assets.map((asset) => asset.path));
    for (const asset of assets) {
      const articlePathsForAsset = references.get(asset.path) ?? [];
      if (articlePathsForAsset.length === 0) {
        issues.push({
          kind: "unreferenced",
          path: asset.path,
          articlePaths: [],
          statusArticlePaths: statusReferences.get(asset.path) ?? [],
          sha: asset.sha,
        });
      }
    }
    for (const [path, articlePathsForAsset] of references) {
      if (!knownAssets.has(path)) {
        issues.push({
          kind: "broken-reference",
          path,
          articlePaths: articlePathsForAsset,
          statusArticlePaths: statusReferences.get(path) ?? [],
          sha: null,
        });
      }
    }
    for (const [path, articlePathsForAsset] of statusReferences) {
      if (!knownAssets.has(path) && !references.has(path)) {
        issues.push({
          kind: "status-only",
          path,
          articlePaths: [],
          statusArticlePaths: articlePathsForAsset,
          sha: null,
        });
      }
    }
    issues.sort((left, right) => `${left.kind}:${left.path}`.localeCompare(`${right.kind}:${right.path}`, "ja"));
    return { issues, scannedArticles: articlePaths.length, scannedAssets: assets.length };
  }

  public async deleteImage(path: string, sha: string): Promise<void> {
    if (!isImageAssetPath(path) || !sha) throw new Error("削除対象の画像情報が不正です。");
    const response = await this.request<ContentsResponse>(
      `/repos/${OWNER}/${REPOSITORY}/contents/${encodePath(path)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ message: `image: remove orphan ${path}`, sha, branch: BRANCH }),
      },
      undefined,
      [],
      "孤児画像の削除",
    );
    if (response.status !== 200) throw new Error(`孤児画像の削除に失敗しました (${response.status})`);
    this.treeCache = undefined;
  }

  public async uploadImage(path: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("画像は1バイト以上、5MB以下にしてください。");
    }
    const endpoint = `/repos/${OWNER}/${REPOSITORY}/contents/${encodePath(path)}`;
    const content = encodeBase64Bytes(bytes);
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const existing = await this.request<ContentsResponse>(`${endpoint}?ref=${BRANCH}`, {}, undefined, [404], "画像");
      const response = await this.request<ContentsResponse>(endpoint, {
        method: "PUT",
        body: JSON.stringify({
          message: `image: add ${path}`,
          content,
          ...(existing.status === 200 ? { sha: existing.data.sha } : {}),
          branch: BRANCH,
        }),
      }, undefined, [], "画像の登録");
      if (response.status === 200 || response.status === 201) return;
      if (response.status !== 409 || attempt === MAX_WRITE_ATTEMPTS) break;
    }
    throw createGithubApiError(409, "競合", undefined, "画像の登録");
  }

  public updateArticleStatus(
    path: string,
    patch: Pick<ArticleStatusEntry, "status" | "publishedUrl" | "publishedAt">,
  ): Promise<StatusDocument> {
    const operation = this.writeQueue.then(() => this.updateArticleStatusWithRetry(path, patch));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async updateArticleStatusWithRetry(
    path: string,
    patch: Pick<ArticleStatusEntry, "status" | "publishedUrl" | "publishedAt">,
  ): Promise<StatusDocument> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const latest = await this.getStatusFile(true);
      const nextDocument = withArticleStatus(latest.value.document, path, patch);
      const response = await this.request<ContentsResponse>(
        `/repos/${OWNER}/${REPOSITORY}/contents/${STATUS_PATH}`,
        {
          method: "PUT",
          body: JSON.stringify({
            message: `status: ${path} → ${patch.status}`,
            content: encodeBase64Utf8(`${JSON.stringify(nextDocument, null, 2)}\n`),
            sha: latest.value.sha,
            branch: BRANCH,
          }),
        },
      );

      if (response.status === 200 || response.status === 201) {
        const newSha = response.data.sha;
        this.statusCache = { etag: null, value: { document: nextDocument, sha: newSha }, changed: true };
        return nextDocument;
      }
      if (response.status !== 409) {
        throw new Error(`status.json の更新に失敗しました (${response.status})`);
      }
      this.statusCache = undefined;
      if (attempt === MAX_WRITE_ATTEMPTS) break;
    }

    throw createGithubApiError(409, "競合", undefined, "公開状況の保存");
  }

  public updateImageTaskState(
    articlePath: string,
    taskId: string,
    patch: Partial<ImageTaskState>,
  ): Promise<ImageStatusDocument> {
    const operation = this.writeQueue.then(() => this.updateImageTaskStateWithRetry(articlePath, taskId, patch));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async updateImageTaskStateWithRetry(
    articlePath: string,
    taskId: string,
    patch: Partial<ImageTaskState>,
  ): Promise<ImageStatusDocument> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const latest = await this.getImageStatusFile(true);
      const nextDocument = withImageTaskState(latest.value.document, articlePath, taskId, patch);
      const response = await this.request<ContentsResponse>(
        `/repos/${OWNER}/${REPOSITORY}/contents/${IMAGE_STATUS_PATH}`,
        {
          method: "PUT",
          body: JSON.stringify({
            message: `image-plan: ${articlePath} → ${taskId}`,
            content: encodeBase64Utf8(`${JSON.stringify(nextDocument, null, 2)}\n`),
            ...(latest.value.sha ? { sha: latest.value.sha } : {}),
            branch: BRANCH,
          }),
        },
      );

      if (response.status === 200 || response.status === 201) {
        this.imageStatusCache = { etag: null, value: { document: nextDocument, sha: response.data.sha }, changed: true };
        return nextDocument;
      }
      if (response.status !== 409) throw new Error(`image-status.json の更新に失敗しました (${response.status})`);
      this.imageStatusCache = undefined;
      if (attempt === MAX_WRITE_ATTEMPTS) break;
    }
    throw createGithubApiError(409, "競合", undefined, "画像状態の保存");
  }

  public updateArticleWithImage(articlePath: string, taskId: string, imageMarkdown: string): Promise<string> {
    const operation = this.writeQueue.then(() => this.updateArticleWithImageWithRetry(articlePath, taskId, imageMarkdown));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async updateArticleWithImageWithRetry(articlePath: string, taskId: string, imageMarkdown: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const latest = await this.getArticleFile(articlePath);
      let nextMarkdown: string;
      try {
        nextMarkdown = replaceImagePlaceholder(latest.content, taskId, imageMarkdown);
      } catch (error) {
        if (latest.content.includes(imageMarkdown)) return latest.content;
        throw error;
      }
      const response = await this.request<ContentsResponse>(
        `/repos/${OWNER}/${REPOSITORY}/contents/${encodePath(articlePath)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            message: `image: insert ${taskId} into ${articlePath}`,
            content: encodeBase64Utf8(nextMarkdown),
            sha: latest.sha,
            branch: BRANCH,
          }),
        },
      );
      if (response.status === 200 || response.status === 201) return nextMarkdown;
      if (response.status !== 409) throw new Error(`記事本文の画像差し込みに失敗しました (${response.status})`);
      if (attempt === MAX_WRITE_ATTEMPTS) break;
    }
    throw createGithubApiError(409, "競合", undefined, "記事本文の保存");
  }

  private async getRepositoryTree(): Promise<CachedResponse<DirectoryEntry[]>> {
    const response = await this.request<TreeResponse>(
      `/repos/${OWNER}/${REPOSITORY}/git/trees/${BRANCH}?recursive=1`,
      {},
      this.treeCache?.etag ?? undefined,
    );
    if (response.status === 304 && this.treeCache) return { ...this.treeCache, changed: false };
    if (response.status !== 200 || !response.data.tree) {
      throw new Error("記事一覧を取得できませんでした。");
    }
    if (response.data.truncated) {
      throw new Error("GitHub の記事ツリーが大きすぎるため、安全のため表示を中止しました。");
    }
    this.treeCache = { etag: response.etag, value: response.data.tree, changed: true };
    return this.treeCache;
  }

  private async getArticlePaths(): Promise<CachedResponse<string[]>> {
    const tree = await this.getRepositoryTree();
    const paths = tree.value
      .filter((entry) => entry.type === "blob" && typeof entry.path === "string" && isArticlePath(entry.path))
      .map((entry) => entry.path as string)
      .sort((left, right) => left.localeCompare(right, "ja"));
    return { etag: tree.etag, value: paths, changed: tree.changed };
  }

  private async getStatusFile(force = false, operation = "公開状況"): Promise<CachedResponse<{ document: StatusDocument; sha: string }>> {
    const response = await this.request<ContentsResponse>(
      `/repos/${OWNER}/${REPOSITORY}/contents/${STATUS_PATH}?ref=${BRANCH}`,
      {},
      force ? undefined : this.statusCache?.etag ?? undefined,
      [],
      operation,
    );
    if (response.status === 304 && this.statusCache) return { ...this.statusCache, changed: false };
    if (response.status !== 200 || !response.data.content || response.data.encoding !== "base64") {
      throw new Error("status.json を取得できませんでした。先に初期化スクリプトを実行してください。");
    }
    let document: StatusDocument;
    try {
      document = validateStatusDocument(JSON.parse(decodeBase64Utf8(response.data.content)));
    } catch (error) {
      throw new Error(`status.json の検証に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`);
    }
    this.statusCache = { etag: response.etag, value: { document, sha: response.data.sha }, changed: true };
    return this.statusCache;
  }

  private async getImageStatusFile(force = false): Promise<CachedResponse<{ document: ImageStatusDocument; sha: string | null }>> {
    const response = await this.request<ContentsResponse>(
      `/repos/${OWNER}/${REPOSITORY}/contents/${IMAGE_STATUS_PATH}?ref=${BRANCH}`,
      {},
      force ? undefined : this.imageStatusCache?.etag ?? undefined,
      [404],
    );
    if (response.status === 304 && this.imageStatusCache) return { ...this.imageStatusCache, changed: false };
    if (response.status === 404) {
      const empty = {
        etag: null,
        value: { document: emptyImageStatusDocument(), sha: null },
        changed: this.imageStatusCache?.value.sha !== null,
      };
      this.imageStatusCache = empty;
      return empty;
    }
    if (response.status !== 200 || !response.data.content || response.data.encoding !== "base64") {
      throw new Error("image-status.json を取得できませんでした。");
    }
    let document: ImageStatusDocument;
    try {
      document = validateImageStatusDocument(JSON.parse(decodeBase64Utf8(response.data.content)));
    } catch (error) {
      throw new Error(`image-status.json の検証に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`);
    }
    this.imageStatusCache = { etag: response.etag, value: { document, sha: response.data.sha }, changed: true };
    return this.imageStatusCache;
  }

  private async request<T>(
    endpoint: string,
    init: RequestInit = {},
    etag?: string,
    acceptedErrorStatuses: number[] = [],
    operation = operationForEndpoint(endpoint, init),
  ): Promise<{ status: number; data: T; etag: string | null }> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init.body) headers.set("Content-Type", "application/json");
    if (etag) headers.set("If-None-Match", etag);

    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    let raw: string;
    try {
      response = await fetch(`${API_ROOT}${endpoint}`, { ...init, headers, signal: controller.signal });
      raw = await response.text();
    } catch (requestError) {
      throw createGithubNetworkError(
        operation,
        requestError,
        typeof navigator !== "undefined" && navigator.onLine === false,
      );
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
    const responseEtag = response.headers.get("ETag");
    if (response.status === 304) return { status: 304, data: undefined as T, etag: responseEtag ?? etag ?? null };

    let data: T;
    try {
      data = JSON.parse(raw) as T;
    } catch {
      throw createGithubApiError(response.status, "GitHub API が JSON を返しませんでした。", response.headers, operation);
    }
    if (!response.ok && response.status !== 409 && !acceptedErrorStatuses.includes(response.status)) {
      const message = typeof data === "object" && data && "message" in data ? String(data.message) : "API エラー";
      throw createGithubApiError(response.status, message, response.headers, operation);
    }
    return { status: response.status, data, etag: responseEtag };
  }
}

function operationForEndpoint(endpoint: string, init: RequestInit): string {
  const method = (init.method ?? "GET").toUpperCase();
  if (endpoint.includes("/git/trees/")) return "記事一覧";
  if (endpoint.includes("image-status.json")) return method === "PUT" ? "画像状態の保存" : "画像状態";
  if (endpoint.includes("status.json")) return method === "PUT" ? "公開状況の保存" : "公開状況";
  if (endpoint.includes("/contents/") && endpoint.includes("/images/")) return method === "PUT" ? "画像の登録" : "画像";
  if (endpoint.includes("/contents/")) return method === "PUT" ? "記事本文の保存" : "記事本文";
  return "GitHub API";
}

export function isArticlePath(path: string): boolean {
  if (!path.endsWith(".md") || path === "README.md") return false;
  const [category, filename] = path.split("/");
  if (!category || !filename || category.startsWith("_") || category === "assets") return false;
  if (filename === "README.md" || filename === "IDEAS.md") return false;
  return ["book-review", "design", "disney", "essay", "tools", "web-review"].includes(category);
}

function isImageAssetPath(path: string): boolean {
  const category = path.split("/", 1)[0];
  return ["book-review", "design", "disney", "essay", "tools", "web-review"].includes(category)
    && path.includes("/images/")
    && /\.(?:png|jpe?g|webp|gif)$/i.test(path);
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

export function decodeBase64Utf8(value: string): string {
  const normalized = value.replace(/\s/g, "");
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return encodeBase64Bytes(bytes);
}

export function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function mimeTypeForPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension ?? "png"}`;
}
