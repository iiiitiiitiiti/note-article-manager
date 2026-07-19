import assert from "node:assert/strict";
import test from "node:test";
import { filterArticleImageAssets, getImageTaskState, replaceImagePlaceholder, validateImageStatusDocument, withImageTaskState } from "../src/image-plan.ts";

const articlePath = "disney/11_disney-omnimover-article.md";
const taskId = "image-12345678-1";

test("legacy image status with an asset is treated as completed", () => {
  const document = validateImageStatusDocument({
    schemaVersion: 1,
    articles: { [articlePath]: { tasks: { [taskId]: { decision: "provide", assetPath: "disney/images/omnimover-image-12345678-1.png", updatedAt: null } } } },
  });

  assert.equal(getImageTaskState(document, articlePath, taskId).registrationStage, "completed");
});

test("image registration stages can be persisted and resumed one step at a time", () => {
  const initial = validateImageStatusDocument({ schemaVersion: 1, articles: {} });
  const assetUploaded = withImageTaskState(initial, articlePath, taskId, {
    assetPath: "disney/images/omnimover-image-12345678-1.png",
    registrationStage: "asset-uploaded",
  });
  const articleUpdated = withImageTaskState(assetUploaded, articlePath, taskId, { registrationStage: "article-updated" });
  const completed = withImageTaskState(articleUpdated, articlePath, taskId, { registrationStage: "completed" });

  assert.equal(getImageTaskState(assetUploaded, articlePath, taskId).registrationStage, "asset-uploaded");
  assert.equal(getImageTaskState(articleUpdated, articlePath, taskId).registrationStage, "article-updated");
  assert.equal(getImageTaskState(completed, articlePath, taskId).registrationStage, "completed");
});

test("replacing an existing task image does not duplicate the Markdown image", () => {
  const oldMarkdown = "本文\n\n![説明](images/omnimover-image-12345678-1.png)\n";
  const replacement = "![説明](images/omnimover-image-12345678-1.webp)";
  const nextMarkdown = replaceImagePlaceholder(oldMarkdown, taskId, replacement);

  assert.equal(nextMarkdown, "本文\n\n![説明](images/omnimover-image-12345678-1.webp)\n");
  assert.equal((nextMarkdown.match(/!\[/g) ?? []).length, 1);
});

test("article image inventory filters assets to the current article", () => {
  const assets = filterArticleImageAssets(articlePath, [
    { type: "file", path: "disney/images/disney-omnimover-article-image-12345678-1.png" },
    { type: "file", path: "disney/images/disney-other-article-image-other.webp" },
    { type: "file", path: "disney/images/another-article-image-12345678-1.png" },
    { type: "dir", path: "disney/images/disney-omnimover-article-image-12345678-1" },
  ]);

  assert.deepEqual(assets, ["disney/images/disney-omnimover-article-image-12345678-1.png"]);
});
