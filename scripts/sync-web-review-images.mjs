import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { discoverArticlePaths } from "./init-status.mjs";
import { parseImagePlaceholders } from "./init-image-status.mjs";

const IMAGE_FILE_PATTERN = /\.(?:png|jpe?g|webp|gif)$/i;
const NUMBER_PREFIX_PATTERN = /^(\d+)[_-]/;

export function syncWebReviewImages(repoRoot, now = new Date().toISOString()) {
  const imageStatusPath = join(repoRoot, "image-status.json");
  const previousDocument = existsSync(imageStatusPath)
    ? JSON.parse(readFileSync(imageStatusPath, "utf8"))
    : { schemaVersion: 1, articles: {} };
  const document = structuredClone(previousDocument);
  document.schemaVersion = 1;
  document.articles ??= {};
  const changedArticles = [];
  const warnings = [];

  for (const articlePath of discoverArticlePaths(repoRoot).filter((path) => path.startsWith("web-review/"))) {
    const articleAbsolutePath = join(repoRoot, articlePath);
    const markdown = readFileSync(articleAbsolutePath, "utf8");
    const placeholders = parseImagePlaceholders(markdown);
    if (placeholders.length === 0) continue;

    const slug = basename(articlePath, ".md");
    const imageDirectory = join(repoRoot, "web-review", "images", slug);
    const imageFiles = getNumberedImageFiles(imageDirectory);
    if (!existsSync(imageDirectory) || imageFiles.length === 0) continue;

    const previousTasks = previousDocument.articles?.[articlePath]?.tasks ?? {};
    const requiredOrders = placeholders
      .map((placeholder, index) => ({ placeholder, order: index + 1 }))
      .filter(({ placeholder }) => !["skip", "generate"].includes(previousTasks[placeholder.id]?.decision))
      .map(({ order }) => order);
    const validation = validateNumberedImageFiles(imageFiles, requiredOrders);
    if (!validation.ok) {
      warnings.push(`${articlePath}: ${validation.message}`);
      continue;
    }

    const tasks = { ...previousTasks };
    const replacements = [];
    for (let index = 0; index < placeholders.length; index += 1) {
      const placeholder = placeholders[index];
      const previousTask = previousTasks[placeholder.id];
      if (previousTask?.decision === "skip" || previousTask?.decision === "generate") continue;

      const imageFile = previousTask?.assetPath
        ? imageFiles.find((file) => toPosix(relative(repoRoot, join(imageDirectory, file.name))) === previousTask.assetPath)
        : imageFiles.find((file) => file.order === index + 1);
      if (!imageFile) continue;

      const articleImagePath = toPosix(relative(dirname(articleAbsolutePath), join(imageDirectory, imageFile.name)));
      replacements.push({
        start: placeholder.start,
        end: placeholder.end,
        value: `![${placeholder.description}](${articleImagePath})`,
      });
      tasks[placeholder.id] = {
        ...(previousTask ?? {}),
        decision: "provide",
        assetPath: toPosix(relative(repoRoot, join(imageDirectory, imageFile.name))),
        registrationStage: "completed",
        updatedAt: now,
      };
    }

    if (replacements.length === 0) continue;
    replacements.sort((left, right) => right.start - left.start);
    let updatedMarkdown = markdown;
    for (const replacement of replacements) {
      updatedMarkdown = `${updatedMarkdown.slice(0, replacement.start)}${replacement.value}${updatedMarkdown.slice(replacement.end)}`;
    }
    writeFileSync(articleAbsolutePath, updatedMarkdown, "utf8");
    document.articles[articlePath] = { ...(document.articles[articlePath] ?? {}), tasks };
    changedArticles.push(articlePath);
  }

  const previousJson = JSON.stringify(previousDocument, null, 2);
  const nextJson = JSON.stringify(document, null, 2);
  if (previousJson !== nextJson) writeFileSync(imageStatusPath, `${nextJson}\n`, "utf8");
  return { changedArticles, warnings, changedImageStatus: previousJson !== nextJson };
}

function getNumberedImageFiles(imageDirectory) {
  if (!existsSync(imageDirectory)) return [];
  return readdirSync(imageDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_FILE_PATTERN.test(entry.name))
    .map((entry) => {
      const match = entry.name.match(NUMBER_PREFIX_PATTERN);
      return { name: entry.name, order: match ? Number(match[1]) : undefined };
    })
    .filter((file) => file.order !== undefined)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name, "en"));
}

function validateNumberedImageFiles(imageFiles, requiredOrders) {
  const seenOrders = new Set();
  for (const file of imageFiles) {
    if (seenOrders.has(file.order)) {
      return { ok: false, message: `画像番号 ${file.order} が重複しているため自動反映をスキップしました。` };
    }
    seenOrders.add(file.order);
  }
  for (const order of requiredOrders) {
    if (!seenOrders.has(order)) {
      return { ok: false, message: `画像番号 ${String(order).padStart(2, "0")} がないため自動反映をスキップしました。` };
    }
  }
  return { ok: true };
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function parseArgs(args) {
  const options = { repo: process.cwd() };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--repo") options.repo = resolve(args[++index]);
    else throw new Error(`不明な引数です: ${argument}`);
  }
  return options;
}

function main() {
  const { repo } = parseArgs(process.argv.slice(2));
  const result = syncWebReviewImages(resolve(repo));
  if (result.changedArticles.length === 0) console.log("自動反映する web-review 画像はありません。");
  else console.log(`web-review 画像を自動反映しました: ${result.changedArticles.join(", ")}`);
  for (const warning of result.warnings) console.warn(`警告: ${warning}`);
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
