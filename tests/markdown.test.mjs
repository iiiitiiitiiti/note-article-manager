import assert from "node:assert/strict";
import test from "node:test";
import { bodyForNote, getNoteWarningDetails, getNoteWarnings } from "../src/markdown.ts";

test("note body removes front matter and the article title", () => {
  const markdown = "---\ntags: [test]\n---\n# Title\n\n本文\n";

  assert.equal(bodyForNote(markdown), "本文");
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
    ["image", 7],
    ["html", 9],
  ]);
  assert.match(details[0].action, /手動対応/);
  assert.match(details[1].target, /photo\.png/);
  assert.equal(getNoteWarnings(markdown).length, 3);
});

test("ordinary note-compatible Markdown has no blocking warnings", () => {
  assert.deepEqual(getNoteWarningDetails("# Title\n\n## 見出し\n\n- 項目\n\n[リンク](https://example.com)\n\n<https://example.com>"), []);
});
