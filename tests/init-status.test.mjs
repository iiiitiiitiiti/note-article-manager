import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildStatusDocument, extractFilenameOrder, parseDesignQueue, parseDisneyReviewStatuses } from "../scripts/init-status.mjs";
import { buildImageStatusDocument, parseImagePlaceholders } from "../scripts/init-image-status.mjs";

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
      "design/01_one.md": { status: "queued", queueOrder: 1, publishedUrl: null, publishedAt: null },
      "disney/01_one.md": { status: "queued", queueOrder: 1, publishedUrl: null, publishedAt: null },
      "disney/02_two.md": { status: "review", queueOrder: 2, publishedUrl: null, publishedAt: null },
      "essay/日記.md": { status: "queued", publishedUrl: null, publishedAt: null },
    },
  });

  assert.deepEqual(buildStatusDocument(repoRoot, {
    schemaVersion: 1,
    articles: {
      "essay/日記.md": { status: "published", publicationOrder: 4, publishedUrl: "https://note.com/example", publishedAt: "2026-07-18T00:00:00.000Z" },
    },
  }).articles["essay/日記.md"], {
    status: "published",
    publicationOrder: 4,
    publishedUrl: "https://note.com/example",
    publishedAt: "2026-07-18T00:00:00.000Z",
  });
});

test("image placeholders become stable tasks and preserve decisions", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "note-article-manager-images-"));
  mkdirSync(join(repoRoot, "design"));
  writeFileSync(join(repoRoot, "design/01_one.md"), "# One\n\n【画像①: 見出し画像】\n\n【画像プレースホルダー（任意）：補足図】\n");
  const placeholders = parseImagePlaceholders(readFileSync(join(repoRoot, "design/01_one.md"), "utf8"));
  assert.equal(placeholders.length, 2);
  assert.equal(placeholders[0].description, "見出し画像");
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
        },
      },
    },
  });
});
