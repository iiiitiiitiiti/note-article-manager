import DOMPurify from "dompurify";
import { marked } from "marked";
import { extractLocalImagePaths, parseImagePlaceholders, replaceLocalImageSources } from "./image-plan";
import type { ArticleContent } from "./types";

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
  const content = removeFrontMatter(markdown);
  const warnings: string[] = [];
  if (/^\s*\|.*\|\s*$/m.test(content) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(content)) {
    warnings.push("Markdown の表は note で変換されません。");
  }
  if (/!\[[^\]]*\]\([^)]*\)/.test(content)) {
    warnings.push("Markdown の画像は note で手動アップロードが必要です。");
  }
  if (/<\/?[A-Za-z][^>]*>/.test(content)) {
    warnings.push("raw HTML は note でそのまま変換されません。");
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
    renderedHtml,
    warnings: getNoteWarnings(markdown),
    imagePlaceholders: parseImagePlaceholders(markdown),
    localImagePaths: extractLocalImagePaths(markdown, filePath),
  };
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
