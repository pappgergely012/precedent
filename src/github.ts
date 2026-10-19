import { z } from "zod";

const API = "https://api.github.com";

const RETRYABLE = new Set([502, 503, 504]);

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * GET with retries for transient failures (502/503/504 and network errors), waiting
 * 1s, 2s, 4s... between attempts. Only for idempotent requests: never wrap a POST.
 */
export async function fetchWithRetry(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const { retries = 3, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await doFetch(url, init);
      if (!RETRYABLE.has(res.status) || attempt >= retries) return res;
    } catch (error) {
      if (attempt >= retries) throw error;
    }
    await sleep(1000 * 2 ** attempt);
  }
}

/** A failed GitHub API call, with a message that is safe to show a user as is. */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/** Turn a non-2xx response into a one-line, actionable error. */
export async function githubApiError(res: Response, target: string, action = "reading"): Promise<GitHubApiError> {
  const body = await res.text().catch(() => "");
  const detail = (() => {
    try {
      const message = (JSON.parse(body) as { message?: unknown }).message;
      return typeof message === "string" ? message : body.slice(0, 200);
    } catch {
      return body.slice(0, 200);
    }
  })();
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const resetAt = reset > 0 ? new Date(reset * 1000).toISOString().slice(11, 19) + " UTC" : undefined;

  if (res.status === 401) {
    return new GitHubApiError("GitHub rejected GITHUB_TOKEN (401): it is invalid or expired. Create a new token and try again.", 401);
  }
  if (res.status === 404) {
    return new GitHubApiError(
      `${target} not found (404). Check the name, or set GITHUB_TOKEN to a token with access if it is private.`,
      404,
    );
  }
  if (res.status === 429 || (res.status === 403 && (remaining === "0" || /rate limit/i.test(detail)))) {
    const hint = process.env.GITHUB_TOKEN ? "Wait for the limit to reset" : "Set GITHUB_TOKEN to raise the limit";
    return new GitHubApiError(
      `GitHub API rate limit reached (${res.status})${resetAt ? `; resets at ${resetAt}` : ""}. ${hint}.`,
      res.status,
    );
  }
  if (res.status === 403) {
    return new GitHubApiError(`GitHub denied ${action} ${target} (403): ${detail || "the token lacks permission"}.`, 403);
  }
  return new GitHubApiError(`GitHub API ${res.status} ${action} ${target}: ${detail}`, res.status);
}

/** A single pull request review comment, reduced to what rule mining needs. */
export interface ReviewComment {
  id: number;
  prNumber: number;
  reviewer: string;
  body: string;
  /** File the comment is attached to. */
  path: string;
  /** The diff hunk the comment refers to. */
  diffHunk: string;
  url: string;
  createdAt: string;
  /** Set when the comment is a reply in a thread. */
  inReplyTo?: number;
  /** True when the commenter is the author of the pull request (self-statements are not reviews). */
  byPullRequestAuthor?: boolean;
}

const ApiCommentSchema = z.object({
  id: z.number(),
  pull_request_url: z.string(),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
  body: z.string(),
  path: z.string(),
  diff_hunk: z.string(),
  html_url: z.string(),
  created_at: z.string(),
  in_reply_to_id: z.number().optional(),
  author_association: z.string().optional(),
});

export interface FetchOptions {
  token?: string;
  /** Stop after this many pages of 100 comments. */
  maxPages?: number;
  /**
   * Keep paging past `maxPages` (up to `hardMaxPages`) until this many top-level
   * (non-reply) comments are collected. Repos with heavy threaded replies
   * would otherwise yield too few comments to mine.
   */
  minTopLevel?: number;
  hardMaxPages?: number;
  /** Only comments created after this ISO timestamp. */
  since?: string;
  fetchImpl?: typeof fetch;
  /** Backoff between retries of transient failures; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Review bots often run as regular user accounts, so the account type alone is not enough. */
function isBot(user: { login: string; type: string }): boolean {
  return user.type === "Bot" || /bot(?:\])?$/i.test(user.login);
}

/**
 * Fetch review comments across all pull requests of a repository.
 * Bot comments are skipped, since rules should come from human decisions.
 */
export async function fetchReviewComments(
  repo: string,
  opts: FetchOptions = {},
): Promise<ReviewComment[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`Invalid repo "${repo}", expected "owner/name"`);
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? 10;
  const hardMaxPages = Math.max(maxPages, opts.hardMaxPages ?? 30);
  const minTopLevel = opts.minTopLevel ?? 300;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const comments: ReviewComment[] = [];
  let topLevel = 0;
  for (let page = 1; page <= hardMaxPages; page++) {
    if (page > maxPages && topLevel >= minTopLevel) break;
    const params = new URLSearchParams({
      per_page: "100",
      page: String(page),
      sort: "created",
      direction: "desc",
    });
    if (opts.since) params.set("since", opts.since);

    const res = await fetchWithRetry(doFetch, `${API}/repos/${repo}/pulls/comments?${params}`, { headers }, { sleep: opts.sleep });
    if (!res.ok) throw await githubApiError(res, `Repository ${repo}`);
    const items = z.array(ApiCommentSchema).parse(await res.json());

    for (const c of items) {
      if (!c.user || isBot(c.user)) continue;
      const prNumber = Number(c.pull_request_url.split("/").pop());
      if (c.in_reply_to_id === undefined) topLevel++;
      comments.push({
        id: c.id,
        prNumber,
        reviewer: c.user.login,
        body: c.body,
        path: c.path,
        diffHunk: c.diff_hunk,
        // Built from the requested repo: html_url can carry a stale or renamed owner.
        url: `https://github.com/${repo}/pull/${prNumber}#discussion_r${c.id}`,
        createdAt: c.created_at,
        inReplyTo: c.in_reply_to_id,
        byPullRequestAuthor: c.author_association === "AUTHOR",
      });
    }
    if (items.length < 100) break;
  }
  return comments;
}

export interface PullRequestOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

function checkRepo(repo: string): void {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`Invalid repo "${repo}", expected "owner/name"`);
  }
}

function apiHeaders(token: string | undefined, accept: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Fetch the unified diff of a pull request. */
export async function fetchPullDiff(repo: string, prNumber: number, opts: PullRequestOptions = {}): Promise<string> {
  checkRepo(repo);
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await fetchWithRetry(
    doFetch,
    `${API}/repos/${repo}/pulls/${prNumber}`,
    { headers: apiHeaders(opts.token, "application/vnd.github.diff") },
    { sleep: opts.sleep },
  );
  if (!res.ok) throw await githubApiError(res, `Pull request ${repo}#${prNumber}`);
  return res.text();
}

export interface ReviewCommentInput {
  path: string;
  line: number;
  body: string;
}

/** Post one pull request review with inline comments on the added lines. */
export async function postPullReview(
  repo: string,
  prNumber: number,
  body: string,
  comments: ReviewCommentInput[],
  opts: PullRequestOptions = {},
): Promise<string> {
  checkRepo(repo);
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${API}/repos/${repo}/pulls/${prNumber}/reviews`, {
    method: "POST",
    headers: { ...apiHeaders(opts.token, "application/vnd.github+json"), "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "COMMENT",
      body,
      comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
    }),
  });
  if (!res.ok) throw await githubApiError(res, `a review on ${repo}#${prNumber}`, "posting");
  return z.object({ html_url: z.string() }).parse(await res.json()).html_url;
}
