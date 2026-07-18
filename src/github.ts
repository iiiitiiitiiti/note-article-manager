import { mergeArticlePaths, validateStatusDocument, withArticleStatus } from "./status";
import { emptyImageStatusDocument, IMAGE_STATUS_PATH, MAX_IMAGE_BYTES, replaceImagePlaceholder, validateImageStatusDocument, withImageTaskState } from "./image-plan";
import type { ArticleStatusEntry, ImageStatusDocument, ImageTaskState, RepositorySnapshot, StatusDocument } from "./types";

const API_ROOT = "https://api.github.com";
const OWNER = "iiiitiiitiiti";
const REPOSITORY = "note-articles";
const BRANCH = "main";
const STATUS_PATH = "status.json";
const MAX_WRITE_ATTEMPTS = 3;

interface CachedResponse<T> {
  etag: string | null;
  value: T;
}

interface ContentsResponse {
  content?: string;
  encoding?: string;
  sha: string;
}

interface TreeResponse {
  tree?: Array<{ path?: string; type?: string }>;
  truncated?: boolean;
}

export class GithubClient {
  private treeCache?: CachedResponse<string[]>;
  private statusCache?: CachedResponse<{ document: StatusDocument; sha: string }>;
  private imageStatusCache?: CachedResponse<{ document: ImageStatusDocument; sha: string | null }>;
  private writeQueue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly token: string) {}

  public async loadSnapshot(): Promise<RepositorySnapshot> {
    const [paths, status, imageStatus] = await Promise.all([this.getArticlePaths(), this.getStatusFile(), this.getImageStatusFile()]);
    const merged = mergeArticlePaths(paths.value, status.value.document);
    return {
      articles: merged.articles,
      status: status.value.document,
      imageStatus: imageStatus.value.document,
      missingStatusPaths: merged.missingStatusPaths,
      orphanStatusPaths: merged.orphanStatusPaths,
    };
  }

  public async getArticle(path: string): Promise<string> {
    const file = await this.getArticleFile(path);
    return file.content;
  }

  public async getArticleFile(path: string): Promise<{ content: string; sha: string }> {
    const response = await this.request<ContentsResponse>(
      `/repos/${OWNER}/${REPOSITORY}/contents/${encodePath(path)}?ref=${BRANCH}`,
    );
    if (response.status !== 200 || !response.data.content || response.data.encoding !== "base64") {
      throw new Error(`記事本文を取得できませんでした: ${path}`);
    }
    return { content: decodeBase64Utf8(response.data.content), sha: response.data.sha };
  }

  public async getImageDataUrl(path: string): Promise<string> {
    const file = await this.getArticleFile(path);
    const normalized = file.content.replace(/\s/g, "");
    if (normalized.length * 0.75 > MAX_IMAGE_BYTES) throw new Error(`画像が大きすぎるためプレビューできません: ${path}`);
    return `data:${mimeTypeForPath(path)};base64,${normalized}`;
  }

  public async uploadImage(path: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("画像は1バイト以上、5MB以下にしてください。");
    }
    const response = await this.request<ContentsResponse>(
      `/repos/${OWNER}/${REPOSITORY}/contents/${encodePath(path)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          message: `image: add ${path}`,
          content: encodeBase64Bytes(bytes),
          branch: BRANCH,
        }),
      },
    );
    if (response.status !== 200 && response.status !== 201) throw new Error(`画像のアップロードに失敗しました (${response.status})`);
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
        this.statusCache = { etag: null, value: { document: nextDocument, sha: newSha } };
        return nextDocument;
      }
      if (response.status !== 409) {
        throw new Error(`status.json の更新に失敗しました (${response.status})`);
      }
      this.statusCache = undefined;
      if (attempt === MAX_WRITE_ATTEMPTS) break;
    }

    throw new Error("status.json が別端末で更新され続けているため、保存を中止しました。再読み込みして再試行してください。");
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
        this.imageStatusCache = { etag: null, value: { document: nextDocument, sha: response.data.sha } };
        return nextDocument;
      }
      if (response.status !== 409) throw new Error(`image-status.json の更新に失敗しました (${response.status})`);
      this.imageStatusCache = undefined;
      if (attempt === MAX_WRITE_ATTEMPTS) break;
    }
    throw new Error("image-status.json が別端末で更新され続けているため、保存を中止しました。再読み込みして再試行してください。");
  }

  public updateArticleWithImage(articlePath: string, taskId: string, imageMarkdown: string): Promise<string> {
    const operation = this.writeQueue.then(() => this.updateArticleWithImageWithRetry(articlePath, taskId, imageMarkdown));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async updateArticleWithImageWithRetry(articlePath: string, taskId: string, imageMarkdown: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const latest = await this.getArticleFile(articlePath);
      const nextMarkdown = replaceImagePlaceholder(latest.content, taskId, imageMarkdown);
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
    throw new Error("記事本文が別端末で更新され続けているため、画像の差し込みを中止しました。再読み込みして再試行してください。");
  }

  private async getArticlePaths(): Promise<CachedResponse<string[]>> {
    const response = await this.request<TreeResponse>(
      `/repos/${OWNER}/${REPOSITORY}/git/trees/${BRANCH}?recursive=1`,
      {},
      this.treeCache?.etag ?? undefined,
    );
    if (response.status === 304 && this.treeCache) return this.treeCache;
    if (response.status !== 200 || !response.data.tree) {
      throw new Error("記事一覧を取得できませんでした。");
    }
    if (response.data.truncated) {
      throw new Error("GitHub の記事ツリーが大きすぎるため、安全のため表示を中止しました。");
    }
    const paths = response.data.tree
      .filter((entry) => entry.type === "blob" && typeof entry.path === "string" && isArticlePath(entry.path))
      .map((entry) => entry.path as string)
      .sort((left, right) => left.localeCompare(right, "ja"));
    this.treeCache = { etag: response.etag, value: paths };
    return this.treeCache;
  }

  private async getStatusFile(force = false): Promise<CachedResponse<{ document: StatusDocument; sha: string }>> {
    const response = await this.request<ContentsResponse>(
      `/repos/${OWNER}/${REPOSITORY}/contents/${STATUS_PATH}?ref=${BRANCH}`,
      {},
      force ? undefined : this.statusCache?.etag ?? undefined,
    );
    if (response.status === 304 && this.statusCache) return this.statusCache;
    if (response.status !== 200 || !response.data.content || response.data.encoding !== "base64") {
      throw new Error("status.json を取得できませんでした。先に初期化スクリプトを実行してください。");
    }
    let document: StatusDocument;
    try {
      document = validateStatusDocument(JSON.parse(decodeBase64Utf8(response.data.content)));
    } catch (error) {
      throw new Error(`status.json の検証に失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`);
    }
    this.statusCache = { etag: response.etag, value: { document, sha: response.data.sha } };
    return this.statusCache;
  }

  private async getImageStatusFile(force = false): Promise<CachedResponse<{ document: ImageStatusDocument; sha: string | null }>> {
    const response = await this.request<ContentsResponse>(
      `/repos/${OWNER}/${REPOSITORY}/contents/${IMAGE_STATUS_PATH}?ref=${BRANCH}`,
      {},
      force ? undefined : this.imageStatusCache?.etag ?? undefined,
      [404],
    );
    if (response.status === 304 && this.imageStatusCache) return this.imageStatusCache;
    if (response.status === 404) {
      const empty = { etag: null, value: { document: emptyImageStatusDocument(), sha: null } };
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
    this.imageStatusCache = { etag: response.etag, value: { document, sha: response.data.sha } };
    return this.imageStatusCache;
  }

  private async request<T>(
    endpoint: string,
    init: RequestInit = {},
    etag?: string,
    acceptedErrorStatuses: number[] = [],
  ): Promise<{ status: number; data: T; etag: string | null }> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init.body) headers.set("Content-Type", "application/json");
    if (etag) headers.set("If-None-Match", etag);

    const response = await fetch(`${API_ROOT}${endpoint}`, { ...init, headers });
    const responseEtag = response.headers.get("ETag");
    if (response.status === 304) return { status: 304, data: undefined as T, etag: responseEtag ?? etag ?? null };

    const raw = await response.text();
    let data: T;
    try {
      data = JSON.parse(raw) as T;
    } catch {
      throw new Error(`GitHub API が JSON を返しませんでした (${response.status})`);
    }
    if (!response.ok && response.status !== 409 && !acceptedErrorStatuses.includes(response.status)) {
      const message = typeof data === "object" && data && "message" in data ? String(data.message) : "API エラー";
      throw new Error(`${message} (${response.status})`);
    }
    return { status: response.status, data, etag: responseEtag };
  }
}

export function isArticlePath(path: string): boolean {
  if (!path.endsWith(".md") || path === "README.md") return false;
  const [category, filename] = path.split("/");
  if (!category || !filename || category.startsWith("_") || category === "assets") return false;
  if (filename === "README.md" || filename === "IDEAS.md") return false;
  return ["book-review", "design", "disney", "essay", "tools", "web-review"].includes(category);
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
