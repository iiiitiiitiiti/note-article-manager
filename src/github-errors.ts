export type GithubErrorKind =
  | "authentication"
  | "permission"
  | "rate-limit"
  | "not-found"
  | "conflict"
  | "temporary"
  | "offline"
  | "timeout"
  | "unexpected";

export type GithubErrorAction = "retry" | "settings" | "none";

export type GithubResponseHeaders = {
  get(name: string): string | null;
} | Record<string, string | undefined>;

export class GithubApiError extends Error {
  public readonly kind: GithubErrorKind;
  public readonly action: GithubErrorAction;
  public readonly operation: string;
  public readonly reason: string;
  public readonly nextStep: string;
  public readonly status?: number;

  public constructor(options: {
    kind: GithubErrorKind;
    action: GithubErrorAction;
    operation: string;
    reason: string;
    nextStep: string;
    status?: number;
  }) {
    super(`${options.reason} 次の操作: ${options.nextStep}`);
    this.name = "GithubApiError";
    this.kind = options.kind;
    this.action = options.action;
    this.operation = options.operation;
    this.reason = options.reason;
    this.nextStep = options.nextStep;
    this.status = options.status;
  }
}

export function createGithubApiError(
  status: number,
  apiMessage: string,
  headers: GithubResponseHeaders | undefined,
  operation: string,
): GithubApiError {
  if (status === 401) {
    return new GithubApiError({
      kind: "authentication",
      action: "settings",
      operation,
      status,
      reason: `${operation}に失敗しました。PATが無効か、期限切れです。`,
      nextStep: "設定を開き、Contents の read/write 権限を持つPATを入力してください。",
    });
  }

  if (status === 429 || (status === 403 && isRateLimited(headers, apiMessage))) {
    return new GithubApiError({
      kind: "rate-limit",
      action: "retry",
      operation,
      status,
      reason: `${operation}に失敗しました。GitHub APIの利用上限に達しました。`,
      nextStep: rateLimitNextStep(headers),
    });
  }

  if (status === 403) {
    return new GithubApiError({
      kind: "permission",
      action: "settings",
      operation,
      status,
      reason: `${operation}に失敗しました。PATに必要なGitHubへのアクセス権がありません。`,
      nextStep: "設定を開き、対象リポジトリの Contents read/write 権限を持つPATに変更してください。",
    });
  }

  if (status === 404) {
    return new GithubApiError({
      kind: "not-found",
      action: "none",
      operation,
      status,
      reason: `${operation}が見つかりません。`,
      nextStep: "リポジトリ名、対象ファイル、ブランチを確認してください。",
    });
  }

  if (status === 409) {
    return new GithubApiError({
      kind: "conflict",
      action: "retry",
      operation,
      status,
      reason: `${operation}が別端末の更新と競合しました。`,
      nextStep: "再読み込みして最新状態を取得してから、もう一度実行してください。",
    });
  }

  if (status === 408 || status === 429 || status >= 500) {
    return new GithubApiError({
      kind: "temporary",
      action: "retry",
      operation,
      status,
      reason: `${operation}でGitHubの一時的なエラーが発生しました。`,
      nextStep: "しばらく待ってから再試行してください。",
    });
  }

  const detail = apiMessage && apiMessage !== "API エラー" ? ` ${apiMessage}` : "";
  return new GithubApiError({
    kind: "unexpected",
    action: "retry",
    operation,
    status,
    reason: `${operation}に失敗しました。${detail}${status ? `（HTTP ${status}）` : ""}`,
    nextStep: "内容を確認してから、再試行してください。",
  });
}

export function createGithubNetworkError(operation: string, cause: unknown, offline: boolean): GithubApiError {
  const isTimeout = cause instanceof Error && cause.name === "AbortError";
  if (isTimeout) {
    return new GithubApiError({
      kind: "timeout",
      action: "retry",
      operation,
      reason: `${operation}がタイムアウトしました。`,
      nextStep: "通信状態を確認してから、再試行してください。",
    });
  }
  if (offline) {
    return new GithubApiError({
      kind: "offline",
      action: "retry",
      operation,
      reason: `${operation}に接続できません。オフラインになっています。`,
      nextStep: "通信を再接続してから、再試行してください。",
    });
  }
  return new GithubApiError({
    kind: "offline",
    action: "retry",
    operation,
    reason: `${operation}に接続できません。通信が不安定か、GitHubに到達できません。`,
    nextStep: "通信状態を確認してから、再試行してください。",
  });
}

function isRateLimited(headers: GithubResponseHeaders | undefined, apiMessage: string): boolean {
  return readHeader(headers, "x-ratelimit-remaining") === "0"
    || /rate limit|api rate limit|secondary rate limit/i.test(apiMessage);
}

function rateLimitNextStep(headers: GithubResponseHeaders | undefined): string {
  const resetSeconds = Number(readHeader(headers, "x-ratelimit-reset"));
  if (Number.isFinite(resetSeconds) && resetSeconds > Date.now() / 1000) {
    const waitSeconds = Math.ceil(resetSeconds - Date.now() / 1000);
    const wait = waitSeconds >= 60 ? `${Math.ceil(waitSeconds / 60)}分ほど` : `${waitSeconds}秒ほど`;
    return `${wait}待ってから再試行してください。`;
  }
  return "しばらく待ってから再試行してください。";
}

function readHeader(headers: GithubResponseHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}
