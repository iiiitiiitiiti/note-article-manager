export type ArticleStatus = "queued" | "review" | "published" | "draft" | "unset";

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

export type ImageDecision = "pending" | "generate" | "provide" | "skip";

export type ImageRegistrationStage = "not-started" | "asset-uploaded" | "article-updated" | "completed";

export interface ImageTaskState {
  decision: ImageDecision;
  assetPath: string | null;
  registrationStage: ImageRegistrationStage;
  updatedAt: string | null;
}

export interface ImageStatusArticle {
  tasks: Record<string, ImageTaskState>;
}

export interface ImageStatusDocument {
  schemaVersion: 1;
  articles: Record<string, ImageStatusArticle>;
}

export interface ImageProgressSummary {
  total: number;
  pending: number;
  generate: number;
  provide: number;
  skip: number;
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
  imagePlaceholders: ImagePlaceholder[];
  localImagePaths: string[];
}

export interface ImagePlaceholder {
  id: string;
  raw: string;
  description: string;
  optional: boolean;
  start: number;
  end: number;
}

export interface RepositorySnapshot {
  articles: ArticlePath[];
  status: StatusDocument;
  imageStatus: ImageStatusDocument;
  missingStatusPaths: string[];
  orphanStatusPaths: string[];
}
