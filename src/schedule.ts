import type { ArticlePath, PublicationScheduleConfig, ScheduledArticle } from "./types";

export const DEFAULT_SCHEDULE: PublicationScheduleConfig = { startAt: "", intervalDays: 7, category: "all" };

export function buildPublicationSchedule(articles: ArticlePath[], config: PublicationScheduleConfig): ScheduledArticle[] {
  if (!config.startAt) return [];
  const start = new Date(config.startAt);
  if (Number.isNaN(start.getTime()) || !Number.isFinite(config.intervalDays) || config.intervalDays <= 0) return [];
  const targets = articles
    .filter((article) => article.status === "queued" && (config.category === "all" || article.category === config.category))
    .sort((left, right) => left.category.localeCompare(right.category, "ja") || (left.queueOrder ?? Number.MAX_SAFE_INTEGER) - (right.queueOrder ?? Number.MAX_SAFE_INTEGER) || left.path.localeCompare(right.path, "ja"));
  return targets.map((article, index) => ({
    path: article.path,
    category: article.category,
    queueOrder: article.queueOrder,
    scheduledAt: new Date(start.getTime() + index * config.intervalDays * 24 * 60 * 60 * 1000).toISOString(),
  }));
}
