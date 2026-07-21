import assert from "node:assert/strict";
import test from "node:test";
import { GithubClient } from "../src/github.ts";
import { GithubApiError } from "../src/github-errors.ts";

const articlePath = "design/01_one.md";

test("snapshot checks use ETags and report 304 responses as unchanged", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const status = {
    schemaVersion: 1,
    articles: { [articlePath]: { status: "queued", queueOrder: 1, publishedUrl: null, publishedAt: null } },
  };
  const tree = (paths) => ({ tree: paths.map((path) => ({ type: "blob", path })) });
  const contents = (value) => ({ content: Buffer.from(JSON.stringify(value)).toString("base64"), encoding: "base64", sha: "status-sha" });
  const response = (statusCode, body, headers = {}) => new Response(statusCode === 304 ? null : JSON.stringify(body), { status: statusCode, headers });

  globalThis.fetch = async (url, init = {}) => {
    const index = calls.length;
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    if (index === 0) return response(200, tree([articlePath]), { ETag: '"tree-1"' });
    if (index === 1) return response(200, contents(status), { ETag: '"status-1"' });
    if (index === 2) return response(404, { message: "Not Found" });
    if (index === 3) return response(304, null, { ETag: '"tree-1"' });
    if (index === 4) return response(304, null, { ETag: '"status-1"' });
    if (index === 5) return response(404, { message: "Not Found" });
    if (index === 6) return response(200, tree([articlePath, "design/02_two.md"]), { ETag: '"tree-2"' });
    if (index === 7) return response(304, null, { ETag: '"status-1"' });
    if (index === 8) return response(404, { message: "Not Found" });
    throw new Error(`unexpected request ${index}`);
  };

  try {
    const client = new GithubClient("test-token");
    const first = await client.checkForUpdates();
    const second = await client.checkForUpdates();
    const third = await client.checkForUpdates();

    assert.equal(first.changed, true);
    assert.equal(first.snapshot.articles.length, 1);
    assert.equal(second.changed, false);
    assert.equal(third.changed, true);
    assert.deepEqual(third.snapshot.missingStatusPaths, ["design/02_two.md"]);
    assert.equal(calls[3].headers.get("if-none-match"), '"tree-1"');
    assert.equal(calls[4].headers.get("if-none-match"), '"status-1"');
    assert.equal(calls[5].headers.get("if-none-match"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(statusCode, body, headers = {}) {
  return new Response(JSON.stringify(body), { status: statusCode, headers });
}

function contentsResponse(value, sha = "file-sha") {
  return { content: Buffer.from(value).toString("base64"), encoding: "base64", sha };
}

test("saved PAT connection test verifies read access and repository write permission", async () => {
  const originalFetch = globalThis.fetch;
  const status = JSON.stringify({ schemaVersion: 1, articles: {} });
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return jsonResponse(200, contentsResponse(status, "status-sha"));
    return jsonResponse(200, { full_name: "iiiitiiitiiti/note-articles", permissions: { push: true } });
  };

  try {
    const result = await new GithubClient("test-token").testConnection();
    assert.deepEqual(result, { repository: "iiiitiiitiiti/note-articles", readAccess: "available", writeAccess: "available" });
    assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer test-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publication notification config is saved with the schedule and push subscription", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return jsonResponse(404, { message: "Not Found" });
    return jsonResponse(201, { content: {}, sha: "notification-sha" });
  };

  try {
    await new GithubClient("test-token").saveNotificationConfig(
      { startAt: "2026-07-20T09:00", intervalDays: 7, category: "design", notificationTime: "09:00" },
      { endpoint: "https://example.test/push", expirationTime: null, keys: { auth: "auth", p256dh: "p256dh" } },
      "public-key",
    );
    const saved = JSON.parse(calls[1].init.body);
    const document = JSON.parse(Buffer.from(saved.content, "base64").toString("utf8"));
    assert.match(calls[1].url, /notification-config\.json/);
    assert.equal(document.vapidPublicKey, "public-key");
    assert.equal(document.schedule.startAt, "2026-07-20T09:00");
    assert.equal(document.subscriptions[0].endpoint, "https://example.test/push");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GitHub API status failures retain actionable classifications without exposing the token", async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    [401, "authentication"],
    [403, "permission"],
    [404, "not-found"],
    [503, "temporary"],
  ];
  try {
    for (const [statusCode, kind] of cases) {
      globalThis.fetch = async () => jsonResponse(statusCode, { message: "failure" });
      await assert.rejects(
        () => new GithubClient("secret-token").getArticle(articlePath),
        (error) => {
          assert.ok(error instanceof GithubApiError);
          assert.equal(error.kind, kind);
          assert.doesNotMatch(error.message, /secret-token/);
          return true;
        },
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image upload includes the existing SHA and retries a 409 conflict", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return jsonResponse(200, { sha: "old-sha" });
    if (calls.length === 2) return jsonResponse(409, { message: "Conflict" });
    if (calls.length === 3) return jsonResponse(404, { message: "Not Found" });
    return jsonResponse(201, { sha: "new-sha" });
  };

  try {
    await new GithubClient("test-token").uploadImage("design/images/example.png", new Uint8Array([1, 2, 3]));
    const firstPut = JSON.parse(calls[1].init.body);
    const secondPut = JSON.parse(calls[3].init.body);
    assert.equal(firstPut.sha, "old-sha");
    assert.equal(secondPut.sha, undefined);
    assert.equal(firstPut.content, "AQID");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image preview keeps binary content as base64 instead of decoding it as UTF-8", async () => {
  const originalFetch = globalThis.fetch;
  const binaryImage = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 255, 0]);
  const encodedImage = Buffer.from(binaryImage).toString("base64");
  globalThis.fetch = async () => jsonResponse(200, { content: encodedImage, encoding: "base64", sha: "image-sha" });

  try {
    assert.equal(await new GithubClient("test-token").getImageDataUrl("design/images/example.png"), `data:image/png;base64,${encodedImage}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image preview falls back to the blob API when contents omits base64 for files over 1MB", async () => {
  const originalFetch = globalThis.fetch;
  const binaryImage = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 255, 0]);
  const encodedImage = Buffer.from(binaryImage).toString("base64");
  const calls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("/contents/")) return jsonResponse(200, { content: "", encoding: "none", sha: "large-sha", size: 1_500_000 });
    if (value.endsWith("/git/blobs/large-sha")) return jsonResponse(200, { content: encodedImage, encoding: "base64", sha: "large-sha", size: 1_500_000 });
    throw new Error(`unexpected request ${value}`);
  };

  try {
    assert.equal(await new GithubClient("test-token").getImageDataUrl("design/images/large.png"), `data:image/png;base64,${encodedImage}`);
    assert.ok(calls.some((value) => value.endsWith("/git/blobs/large-sha")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image preview rejects files over the size limit without fetching the blob", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse(200, { content: "", encoding: "none", sha: "huge-sha", size: 6 * 1024 * 1024 });
  };

  try {
    await assert.rejects(() => new GithubClient("test-token").getImageDataUrl("design/images/huge.png"), /大きすぎるためプレビューできません/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image inventory distinguishes unreferenced files, broken links, and status-only paths", async () => {
  const originalFetch = globalThis.fetch;
  const article = "# One\n\n![broken](images/missing.png)\n";
  const imageStatus = JSON.stringify({ schemaVersion: 1, articles: { [articlePath]: { tasks: { stale: { decision: "provide", assetPath: "design/images/status-only.png", registrationStage: "completed", updatedAt: null } } } } });
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/git/trees/")) return jsonResponse(200, { tree: [
      { type: "blob", path: articlePath, sha: "article-sha" },
      { type: "blob", path: "design/images/orphan.png", sha: "orphan-sha" },
    ] });
    if (value.endsWith("/contents/image-status.json?ref=main")) return jsonResponse(200, contentsResponse(imageStatus, "image-status-sha"));
    if (value.includes(`/contents/${articlePath}?ref=main`)) return jsonResponse(200, contentsResponse(article, "article-sha"));
    throw new Error(`unexpected request ${value}`);
  };

  try {
    const inventory = await new GithubClient("test-token").getImageInventory();
    assert.deepEqual(inventory.issues.map((issue) => [issue.kind, issue.path]), [
      ["broken-reference", "design/images/missing.png"],
      ["status-only", "design/images/status-only.png"],
      ["unreferenced", "design/images/orphan.png"],
    ]);
    assert.equal(inventory.issues.find((issue) => issue.path === "design/images/orphan.png").sha, "orphan-sha");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
