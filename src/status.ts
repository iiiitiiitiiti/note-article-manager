import type { ArticlePath, ArticleStatusEntry, StatusDocument } from "./types";

const VALID_STATUSES = new Set(["queued", "review", "published", "draft", "unset"]);

export function emptyStatusEntry(status: ArticleStatusEntry["status"] = "unset"): ArticleStatusEntry {
  return { status, publishedUrl: null, publishedAt: null };
}

export function validateStatusDocument(value: unknown): StatusDocument {
  if (!value || typeof value !== "object") {
    throw new Error("status.json は JSON オブジェクトではありません。");
  }

  const document = value as { schemaVersion?: unknown; articles?: unknown };
  if (document.schemaVersion !== 1) {
    throw new Error("status.json の schemaVersion が対応していません。");
  }
  if (!document.articles || typeof document.articles !== "object" || Array.isArray(document.articles)) {
    throw new Error("status.json の articles が不正です。");
  }

  const articles: Record<string, ArticleStatusEntry> = {};
  for (const [path, rawEntry] of Object.entries(document.articles)) {
    if (!path.endsWith(".md") || !rawEntry || typeof rawEntry !== "object") {
      throw new Error(`status.json の記事エントリが不正です: ${path}`);
    }
    const entry = rawEntry as Partial<ArticleStatusEntry>;
    if (typeof entry.status !== "string" || !VALID_STATUSES.has(entry.status)) {
      throw new Error(`status.json の status が不正です: ${path}`);
    }
    if (entry.queueOrder !== undefined && (!Number.isInteger(entry.queueOrder) || entry.queueOrder < 1)) {
      throw new Error(`status.json の queueOrder が不正です: ${path}`);
    }
    if (entry.status === "published" && !isHttpUrl(entry.publishedUrl)) {
      throw new Error(`公開済み記事に publishedUrl がありません: ${path}`);
    }
    if (entry.publishedUrl !== null && entry.publishedUrl !== undefined && !isHttpUrl(entry.publishedUrl)) {
      throw new Error(`status.json の publishedUrl が不正です: ${path}`);
    }
    if (entry.publishedAt !== null && entry.publishedAt !== undefined && Number.isNaN(Date.parse(entry.publishedAt))) {
      throw new Error(`status.json の publishedAt が不正です: ${path}`);
    }

    articles[path] = {
      status: entry.status,
      ...(entry.queueOrder === undefined ? {} : { queueOrder: entry.queueOrder }),
      publishedUrl: entry.publishedUrl ?? null,
      publishedAt: entry.publishedAt ?? null,
    };
  }

  return { schemaVersion: 1, articles };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function mergeArticlePaths(paths: string[], status: StatusDocument): {
  articles: ArticlePath[];
  missingStatusPaths: string[];
  orphanStatusPaths: string[];
} {
  const pathSet = new Set(paths);
  const missingStatusPaths = paths.filter((path) => !status.articles[path]);
  const orphanStatusPaths = Object.keys(status.articles).filter((path) => !pathSet.has(path));

  const articles = paths.map((path) => {
    const category = path.split("/", 1)[0];
    const entry = status.articles[path] ?? emptyStatusEntry(category === "disney" ? "review" : "queued");
    return {
      path,
      category,
      status: entry.status,
      queueOrder: entry.queueOrder,
      publishedUrl: entry.publishedUrl,
      publishedAt: entry.publishedAt,
    };
  });

  articles.sort((left, right) => {
    if (left.category === right.category) {
      return (left.queueOrder ?? Number.MAX_SAFE_INTEGER) - (right.queueOrder ?? Number.MAX_SAFE_INTEGER) || left.path.localeCompare(right.path, "ja");
    }
    return left.path.localeCompare(right.path, "ja");
  });

  return { articles, missingStatusPaths, orphanStatusPaths };
}

export function withArticleStatus(
  status: StatusDocument,
  path: string,
  patch: Partial<ArticleStatusEntry>,
): StatusDocument {
  const current = status.articles[path] ?? emptyStatusEntry();
  return {
    schemaVersion: 1,
    articles: {
      ...status.articles,
      [path]: { ...current, ...patch },
    },
  };
}
