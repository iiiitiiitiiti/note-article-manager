import assert from "node:assert/strict";
import test from "node:test";
import { GithubClient } from "../src/github.ts";

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
