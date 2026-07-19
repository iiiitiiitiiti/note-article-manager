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

export type NoteTransferMode = "note" | "markdown";

export type NoteWarningKind = "table" | "image" | "html";

export interface NoteWarning {
  kind: NoteWarningKind;
  line: number;
  target: string;
  message: string;
  action: string;
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
  sourceMarkdown: string;
  renderedHtml: string;
  warnings: string[];
  warningDetails: NoteWarning[];
  imagePlaceholders: ImagePlaceholder[];
  localImagePaths: string[];
}

export type ImageInventoryIssueKind = "unreferenced" | "broken-reference" | "status-only";

export interface ImageInventoryIssue {
  kind: ImageInventoryIssueKind;
  path: string;
  articlePaths: string[];
  statusArticlePaths: string[];
  sha: string | null;
}

export interface ImageInventory {
  issues: ImageInventoryIssue[];
  scannedArticles: number;
  scannedAssets: number;
}

export type ArticleHealthIssueKind = "note-unsupported" | "missing-image" | "image-placeholder" | "image-pending" | "image-registration";

export interface ArticleHealthIssue {
  kind: ArticleHealthIssueKind;
  path: string;
  message: string;
  details: string[];
}

export interface ArticleHealthReport {
  checkedAt: string;
  scannedArticles: number;
  issues: ArticleHealthIssue[];
}

export interface PublicationScheduleConfig {
  startAt: string;
  intervalDays: number;
  category: string;
}

export interface ScheduledArticle {
  path: string;
  category: string;
  queueOrder?: number;
  scheduledAt: string;
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
