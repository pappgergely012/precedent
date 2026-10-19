import { z } from "zod";

const API = "https://api.github.com";

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
});

export interface FetchOptions {
  token?: string;
  /** Stop after this many pages of 100 comments. */
  maxPages?: number;
  /** Only comments created after this ISO timestamp. */
  since?: string;
  fetchImpl?: typeof fetch;
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
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const comments: ReviewComment[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      per_page: "100",
      page: String(page),
      sort: "created",
      direction: "desc",
    });
    if (opts.since) params.set("since", opts.since);

    const res = await doFetch(`${API}/repos/${repo}/pulls/comments?${params}`, { headers });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} for ${repo}: ${await res.text()}`);
    }
    const items = z.array(ApiCommentSchema).parse(await res.json());

    for (const c of items) {
      if (!c.user || c.user.type === "Bot") continue;
      comments.push({
        id: c.id,
        prNumber: Number(c.pull_request_url.split("/").pop()),
        reviewer: c.user.login,
        body: c.body,
        path: c.path,
        diffHunk: c.diff_hunk,
        url: c.html_url,
        createdAt: c.created_at,
        inReplyTo: c.in_reply_to_id,
      });
    }
    if (items.length < 100) break;
  }
  return comments;
}

export interface PullRequestOptions {
  token?: string;
  fetchImpl?: typeof fetch;
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
  const res = await doFetch(`${API}/repos/${repo}/pulls/${prNumber}`, {
    headers: apiHeaders(opts.token, "application/vnd.github.diff"),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo}#${prNumber}: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`GitHub API ${res.status} posting review to ${repo}#${prNumber}: ${await res.text()}`);
  return z.object({ html_url: z.string() }).parse(await res.json()).html_url;
}
