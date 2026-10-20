import type { ReviewComment } from "./github.js";

/**
 * A model-free check of whether a repository has enough inline review history for the tool to find
 * recurring rules. The thresholds are the tester's market-survey proxy (internal ops/reports/market-survey,
 * declared before the survey ran). It is a heuristic, calibrated on 11 repositories (it agreed with the
 * observed number of core rules on 8 of them) and it never reads comment text.
 */
export interface FitMetrics {
  comments: number;
  prs: number;
  reviewers: number;
  /** Reviewers with at least 3 comments. */
  reviewersGe3: number;
  /** Share of all comments written by the most active reviewer, 0..1. */
  topShare: number;
  /** Pull requests commented on by at least 2 different reviewers. */
  prsMultiReviewer: number;
}

export type FitTier = "likely" | "possible" | "unlikely";

export function fitMetrics(comments: ReviewComment[]): FitMetrics {
  const byReviewer = new Map<string, number>();
  const perPr = new Map<number, Set<string>>();
  for (const c of comments) {
    byReviewer.set(c.reviewer, (byReviewer.get(c.reviewer) ?? 0) + 1);
    if (!perPr.has(c.prNumber)) perPr.set(c.prNumber, new Set());
    perPr.get(c.prNumber)!.add(c.reviewer);
  }
  const counts = [...byReviewer.values()].sort((a, b) => b - a);
  return {
    comments: comments.length,
    prs: perPr.size,
    reviewers: byReviewer.size,
    reviewersGe3: counts.filter((n) => n >= 3).length,
    topShare: comments.length ? counts[0]! / comments.length : 0,
    prsMultiReviewer: [...perPr.values()].filter((s) => s.size >= 2).length,
  };
}

/** The fetch stops at this many comments, so a count at the cap is a lower bound. */
export const COMMENT_CAP = 1000;

const LIKELY = { comments: 300, reviewersGe3: 8, topShare: 0.35, prsMultiReviewer: 30 };
const POSSIBLE = { comments: 100, reviewersGe3: 3, topShare: 0.6, prsMultiReviewer: 10 };

const meets = (m: FitMetrics, t: typeof LIKELY) =>
  m.comments >= t.comments && m.reviewersGe3 >= t.reviewersGe3 && m.topShare <= t.topShare && m.prsMultiReviewer >= t.prsMultiReviewer;

export function fitTier(m: FitMetrics): FitTier {
  if (meets(m, LIKELY)) return "likely";
  if (meets(m, POSSIBLE)) return "possible";
  return "unlikely";
}

/** What is missing for the next tier up, in plain words. */
function shortfalls(m: FitMetrics, t: typeof LIKELY): string[] {
  const out: string[] = [];
  if (m.comments < t.comments) out.push(`${m.comments} comments, needs ${t.comments}`);
  if (m.reviewersGe3 < t.reviewersGe3) out.push(`${m.reviewersGe3} reviewers with 3+ comments, needs ${t.reviewersGe3}`);
  if (m.topShare > t.topShare) out.push(`one reviewer wrote ${Math.round(m.topShare * 100)}% of the comments, limit ${Math.round(t.topShare * 100)}%`);
  if (m.prsMultiReviewer < t.prsMultiReviewer) out.push(`${m.prsMultiReviewer} pull requests with 2+ reviewers, needs ${t.prsMultiReviewer}`);
  return out;
}

const WORDING: Record<FitTier, string> = {
  likely: "Core rules are likely: enough inline review history from enough different reviewers.",
  possible: "Core rules are possible, but this check is lenient: \"possible\" often means few or none, because the history is thin or dominated by few reviewers.",
  unlikely: "Core rules are unlikely: too little inline review history for rules to recur across reviewers.",
};

/** Lines for the terminal. `window` says which comments were counted. */
export function describeFit(repo: string, m: FitMetrics, window: string): string[] {
  const tier = fitTier(m);
  const lines = [
    `${repo}: ${m.comments >= COMMENT_CAP ? `${COMMENT_CAP.toLocaleString("en-US")}+` : m.comments} inline review comments from ${m.reviewers} reviewers (${m.reviewersGe3} with 3+ comments) on ${m.prs} pull requests ${window}; the most active reviewer wrote ${Math.round(m.topShare * 100)}% of them.`,
    WORDING[tier],
  ];
  if (tier !== "likely") {
    const gaps = shortfalls(m, tier === "possible" ? LIKELY : POSSIBLE);
    if (gaps.length > 0) lines.push(`For ${tier === "possible" ? "\"likely\"" : "\"possible\""}: ${gaps.join("; ")}.`);
  }
  if (m.comments >= COMMENT_CAP) lines.push(`The count is capped at ${COMMENT_CAP.toLocaleString("en-US")} comments, so the repository has at least that many.`);
  if (m.comments === 0) lines.push("No inline review comments: teams that review in the pull request conversation, in review summaries or in a chat tool leave nothing for `mine` to read.");
  lines.push("A heuristic on counts only (no comment text is read, no model is called). It agreed with the number of core rules actually found on 8 of 11 repositories; it is lenient, so \"possible\" often means few or none. Only inline review comments count, and private repositories are not measured.");
  return lines;
}
