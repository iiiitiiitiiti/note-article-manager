import assert from "node:assert/strict";
import test from "node:test";
import { inspectArticleHealth } from "../src/health.ts";
import { createImageTaskId } from "../src/image-plan.ts";
import { buildPublicationSchedule, hasMissingPublicationOrders } from "../src/schedule.ts";

const emptyImageStatus = { schemaVersion: 1, articles: {} };

test("article health check finds note warnings, missing images, and undecided image tasks", () => {
  const markdown = "# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![missing](images/missing.png)\n\n【画像: cover】";
  const issues = inspectArticleHealth(markdown, "design/01_title.md", new Set(), emptyImageStatus);

  assert.deepEqual(issues.map((issue) => issue.kind), ["note-unsupported", "missing-image", "image-pending"]);
  assert.match(issues[0].details[0], /3行目/);
  assert.deepEqual(issues[1].details, ["design/images/missing.png"]);
  assert.deepEqual(issues[2].details, ["cover"]);
});

test("completed image tasks still report a placeholder left in the article", () => {
  const markdown = "# Title\n\n【画像: cover】";
  const taskId = createImageTaskId("cover", 0);
  const imageStatus = { schemaVersion: 1, articles: { "design/01_title.md": { tasks: { [taskId]: { decision: "provide", assetPath: "design/images/cover.png", registrationStage: "completed", updatedAt: null } } } } };
  const issues = inspectArticleHealth(markdown, "design/01_title.md", new Set(), imageStatus);

  assert.equal(issues[0].kind, "image-placeholder");
});

test("publication schedule uses queued articles and the configured interval", () => {
  const articles = [
    { path: "design/02_two.md", category: "design", status: "queued", queueOrder: 2, publishedUrl: null, publishedAt: null },
    { path: "design/01_one.md", category: "design", status: "queued", queueOrder: 1, publishedUrl: null, publishedAt: null },
    { path: "disney/01_review.md", category: "disney", status: "review", queueOrder: 1, publishedUrl: null, publishedAt: null },
  ];
  const schedule = buildPublicationSchedule(articles, { startAt: "2026-07-20T09:00:00Z", intervalDays: 7, category: "design" });

  assert.deepEqual(schedule.map((item) => item.path), ["design/01_one.md", "design/02_two.md"]);
  assert.equal(schedule[1].scheduledAt, "2026-07-27T09:00:00.000Z");
});

test("all-category publication schedules use the explicit mixed publication order", () => {
  const articles = [
    { path: "book-review/01_book.md", category: "book-review", status: "queued", queueOrder: 1, publicationOrder: 2, publishedUrl: null, publishedAt: null },
    { path: "design/01_design.md", category: "design", status: "queued", queueOrder: 1, publicationOrder: 1, publishedUrl: null, publishedAt: null },
    { path: "essay/essay.md", category: "essay", status: "queued", publishedUrl: null, publishedAt: null },
  ];
  const schedule = buildPublicationSchedule(articles, { startAt: "2026-07-20T09:00:00Z", intervalDays: 7, category: "all", frequency: "weekly" });

  assert.deepEqual(schedule.map((item) => item.path), ["design/01_design.md", "book-review/01_book.md"]);
  assert.equal(hasMissingPublicationOrders(articles, "all"), false);
});

test("missing publication order warning ignores essays but detects other queued articles", () => {
  const articles = [
    { path: "essay/essay.md", category: "essay", status: "queued", publishedUrl: null, publishedAt: null },
    { path: "design/01_design.md", category: "design", status: "queued", publishedUrl: null, publishedAt: null },
  ];

  assert.equal(hasMissingPublicationOrders(articles, "all"), true);
  assert.equal(hasMissingPublicationOrders([articles[0]], "all"), false);
});

test("weekday schedules assign one article to each selected weekday", () => {
  const articles = [
    { path: "design/01_one.md", category: "design", status: "queued", queueOrder: 1, publishedUrl: null, publishedAt: null },
    { path: "design/02_two.md", category: "design", status: "queued", queueOrder: 2, publishedUrl: null, publishedAt: null },
    { path: "design/03_three.md", category: "design", status: "queued", queueOrder: 3, publishedUrl: null, publishedAt: null },
  ];
  const schedule = buildPublicationSchedule(articles, { startAt: "2026-07-20T09:00:00Z", intervalDays: 7, category: "design", frequency: "weekdays", weekdays: [1, 3] });

  assert.deepEqual(schedule.map((item) => item.scheduledAt), [
    "2026-07-20T09:00:00.000Z",
    "2026-07-22T09:00:00.000Z",
    "2026-07-27T09:00:00.000Z",
  ]);
});
