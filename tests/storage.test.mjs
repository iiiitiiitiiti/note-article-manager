import assert from "node:assert/strict";
import test from "node:test";
import { clearArticleReturnPath, clearToken, loadArticleReturnPath, loadNoteComposerArticle, loadToken, saveArticleReturnPath, saveNoteComposerArticle, saveToken } from "../src/storage.ts";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test("saved PAT and article return path remain available through the storage fallback", () => {
  const previousLocal = globalThis.localStorage;
  const previousSession = globalThis.sessionStorage;
  globalThis.localStorage = new MemoryStorage();
  globalThis.sessionStorage = new MemoryStorage();
  try {
    saveToken("  github_pat_test  ");
    saveArticleReturnPath("disney/01_one.md");
    saveNoteComposerArticle("disney/01_one.md");
    assert.equal(loadToken(), "github_pat_test");
    assert.equal(loadArticleReturnPath(), "disney/01_one.md");
    assert.equal(loadNoteComposerArticle(), "disney/01_one.md");
    clearArticleReturnPath();
    clearToken();
    assert.equal(loadToken(), "");
    assert.equal(loadArticleReturnPath(), "");
  } finally {
    globalThis.localStorage = previousLocal;
    globalThis.sessionStorage = previousSession;
  }
});
