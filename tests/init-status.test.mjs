import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildStatusDocument, extractArticleTitle, extractFilenameOrder, parseDesignQueue, parseDisneyReviewStatuses } from "../scripts/init-status.mjs";
import { buildImageStatusDocument, parseImagePlaceholders } from "../scripts/init-image-status.mjs";
import { syncWebReviewImages } from "../scripts/sync-web-review-images.mjs";

test("parseDesignQueue validates order and filename numbers", () => {
  const queue = parseDesignQueue([
    "1. [01_one.md](design/01_one.md)",
    "2. [02_two.md](design/02_two.md)",
  ].join("\n"));
  assert.deepEqual(queue, [
    { order: 1, path: "design/01_one.md" },
    { order: 2, path: "design/02_two.md" },
  ]);
  assert.throws(() => parseDesignQueue("1. [02_two.md](design/02_two.md)"), /一致しません/);
});

test("extractFilenameOrder and parseDisneyReviewStatuses derive publication and review state", () => {
  assert.equal(extractFilenameOrder("design/03_three.md"), 3);
  assert.equal(extractFilenameOrder("essay/日記.md"), undefined);
  assert.deepEqual([...parseDisneyReviewStatuses([
    "### 01 一つ目",
    "**完成・ユーザーレビュー通過**（`01_one.md`）",
    "### 02 二つ目",
    "**完成・ユーザーレビュー待ち**（`02_two.md`）",
  ].join("\n")).entries()], [
    ["disney/01_one.md", "queued"],
    ["disney/02_two.md", "review"],
  ]);
});

test("extractArticleTitle reads the first H1 or H2 and ignores a missing heading", () => {
  assert.equal(extractArticleTitle("# 日本語のタイトル\n\n本文"), "日本語のタイトル");
  assert.equal(extractArticleTitle("## 小見出しタイトル\n\n本文"), "小見出しタイトル");
  assert.equal(extractArticleTitle("本文だけ\n"), undefined);
  assert.equal(extractArticleTitle("#    \n"), undefined);
});

test("buildStatusDocument initializes every article and preserves published state", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "note-article-manager-"));
  mkdirSync(join(repoRoot, "design"));
  mkdirSync(join(repoRoot, "disney"));
  mkdirSync(join(repoRoot, "essay"));
  mkdirSync(join(repoRoot, "_docs"));
  writeFileSync(join(repoRoot, "README.md"), "1. [01_one.md](design/01_one.md)\n");
  writeFileSync(join(repoRoot, "design/01_one.md"), "# One\n");
  writeFileSync(join(repoRoot, "disney/01_one.md"), "# One\n");
  writeFileSync(join(repoRoot, "disney/02_two.md"), "# Two\n");
  writeFileSync(join(repoRoot, "disney/IDEAS.md"), "### 01 一つ目\n**完成・ユーザーレビュー通過**（`01_one.md`）\n### 02 二つ目\n**完成・ユーザーレビュー待ち**（`02_two.md`）\n");
  writeFileSync(join(repoRoot, "essay/日記.md"), "# 日記\n");
  writeFileSync(join(repoRoot, "_docs/plan.md"), "# Excluded\n");

  assert.deepEqual(buildStatusDocument(repoRoot), {
    schemaVersion: 1,
    articles: {
      "design/01_one.md": { status: "queued", title: "One", queueOrder: 1, publishedUrl: null, publishedAt: null },
      "disney/01_one.md": { status: "queued", title: "One", queueOrder: 1, publishedUrl: null, publishedAt: null },
      "disney/02_two.md": { status: "review", title: "Two", queueOrder: 2, publishedUrl: null, publishedAt: null },
      "essay/日記.md": { status: "queued", title: "日記", publishedUrl: null, publishedAt: null },
    },
  });

  assert.deepEqual(buildStatusDocument(repoRoot, {
    schemaVersion: 1,
    articles: {
      "essay/日記.md": { status: "published", publicationOrder: 4, publishedUrl: "https://note.com/example", publishedAt: "2026-07-18T00:00:00.000Z" },
    },
  }).articles["essay/日記.md"], {
    status: "published",
    title: "日記",
    publicationOrder: 4,
    publishedUrl: "https://note.com/example",
    publishedAt: "2026-07-18T00:00:00.000Z",
  });
});

