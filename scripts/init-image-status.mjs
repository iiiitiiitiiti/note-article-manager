import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverArticlePaths } from "./init-status.mjs";

const PLACEHOLDER_PATTERN = /^[ \t]*【画像[^】]*】[ \t]*$/gm;

export function parseImagePlaceholders(markdown) {
  const occurrences = new Map();
  const placeholders = [];
  for (const match of markdown.matchAll(PLACEHOLDER_PATTERN)) {
    const inside = match[0].trim().slice(1, -1);
    const description = inside
      .replace(/^画像(?:プレースホルダー(?:（任意）)?|[0-9０-９①-㊿]+)?\s*(?:[:：])?\s*/, "")
      .trim() || inside;
    const occurrence = occurrences.get(description) ?? 0;
    occurrences.set(description, occurrence + 1);
    placeholders.push({ id: createImageTaskId(description, occurrence), description });
  }
  return placeholders;
}

export function createImageTaskId(description, occurrence) {
  let hash = 2166136261;
  for (const character of description) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `image-${(hash >>> 0).toString(16).padStart(8, "0")}-${occurrence + 1}`;
}

export function buildImageStatusDocument(repoRoot, previousDocument = null) {
  const articles = {};
  for (const path of discoverArticlePaths(repoRoot)) {
    const previousTasks = previousDocument?.articles?.[path]?.tasks ?? {};
    const tasks = { ...previousTasks };
    const markdown = readFileSync(join(repoRoot, path), "utf8");
    for (const placeholder of parseImagePlaceholders(markdown)) {
      const previous = previousTasks[placeholder.id];
      tasks[placeholder.id] = previous ?? { decision: "pending", assetPath: null, updatedAt: null };
    }
    if (Object.keys(tasks).length > 0) articles[path] = { tasks };
  }
  return { schemaVersion: 1, articles };
}

function parseArgs(args) {
  const options = { repo: process.cwd(), output: "image-status.json", force: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repo") options.repo = resolve(args[++index]);
    else if (argument === "--output") options.output = resolve(args[++index]);
    else if (argument === "--force") options.force = true;
    else throw new Error(`不明な引数です: ${argument}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(options.repo);
  const output = options.output === "image-status.json" ? join(repoRoot, options.output) : options.output;
  if (existsSync(output) && !options.force) {
    throw new Error(`既存ファイルを上書きしません: ${output}（上書きする場合だけ --force を指定してください）`);
  }
  mkdirSync(dirname(output), { recursive: true });
  const previousDocument = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : null;
  const document = buildImageStatusDocument(repoRoot, previousDocument);
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const taskCount = Object.values(document.articles).reduce((sum, article) => sum + Object.keys(article.tasks).length, 0);
  console.log(`image-status.json を生成しました: ${output}（記事 ${Object.keys(document.articles).length} 件、画像タスク ${taskCount} 件）`);
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedAsScript) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
