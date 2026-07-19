import { extractLocalImagePaths, getImageTaskState, parseImagePlaceholders } from "./image-plan";
import { getNoteWarningDetails } from "./markdown";
import type { ArticleHealthIssue, ImageStatusDocument } from "./types";

export function inspectArticleHealth(markdown: string, articlePath: string, availableImages: Set<string>, imageStatus: ImageStatusDocument): ArticleHealthIssue[] {
  const issues: ArticleHealthIssue[] = [];
  const warningDetails = getNoteWarningDetails(markdown);
  if (warningDetails.length > 0) {
    issues.push({
      kind: "note-unsupported",
      path: articlePath,
      message: "note非対応要素があります",
      details: warningDetails.map((warning) => `${warning.target}: ${warning.message}`),
    });
  }

  const missingImages = extractLocalImagePaths(markdown, articlePath).filter((imagePath) => !availableImages.has(imagePath));
  if (missingImages.length > 0) {
    issues.push({ kind: "missing-image", path: articlePath, message: "本文から参照されている画像が見つかりません", details: missingImages });
  }

  const placeholders = parseImagePlaceholders(markdown);
  const pendingPlaceholders = placeholders.filter((placeholder) => getImageTaskState(imageStatus, articlePath, placeholder.id).decision === "pending");
  if (pendingPlaceholders.length > 0) {
    issues.push({ kind: "image-pending", path: articlePath, message: "画像の判断が未決定です", details: pendingPlaceholders.map((placeholder) => placeholder.description) });
  }

  const incompleteRegistrations = placeholders.filter((placeholder) => {
    const task = getImageTaskState(imageStatus, articlePath, placeholder.id);
    return task.assetPath !== null && task.registrationStage !== "completed";
  });
  if (incompleteRegistrations.length > 0) {
    issues.push({ kind: "image-registration", path: articlePath, message: "画像登録が途中状態です", details: incompleteRegistrations.map((placeholder) => placeholder.description) });
  }

  if (placeholders.length > 0 && issues.every((issue) => issue.kind !== "image-pending" && issue.kind !== "image-registration")) {
    issues.push({ kind: "image-placeholder", path: articlePath, message: "画像プレースホルダーが残っています", details: placeholders.map((placeholder) => placeholder.description) });
  }
  return issues;
}
