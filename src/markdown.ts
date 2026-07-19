import DOMPurify from "dompurify";
import { marked } from "marked";
import { extractLocalImagePaths, parseImagePlaceholders, replaceLocalImageSources } from "./image-plan";
import type { ArticleContent, NoteWarning, NoteWarningKind } from "./types";

const FRONT_MATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n/;
const ALLOWED_TAGS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
  "img", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
];
const ALLOWED_ATTR = ["alt", "href", "rel", "src", "target", "title"];

export function removeFrontMatter(markdown: string): string {
  return markdown.replace(FRONT_MATTER, "");
}

export function extractTitle(markdown: string, filePath: string): string {
  const content = removeFrontMatter(markdown).replace(/^\s+/, "");
  const tokens = marked.lexer(content);
  const heading = tokens.find((token) => token.type === "heading" && token.depth === 1);
  if (heading && "text" in heading) {
    return stripInlineMarkdown(heading.text).trim() || filenameTitle(filePath);
  }

  const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
  return firstLine ? stripInlineMarkdown(firstLine) : filenameTitle(filePath);
}

export function bodyForNote(markdown: string): string {
  let body = removeFrontMatter(markdown).replace(/^\s+/, "");
  if (/^#\s+/.test(body)) {
    body = body.replace(/^#\s+[^\r\n]*(?:\r?\n|$)/, "");
  } else if (/^.+\r?\n=+\r?\n/.test(body)) {
    body = body.replace(/^.+\r?\n=+\r?\n/, "");
  } else {
    body = body.replace(/^[^\r\n]*(?:\r?\n|$)/, "");
  }
  return body.replace(/^\s+/, "").trimEnd();
}

export function getNoteWarnings(markdown: string): string[] {
  return getNoteWarningDetails(markdown).map((warning) => `${warning.message}（${warning.target}）`);
}

export function getNoteWarningDetails(markdown: string): NoteWarning[] {
  const content = removeFrontMatter(markdown);
  const warnings: NoteWarning[] = [];
  const htmlWarningLines = new Set<number>();
  const lines = content.split(/\r?\n/);
  const addWarning = (kind: NoteWarningKind, line: number, target: string, message: string, action: string) => {
    warnings.push({ kind, line, target, message, action });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine)) {
      addWarning(
        "table",
        index + 1,
        `表（${index + 1}行目）`,
        "Markdown の表は note で自動変換されません。",
        "手動対応: note側で表を作り直すか、表を本文から除外してください。",
      );
    }
  }
  for (const match of content.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g)) {
    const line = lineNumberAt(content, match.index ?? 0);
    addWarning(
      "image",
      line,
      `画像「${match[2]}」（${line}行目）`,
      "Markdown の画像は note で自動アップロードされません。",
      "手動対応: note側で画像をアップロードし、画像準備の登録内容と照合してください。",
    );
  }
  for (const match of content.matchAll(/<\/?(?!(?:https?:\/\/|mailto:))[A-Za-z][^>]*>/gi)) {
    const line = lineNumberAt(content, match.index ?? 0);
    if (htmlWarningLines.has(line)) continue;
    htmlWarningLines.add(line);
    addWarning(
      "html",
      line,
      `HTML「${match[0]}」（${line}行目）`,
      "raw HTML は note でそのまま自動変換されません。",
      "手動対応: HTMLをnote対応の文章・Markdownへ置き換えてください。",
    );
  }
  return warnings;
}

export function renderArticle(markdown: string, filePath: string, imageSources: Record<string, string> = {}): ArticleContent {
  const title = extractTitle(markdown, filePath);
  const body = bodyForNote(markdown);
  const renderedMarkdown = replaceLocalImageSources(markdown, filePath, imageSources);
  const renderer = new marked.Renderer();
  renderer.html = () => "";
  const rawHtml = marked.parse(removeFrontMatter(renderedMarkdown), { renderer, gfm: true, async: false }) as string;
  const renderedHtml = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_ATTR: ["style", "onerror", "onclick"],
  });

  return {
    path: filePath,
    title,
    body,
    sourceMarkdown: markdown,
    renderedHtml,
    warnings: getNoteWarnings(markdown),
    warningDetails: getNoteWarningDetails(markdown),
    imagePlaceholders: parseImagePlaceholders(markdown),
    localImagePaths: extractLocalImagePaths(markdown, filePath),
  };
}

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, offset).split(/\r?\n/).length;
}

function filenameTitle(filePath: string): string {
  const filename = filePath.split("/").at(-1)?.replace(/\.md$/i, "") ?? filePath;
  return filename.replace(/^\d+[_-]?/, "").replace(/[_-]+/g, " ").trim() || "無題の記事";
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}
