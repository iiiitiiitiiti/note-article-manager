import assert from "node:assert/strict";
import test from "node:test";
import { createGithubApiError, createGithubNetworkError, GithubApiError } from "../src/github-errors.ts";

test("401 is presented as an invalid or expired PAT with a settings action", () => {
  const error = createGithubApiError(401, "Bad credentials", undefined, "記事一覧");

  assert.ok(error instanceof GithubApiError);
  assert.equal(error.kind, "authentication");
  assert.equal(error.action, "settings");
  assert.equal(error.operation, "記事一覧");
  assert.match(error.reason, /PATが無効/);
  assert.match(error.nextStep, /設定を開き/);
});

test("403 with an exhausted limit includes the reset wait and retry action", () => {
  const reset = Math.ceil(Date.now() / 1000) + 120;
  const error = createGithubApiError(403, "API rate limit exceeded", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, "status.json");

  assert.equal(error.kind, "rate-limit");
  assert.equal(error.action, "retry");
  assert.match(error.reason, /利用上限/);
  assert.match(error.nextStep, /分ほど待って/);
});

test("429 is also presented as a rate-limit error", () => {
  const error = createGithubApiError(429, "Too Many Requests", { "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 30) }, "記事本文");

  assert.equal(error.kind, "rate-limit");
  assert.equal(error.action, "retry");
  assert.match(error.nextStep, /待ってから再試行/);
});

test("403 without rate limiting is presented as a permission problem", () => {
  const error = createGithubApiError(403, "Resource not accessible by personal access token", undefined, "画像");

  assert.equal(error.kind, "permission");
  assert.equal(error.action, "settings");
  assert.match(error.nextStep, /Contents read\/write/);
});

test("404 and 409 preserve the target and next operation", () => {
  const notFound = createGithubApiError(404, "Not Found", undefined, "記事本文");
  const conflict = createGithubApiError(409, "Conflict", undefined, "公開状況の保存");

  assert.equal(notFound.kind, "not-found");
  assert.equal(notFound.action, "none");
  assert.match(notFound.reason, /記事本文/);
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.action, "retry");
  assert.match(conflict.nextStep, /再読み込み/);
});

test("408 and 5xx are retryable temporary errors", () => {
  const timeout = createGithubApiError(408, "Request Timeout", undefined, "記事一覧");
  const serverError = createGithubApiError(503, "Service Unavailable", undefined, "画像");

  assert.equal(timeout.kind, "temporary");
  assert.equal(timeout.action, "retry");
  assert.equal(serverError.kind, "temporary");
  assert.match(serverError.nextStep, /再試行/);
});

test("network failures distinguish timeout and offline communication failures", () => {
  const timeout = createGithubNetworkError("記事一覧", Object.assign(new Error("aborted"), { name: "AbortError" }), false);
  const offline = createGithubNetworkError("画像", new TypeError("Failed to fetch"), true);

  assert.equal(timeout.kind, "timeout");
  assert.equal(timeout.action, "retry");
  assert.match(timeout.reason, /タイムアウト/);
  assert.equal(offline.kind, "offline");
  assert.match(offline.nextStep, /再接続/);
});
