const TOKEN_KEY = "note-article-manager:github-pat";
const ARTICLE_RETURN_PATH_KEY = "note-article-manager:article-return-path";
const NOTE_COMPOSER_ARTICLE_KEY = "note-article-manager:note-composer-article";
const PUBLICATION_SCHEDULE_KEY = "note-article-manager:publication-schedule";

export function loadToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function saveArticleReturnPath(path: string): void {
  try {
    sessionStorage.setItem(ARTICLE_RETURN_PATH_KEY, path);
  } catch {
    // sessionStorage is optional; the browser history still handles the return path.
  }
}

export function loadArticleReturnPath(): string {
  try {
    return sessionStorage.getItem(ARTICLE_RETURN_PATH_KEY) ?? "";
  } catch {
    return "";
  }
}

export function clearArticleReturnPath(): void {
  try {
    sessionStorage.removeItem(ARTICLE_RETURN_PATH_KEY);
  } catch {
    // sessionStorage is optional.
  }
}

export function saveNoteComposerArticle(path: string): void {
  try {
    sessionStorage.setItem(NOTE_COMPOSER_ARTICLE_KEY, path);
  } catch {
    // sessionStorage is optional.
  }
}

export function loadNoteComposerArticle(): string {
  try {
    return sessionStorage.getItem(NOTE_COMPOSER_ARTICLE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function loadPublicationSchedule<T extends object>(fallback: T): T {
  try {
    const value = localStorage.getItem(PUBLICATION_SCHEDULE_KEY);
    if (!value) return fallback;
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? { ...fallback, ...parsed } as T : fallback;
  } catch {
    return fallback;
  }
}

export function savePublicationSchedule(value: object): void {
  localStorage.setItem(PUBLICATION_SCHEDULE_KEY, JSON.stringify(value));
}
