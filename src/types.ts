export type ArticleStatus = "queued" | "published" | "draft" | "unset";

export interface ArticleStatusEntry {
  status: ArticleStatus;
  queueOrder?: number;
  publishedUrl: string | null;
  publishedAt: string | null;
}

export interface StatusDocument {
  schemaVersion: 1;
  articles: Record<string, ArticleStatusEntry>;
}

export interface ArticlePath {
  path: string;
  category: string;
  status: ArticleStatus;
  queueOrder?: number;
  publishedUrl: string | null;
  publishedAt: string | null;
}

export interface ArticleContent {
  path: string;
  title: string;
  body: string;
  renderedHtml: string;
  warnings: string[];
}

export interface RepositorySnapshot {
  articles: ArticlePath[];
  status: StatusDocument;
  missingStatusPaths: string[];
  orphanStatusPaths: string[];
}
