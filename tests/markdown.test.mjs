import assert from "node:assert/strict";
import test from "node:test";
import { bodyForNote, getNoteWarningDetails, getNoteWarnings, hasBlockingNoteWarnings, noteClipboardDocument, noteClipboardHtml } from "../src/markdown.ts";

test("note body removes front matter and the article title", () => {
  const markdown = "---\ntags: [test]\n---\n# Title\n\n本文\n";

  assert.equal(bodyForNote(markdown), "本文");
});

test("note body uses placeholders when an image cannot be embedded", () => {
  const markdown = "# Title\n\n本文\n\n![見出し画像](images/cover.png)\n\n![](images/empty.png)";

  assert.equal(bodyForNote(markdown), "本文\n\n【画像：見出し画像】\n\n【画像：画像】");
});

test("note clipboard HTML embeds available images and preserves text structure", () => {
  const markdown = "# Title\n\n本文\n\n## 見出し\n\n![見出し画像](images/cover.png)";
  const html = noteClipboardHtml(markdown, "design/article.md", {
    "design/images/cover.png": "data:image/png;base64,AA==",
  });

  assert.match(html, /<p>本文<\/p>/);
  assert.match(html, /<h2>見出し<\/h2>/);
  assert.match(html, /<img src="data:image\/png;base64,AA==" alt="見出し画像">/);

  const document = noteClipboardDocument(html);
  assert.match(document, /^<!doctype html>/i);
  assert.match(document, /<!--StartFragment-->/);
  assert.match(document, /<h2>見出し<\/h2>/);
  assert.match(document, /<img src="data:image\/png;base64,AA==" alt="見出し画像">/);
});

test("unsupported note elements include line and target information", () => {
  const markdown = [
    "# Title",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "![写真](images/photo.png)",
    "",
    "<aside>補足</aside>",
  ].join("\n");

  const details = getNoteWarningDetails(markdown);
  assert.deepEqual(details.map((warning) => [warning.kind, warning.line]), [
    ["table", 3],
    ["html", 9],
  ]);
  assert.match(details[0].action, /手動対応/);
  assert.equal(details.some((warning) => warning.kind === "image"), false);
  assert.equal(getNoteWarnings(markdown).length, 2);
  assert.equal(hasBlockingNoteWarnings(details), true);
});

test("ordinary note-compatible Markdown has no blocking warnings", () => {
  assert.deepEqual(getNoteWarningDetails("# Title\n\n## 見出し\n\n- 項目\n\n[リンク](https://example.com)\n\n<https://example.com>"), []);
});
