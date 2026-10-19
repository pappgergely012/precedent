import { z } from "zod";
import { fetchWithRetry } from "./github.js";
import type { Rule } from "./rule.js";

const API = "https://api.github.com";

const CommentSchema = z.object({
  user: z.object({ login: z.string() }).nullable(),
  pull_request_url: z.string(),
});

export interface VerifyOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Same thresholds as extraction: a rule must keep this many verified sources / distinct PRs. */
  minOccurrences?: number;
  minPullRequests?: number;
}

/** Comment id from a `...#discussion_r<id>` url. */
export function commentIdFromUrl(url: string): number | undefined {
  const m = /#discussion_r(\d+)$/.exec(url);
  return m ? Number(m[1]) : undefined;
}

/**
 * Self-check: re-fetch every cited comment and keep only sources that exist, were written
 * by the cited reviewer and belong to the cited pull request. Rules that no longer meet
 * the extraction thresholds are dropped. Network errors count as unverified.
 */
export async function verifyRules(repo: string, rules: Rule[], opts: VerifyOptions = {}): Promise<Rule[]> {
  const { minOccurrences = 2, minPullRequests = 2 } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const cache = new Map<number, Promise<z.infer<typeof CommentSchema> | undefined>>();
  const lookup = (id: number) => {
    let hit = cache.get(id);
    if (!hit) {
      hit = fetchWithRetry(doFetch, `${API}/repos/${repo}/pulls/comments/${id}`, { headers }, { sleep: opts.sleep })
        .then(async (res) => (res.ok ? CommentSchema.parse(await res.json()) : undefined))
        .catch(() => undefined);
      cache.set(id, hit);
    }
    return hit;
  };

  const verified: Rule[] = [];
  for (const rule of rules) {
    const checks = await Promise.all(
      rule.sources.map(async (s) => {
        const id = commentIdFromUrl(s.commentUrl);
        const c = id === undefined ? undefined : await lookup(id);
        return !!c && c.user?.login === s.reviewer && c.pull_request_url.endsWith(`/${s.prNumber}`);
      }),
    );
    const sources = rule.sources.filter((_, i) => checks[i]);
    const prs = new Set(sources.map((s) => s.prNumber)).size;
    if (sources.length < minOccurrences || prs < minPullRequests) continue;
    verified.push({ ...rule, sources, confidence: Math.min(rule.confidence, prs / 5) });
  }
  return verified;
}
