import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildStatusDocument, parseDesignQueue } from "../scripts/init-status.mjs";

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

test("buildStatusDocument includes only article Markdown and initializes statuses", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "note-article-manager-"));
  mkdirSync(join(repoRoot, "design"));
  mkdirSync(join(repoRoot, "essay"));
  mkdirSync(join(repoRoot, "_docs"));
  writeFileSync(join(repoRoot, "README.md"), "1. [01_one.md](design/01_one.md)\n");
  writeFileSync(join(repoRoot, "design/01_one.md"), "# One\n");
  writeFileSync(join(repoRoot, "essay/日記.md"), "# 日記\n");
  writeFileSync(join(repoRoot, "_docs/plan.md"), "# Excluded\n");

  assert.deepEqual(buildStatusDocument(repoRoot), {
    schemaVersion: 1,
    articles: {
      "design/01_one.md": { status: "queued", queueOrder: 1, publishedUrl: null, publishedAt: null },
      "essay/日記.md": { status: "unset", publishedUrl: null, publishedAt: null },
    },
  });
});
