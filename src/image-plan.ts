import type { ImageDecision, ImagePlaceholder, ImageRegistrationStage, ImageStatusArticle, ImageStatusDocument, ImageTaskState } from "./types";

export const IMAGE_STATUS_PATH = "image-status.json";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const VALID_DECISIONS = new Set<ImageDecision>(["pending", "generate", "provide", "skip"]);
const VALID_REGISTRATION_STAGES = new Set<ImageRegistrationStage>(["not-started", "asset-uploaded", "article-updated", "completed"]);
const PLACEHOLDER_PATTERN = /^[ \t]*【画像[^】]*】[ \t]*$/gm;
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;

export function emptyImageStatusDocument(): ImageStatusDocument {
  return { schemaVersion: 1, articles: {} };
}

export function validateImageStatusDocument(value: unknown): ImageStatusDocument {
  if (!value || typeof value !== "object") throw new Error("image-status.json は JSON オブジェクトではありません。");
  const document = value as { schemaVersion?: unknown; articles?: unknown };
  if (document.schemaVersion !== 1) throw new Error("image-status.json の schemaVersion が対応していません。");
  if (!document.articles || typeof document.articles !== "object" || Array.isArray(document.articles)) {
    throw new Error("image-status.json の articles が不正です。");
  }

  const articles: ImageStatusDocument["articles"] = {};
  for (const [path, rawArticle] of Object.entries(document.articles)) {
    if (!path.endsWith(".md") || !rawArticle || typeof rawArticle !== "object") {
      throw new Error(`image-status.json の記事エントリが不正です: ${path}`);
    }
    const tasksValue = (rawArticle as { tasks?: unknown }).tasks;
    if (!tasksValue || typeof tasksValue !== "object" || Array.isArray(tasksValue)) {
      throw new Error(`image-status.json の tasks が不正です: ${path}`);
    }
    const tasks: ImageStatusArticle["tasks"] = {};
    for (const [taskId, rawTask] of Object.entries(tasksValue)) {
      if (!rawTask || typeof rawTask !== "object") throw new Error(`画像タスクが不正です: ${path}/${taskId}`);
      const task = rawTask as Partial<ImageTaskState>;
      if (typeof task.decision !== "string" || !VALID_DECISIONS.has(task.decision as ImageDecision)) {
        throw new Error(`画像タスクの decision が不正です: ${path}/${taskId}`);
      }
      if (task.assetPath !== null && task.assetPath !== undefined && !isSafeAssetPath(task.assetPath)) {
        throw new Error(`画像タスクの assetPath が不正です: ${path}/${taskId}`);
      }
      const registrationStage = task.registrationStage ?? (task.assetPath ? "completed" : "not-started");
      if (typeof registrationStage !== "string" || !VALID_REGISTRATION_STAGES.has(registrationStage as ImageRegistrationStage)) {
        throw new Error(`画像タスクの registrationStage が不正です: ${path}/${taskId}`);
      }
      if (task.updatedAt !== null && task.updatedAt !== undefined && Number.isNaN(Date.parse(task.updatedAt))) {
        throw new Error(`画像タスクの updatedAt が不正です: ${path}/${taskId}`);
      }
      tasks[taskId] = {
        decision: task.decision as ImageDecision,
        assetPath: task.assetPath ?? null,
        registrationStage: registrationStage as ImageRegistrationStage,
        updatedAt: task.updatedAt ?? null,
      };
    }
    articles[path] = { tasks };
  }
  return { schemaVersion: 1, articles };
}

export function parseImagePlaceholders(markdown: string): ImagePlaceholder[] {
  const occurrences = new Map<string, number>();
  const placeholders: ImagePlaceholder[] = [];
  for (const match of markdown.matchAll(PLACEHOLDER_PATTERN)) {
    const raw = match[0];
    const trimmed = raw.trim();
    const inside = trimmed.slice(1, -1);
    const description = inside
      .replace(/^画像(?:プレースホルダー(?:（任意）)?|[0-9０-９①-㊿]+)?\s*(?:[:：])?\s*/, "")
      .trim() || inside;
    const occurrence = occurrences.get(description) ?? 0;
    occurrences.set(description, occurrence + 1);
    const start = match.index ?? 0;
    placeholders.push({
      id: createImageTaskId(description, occurrence),
      raw,
      description,
      optional: inside.includes("任意"),
      start,
      end: start + raw.length,
    });
  }
  return placeholders;
}

