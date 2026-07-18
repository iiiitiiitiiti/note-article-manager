const TOKEN_KEY = "note-article-manager:github-pat";
const ARTICLE_RETURN_PATH_KEY = "note-article-manager:article-return-path";

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
