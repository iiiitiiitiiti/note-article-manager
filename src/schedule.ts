import type { ArticlePath, PublicationScheduleConfig, PublicationScheduleFrequency, ScheduledArticle } from "./types";

export const WEEKDAY_OPTIONS = [
  { value: 0, label: "日" },
  { value: 1, label: "月" },
  { value: 2, label: "火" },
  { value: 3, label: "水" },
  { value: 4, label: "木" },
  { value: 5, label: "金" },
  { value: 6, label: "土" },
] as const;

export const DEFAULT_SCHEDULE: PublicationScheduleConfig = { startAt: "", intervalDays: 7, category: "all", notificationTime: "09:00" };

export function getPublicationScheduleFrequency(config: PublicationScheduleConfig): PublicationScheduleFrequency {
  if (config.frequency) return config.frequency;
  if (config.intervalDays === 1) return "daily";
  if (config.intervalDays === 14) return "biweekly";
  return "weekly";
}

export function buildPublicationSchedule(articles: ArticlePath[], config: PublicationScheduleConfig): ScheduledArticle[] {
  if (!config.startAt) return [];
  const start = new Date(config.startAt);
  const frequency = getPublicationScheduleFrequency(config);
  if (Number.isNaN(start.getTime()) || !Number.isFinite(config.intervalDays) || config.intervalDays <= 0) return [];
  const weekdays = normalizeWeekdays(config.weekdays);
  if (frequency === "weekdays" && weekdays.length === 0) return [];
  const targets = articles
    .filter((article) => article.status === "queued" && article.category !== "essay" && (config.category === "all" || article.category === config.category))
    .sort((left, right) => compareArticleOrder(left, right, config.category === "all"));
  return targets.flatMap((article, index) => {
    const scheduledAt = getScheduledAt(start, index, frequency, config.intervalDays, weekdays);
    return scheduledAt ? [{
      path: article.path,
      category: article.category,
      queueOrder: article.queueOrder,
      publicationOrder: article.publicationOrder,
      scheduledAt: scheduledAt.toISOString(),
    }] : [];
  });
}

export function hasMissingPublicationOrders(articles: ArticlePath[], category: string): boolean {
  return category === "all" && articles.some((article) => article.status === "queued" && article.category !== "essay" && article.publicationOrder === undefined);
}

function compareArticleOrder(left: ArticlePath, right: ArticlePath, mixedCategories: boolean): number {
  if (mixedCategories) {
    return (left.publicationOrder ?? Number.MAX_SAFE_INTEGER) - (right.publicationOrder ?? Number.MAX_SAFE_INTEGER)
      || left.category.localeCompare(right.category, "ja")
      || (left.queueOrder ?? Number.MAX_SAFE_INTEGER) - (right.queueOrder ?? Number.MAX_SAFE_INTEGER)
      || left.path.localeCompare(right.path, "ja");
  }
  return (left.queueOrder ?? Number.MAX_SAFE_INTEGER) - (right.queueOrder ?? Number.MAX_SAFE_INTEGER) || left.path.localeCompare(right.path, "ja");
}

function normalizeWeekdays(values: number[] | undefined): number[] {
  return [...new Set((values ?? []).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6))].sort((left, right) => left - right);
}

function getScheduledAt(start: Date, index: number, frequency: PublicationScheduleFrequency, intervalDays: number, weekdays: number[]): Date | null {
  if (frequency !== "weekdays") return new Date(start.getTime() + index * intervalDays * 24 * 60 * 60 * 1000);
  const selected = new Set(weekdays);
  const cursor = new Date(start.getTime());
  let occurrence = 0;
  for (let days = 0; days < 3660; days += 1) {
    if (selected.has(cursor.getDay())) {
      if (occurrence === index) return cursor;
      occurrence += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return null;
}