test("image placeholders become stable tasks and preserve decisions", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "note-article-manager-images-"));
  mkdirSync(join(repoRoot, "design"));
  writeFileSync(join(repoRoot, "design/01_one.md"), "# One\n\n【画像①: 見出し画像】\n\n【画像プレースホルダー（任意）：補足図】\n\n【画像】バタフライ投票用紙の構造を再現した自作の図解。\n");
  const placeholders = parseImagePlaceholders(readFileSync(join(repoRoot, "design/01_one.md"), "utf8"));
  assert.equal(placeholders.length, 3);
  assert.equal(placeholders[0].description, "見出し画像");
  assert.equal(placeholders[2].description, "バタフライ投票用紙の構造を再現した自作の図解。");
  const previous = {
    schemaVersion: 1,
    articles: {
      "design/01_one.md": {
        tasks: {
          [placeholders[0].id]: { decision: "generate", assetPath: "design/images/one.png", updatedAt: "2026-07-18T00:00:00.000Z" },
        },
      },
    },
  };
  assert.deepEqual(buildImageStatusDocument(repoRoot, previous), {
    schemaVersion: 1,
    articles: {
      "design/01_one.md": {
        tasks: {
          [placeholders[0].id]: { decision: "generate", assetPath: "design/images/one.png", updatedAt: "2026-07-18T00:00:00.000Z" },
          [placeholders[1].id]: { decision: "pending", assetPath: null, updatedAt: null },
          [placeholders[2].id]: { decision: "pending", assetPath: null, updatedAt: null },
        },
      },
    },
  });
});

test("web-review images are linked by numbered filenames", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "note-article-manager-web-review-"));
  mkdirSync(join(repoRoot, "web-review", "images", "sample-review"), { recursive: true });
  writeFileSync(join(repoRoot, "web-review/sample-review.md"), "# Sample\n\n【画像】ファーストビュー\n\n本文\n\n【画像】料金セクション\n");
  writeFileSync(join(repoRoot, "web-review/images/sample-review/01-first.png"), "image-1");
  writeFileSync(join(repoRoot, "web-review/images/sample-review/02-plan.png"), "image-2");
  writeFileSync(join(repoRoot, "web-review/images/sample-review/03-extra.png"), "image-3");
  writeFileSync(join(repoRoot, "image-status.json"), JSON.stringify({ schemaVersion: 1, articles: {} }));

  const result = syncWebReviewImages(repoRoot, "2026-07-20T10:00:00.000Z");
  assert.deepEqual(result.changedArticles, ["web-review/sample-review.md"]);
  assert.equal(readFileSync(join(repoRoot, "web-review/sample-review.md"), "utf8"), "# Sample\n\n![ファーストビュー](images/sample-review/01-first.png)\n\n本文\n\n![料金セクション](images/sample-review/02-plan.png)\n");
  const imageStatus = JSON.parse(readFileSync(join(repoRoot, "image-status.json"), "utf8"));
  assert.deepEqual(Object.values(imageStatus.articles["web-review/sample-review.md"].tasks).map((task) => ({
    decision: task.decision,
    assetPath: task.assetPath,
    registrationStage: task.registrationStage,
  })), [
    { decision: "provide", assetPath: "web-review/images/sample-review/01-first.png", registrationStage: "completed" },
    { decision: "provide", assetPath: "web-review/images/sample-review/02-plan.png", registrationStage: "completed" },
  ]);
});

test("web-review image sync skips incomplete image sequences and intentional skips", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "note-article-manager-web-review-skip-"));
  mkdirSync(join(repoRoot, "web-review", "images", "incomplete"), { recursive: true });
  mkdirSync(join(repoRoot, "web-review", "images", "intentional-skip"), { recursive: true });
  writeFileSync(join(repoRoot, "web-review/incomplete.md"), "# Incomplete\n\n【画像】一枚目\n\n【画像】二枚目\n");
  writeFileSync(join(repoRoot, "web-review/images/incomplete/01-only.png"), "image");
  writeFileSync(join(repoRoot, "web-review/intentional-skip.md"), "# Intentional skip\n\n【画像】不要な画像\n");
  writeFileSync(join(repoRoot, "web-review/images/intentional-skip/01-image.png"), "image");
  const placeholder = parseImagePlaceholders(readFileSync(join(repoRoot, "web-review/intentional-skip.md"), "utf8"))[0];
  writeFileSync(join(repoRoot, "image-status.json"), JSON.stringify({ schemaVersion: 1, articles: {
    "web-review/intentional-skip.md": { tasks: { [placeholder.id]: { decision: "skip", assetPath: null, updatedAt: null } } },
  } }));

  const result = syncWebReviewImages(repoRoot, "2026-07-20T10:00:00.000Z");
  assert.deepEqual(result.changedArticles, []);
  assert.equal(result.warnings.length, 1);
  assert.match(readFileSync(join(repoRoot, "web-review/incomplete.md"), "utf8"), /【画像】一枚目/);
  assert.match(readFileSync(join(repoRoot, "web-review/intentional-skip.md"), "utf8"), /【画像】不要な画像/);
});
