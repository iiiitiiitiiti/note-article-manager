import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ARTICLE_DIRECTORIES = ["book-review", "design", "disney", "essay", "tools", "web-review"];
const NON_ARTICLE_FILENAMES = new Set(["README.md", "IDEAS.md"]);

export function discoverArticlePaths(repoRoot) {
  const paths = [];
  for (const directory of ARTICLE_DIRECTORIES) {
    const absoluteDirectory = join(repoRoot, directory);
    if (!existsSync(absoluteDirectory)) continue;
    walk(absoluteDirectory, (absoluteFile) => {
      if (!absoluteFile.endsWith(".md") || NON_ARTICLE_FILENAMES.has(basename(absoluteFile))) return;
      paths.push(toPosix(relative(repoRoot, absoluteFile)));
    });
  }
  return paths.sort((left, right) => left.localeCompare(right, "ja"));
}

export function parseDesignQueue(readme) {
  const queue = [];
  const seenOrders = new Set();
  const seenPaths = new Set();
  const pattern = /^(\d+)\.\s+.*?\((design\/[^)]+\.md)\)/;

  for (const line of readme.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) continue;
    const order = Number(match[1]);
    const path = match[2];
    if (seenOrders.has(order)) throw new Error(`design キューの番号が重複しています: ${order}`);
    if (seenPaths.has(path)) throw new Error(`design キューのパスが重複しています: ${path}`);
    seenOrders.add(order);
    seenPaths.add(path);
    queue.push({ order, path });
  }

  queue.sort((left, right) => left.order - right.order);
  for (let index = 0; index < queue.length; index += 1) {
    const expectedOrder = index + 1;
    if (queue[index].order !== expectedOrder) {
      throw new Error(`design キューに欠番があります: ${expectedOrder}`);
    }
    const filenameNumber = Number(basename(queue[index].path).match(/^(\d+)[_-]/)?.[1]);
    if (filenameNumber !== expectedOrder) {
      throw new Error(`design の番号と README の順序が一致しません: ${queue[index].path}`);
    }
  }
  return queue;
}

export function buildStatusDocument(repoRoot) {
  const articlePaths = discoverArticlePaths(repoRoot);
  const designPaths = articlePaths.filter((path) => path.startsWith("design/"));
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const queue = parseDesignQueue(readme);
  const queuePaths = new Set(queue.map((entry) => entry.path));

  if (queue.length !== designPaths.length || designPaths.some((path) => !queuePaths.has(path))) {
    const missing = designPaths.filter((path) => !queuePaths.has(path));
    const extra = queue.filter((entry) => !designPaths.includes(entry.path)).map((entry) => entry.path);
    throw new Error(`design の README キューと実ファイルが一致しません。missing=${missing.join(",")} extra=${extra.join(",")}`);
  }

  const articles = {};
  for (const path of articlePaths) {
    const queueEntry = queue.find((entry) => entry.path === path);
    articles[path] = {
      status: queueEntry ? "queued" : "unset",
      ...(queueEntry ? { queueOrder: queueEntry.order } : {}),
      publishedUrl: null,
      publishedAt: null,
    };
  }
  return { schemaVersion: 1, articles };
}

function walk(directory, callback) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) walk(absolutePath, callback);
    else if (entry.isFile()) callback(absolutePath);
  }
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function parseArgs(args) {
  const options = { repo: process.cwd(), output: "status.json", force: false };
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
  const output = options.output === "status.json" ? join(repoRoot, options.output) : options.output;
  if (existsSync(output) && !options.force) {
    throw new Error(`既存ファイルを上書きしません: ${output}（上書きする場合だけ --force を指定してください）`);
  }
  mkdirSync(dirname(output), { recursive: true });
  const document = buildStatusDocument(repoRoot);
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const count = Object.keys(document.articles).length;
  const queued = Object.values(document.articles).filter((entry) => entry.status === "queued").length;
  console.log(`status.json を生成しました: ${output}（記事 ${count} 件、design キュー ${queued} 件）`);
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
