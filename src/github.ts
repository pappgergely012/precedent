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

    const res = await doFetch(`${API}/repos/${repo}/pulls/comments?${params}`, { headers });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} for ${repo}: ${await res.text()}`);
    }
    const items = z.array(ApiCommentSchema).parse(await res.json());

    for (const c of items) {
      if (!c.user || c.user.type === "Bot") continue;
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
      });
    }
    if (items.length < 100) break;
  }
  return comments;
}