export function createImageTaskId(description: string, occurrence: number): string {
  let hash = 2166136261;
  for (const character of description) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `image-${(hash >>> 0).toString(16).padStart(8, "0")}-${occurrence + 1}`;
}

export function getImageTaskState(document: ImageStatusDocument, articlePath: string, taskId: string): ImageTaskState {
  return document.articles[articlePath]?.tasks[taskId] ?? { decision: "pending", assetPath: null, registrationStage: "not-started", updatedAt: null };
}

export function withImageTaskState(
  document: ImageStatusDocument,
  articlePath: string,
  taskId: string,
  patch: Partial<ImageTaskState>,
): ImageStatusDocument {
  const current = getImageTaskState(document, articlePath, taskId);
  return {
    schemaVersion: 1,
    articles: {
      ...document.articles,
      [articlePath]: {
        tasks: {
          ...(document.articles[articlePath]?.tasks ?? {}),
          [taskId]: { ...current, ...patch },
        },
      },
    },
  };
}

export function replaceImagePlaceholder(markdown: string, taskId: string, replacement: string): string {
  const placeholder = parseImagePlaceholders(markdown).find((item) => item.id === taskId);
  if (placeholder) return `${markdown.slice(0, placeholder.start)}${replacement}${markdown.slice(placeholder.end)}`;

  const existingImagePattern = new RegExp(`!\\[[^\\]]*\\]\\([^)]*${escapeRegExp(taskId)}\\.(?:png|jpe?g|webp|gif)(?:\\s+["'][^)]*["'])?\\)`, "i");
  const existingImage = existingImagePattern.exec(markdown);
  if (existingImage?.index !== undefined) {
    return `${markdown.slice(0, existingImage.index)}${replacement}${markdown.slice(existingImage.index + existingImage[0].length)}`;
  }
  throw new Error("記事が更新されているため、画像プレースホルダーを見つけられません。記事を再読み込みしてください。");
}

export function buildImageAssetPath(articlePath: string, taskId: string, fileName: string): string {
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  if (!extension || !["png", "jpg", "jpeg", "webp", "gif"].includes(extension)) {
    throw new Error("対応している画像形式は PNG、JPEG、WebP、GIF です。");
  }
  return `${imageAssetPrefix(articlePath)}-${taskId}.${extension === "jpeg" ? "jpg" : extension}`;
}

export function imageAssetPrefix(articlePath: string): string {
  const category = articlePath.split("/", 1)[0];
  const articleName = articlePath.split("/").at(-1)?.replace(/\.md$/i, "") ?? "article";
  const slug = articleName.replace(/^\d+[_-]?/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "article";
  return `${category}/images/${slug}`;
}

export function filterArticleImageAssets(articlePath: string, entries: Array<{ path?: string; type?: string }>): string[] {
  const prefix = `${imageAssetPrefix(articlePath)}-`;
  return entries
    .filter((entry) => entry.type === "file" && typeof entry.path === "string" && entry.path.startsWith(prefix) && /\.(?:png|jpe?g|webp|gif)$/i.test(entry.path))
    .map((entry) => entry.path as string)
    .sort((left, right) => left.localeCompare(right, "ja"));
}

export function extractLocalImagePaths(markdown: string, articlePath: string): string[] {
  const paths = new Set<string>();
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const href = match[2];
    const resolved = resolveRelativeImagePath(articlePath, href);
    if (resolved) paths.add(resolved);
  }
  return [...paths];
}

export function resolveRelativeImagePath(articlePath: string, href: string): string | null {
  if (/^(?:https?:|data:|blob:|#|\/)/i.test(href)) return null;
  const parts = [...articlePath.split("/", -1).slice(0, -1), ...href.split("/")];
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (normalized.length === 0) return null;
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  const resolved = normalized.join("/");
  return resolved.startsWith("assets/") || resolved.includes("/images/") ? resolved : null;
}

export function replaceLocalImageSources(markdown: string, articlePath: string, sources: Record<string, string>): string {
  return markdown.replace(MARKDOWN_IMAGE_PATTERN, (full, alt: string, href: string) => {
    const path = resolveRelativeImagePath(articlePath, href);
    const source = path ? sources[path] : undefined;
    return source ? `![${alt}](${source})` : full;
  });
}

function isSafeAssetPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split("/").includes("..") && /\.(?:png|jpe?g|webp|gif)$/i.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
