import type { Rule } from "./rule.js";

const STOP = new Set(["a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "when", "with", "that", "is", "are", "be", "use", "do", "not"]);

const tokens = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

export type Matcher = (a: Rule, b: Rule) => boolean;

/** The two rules cite at least one review comment in common. */
export const sharesComment: Matcher = (a, b) => {
  const urls = new Set(a.sources.map((s) => s.commentUrl));
  return b.sources.some((s) => urls.has(s.commentUrl));
};

/** The two rules are worded almost identically. */
export const similarWording: Matcher = (a, b) => jaccard(tokens(a.description), tokens(b.description)) >= 0.6;

/**
 * Two rules from different runs are "the same rule" when they cite a comment in common or are
 * worded almost identically; the model rephrases rules between runs, so either signal counts.
 */
export const rulesMatch: Matcher = (a, b) => sharesComment(a, b) || similarWording(a, b);

export interface Overlap {
  /** One-to-one matches between the two runs. */
  matched: number;
  /** matched / rules in the union: 1 means identical output, 0 means nothing in common. */
  jaccard: number;
}

/** Greedy one-to-one matching of rules between two runs. */
export function compareRuns(a: Rule[], b: Rule[], match: Matcher = rulesMatch): Overlap {
  const taken = new Set<number>();
  let matched = 0;
  for (const ra of a) {
    const j = b.findIndex((rb, idx) => !taken.has(idx) && match(ra, rb));
    if (j >= 0) {
      taken.add(j);
      matched++;
    }
  }
  const union = a.length + b.length - matched;
  return { matched, jaccard: union === 0 ? 1 : matched / union };
}

export interface StabilitySummary {
  runs: number;
  /** Rules per run, after cutting each run to its top N. */
  ruleCounts: number[];
  /** Mean pairwise overlap when rules count as the same if they share a cited comment or are worded alike. */
  meanOverlap: number;
  minOverlap: number;
  /** The same, counting only shared cited comments. */
  meanCommentOverlap: number;
  /** The same, counting only near-identical wording. */
  meanWordingOverlap: number;
  /** Rules of the first run that have a match in every other run. */
  inAllRuns: number;
  /** Rules of the first run that have a match in at least half of the other runs. */
  inMajority: number;
  /** Strong rules (3+ comments) that appear in fewer than 2 runs, one entry per distinct rule. */
  unstableStrong: { description: string; comments: number; runsPresent: number }[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 1);

function pairwise(runs: Rule[][], match: Matcher): number[] {
  const out: number[] = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) out.push(compareRuns(runs[i]!, runs[j]!, match).jaccard);
  return out;
}

/** Rules with at least `minComments` comments in some run that no second run reproduces. */
export function findUnstableStrong(runs: Rule[][], minComments = 3, match: Matcher = rulesMatch) {
  const seen: Rule[] = [];
  const out: StabilitySummary["unstableStrong"] = [];
  runs.forEach((run, i) => {
    for (const rule of run) {
      if (rule.sources.length < minComments || seen.some((r) => match(r, rule))) continue;
      seen.push(rule);
      const runsPresent = runs.filter((other, j) => j === i || other.some((r) => match(r, rule))).length;
      if (runsPresent < 2) out.push({ description: rule.description, comments: rule.sources.length, runsPresent });
    }
  });
  return out;
}

/** `topN` limits every run to its best rules, which is what a user reads; 0 keeps all of them. */
export function summarizeStability(allRuns: Rule[][], topN = 0): StabilitySummary {
  const runs = topN > 0 ? allRuns.map((r) => r.slice(0, topN)) : allRuns;
  const combined = pairwise(runs, rulesMatch);
  const [first = [], ...others] = runs;
  const hits = first.map((rule) => others.filter((run) => run.some((r) => rulesMatch(rule, r))).length);
  return {
    runs: runs.length,
    ruleCounts: runs.map((r) => r.length),
    meanOverlap: mean(combined),
    minOverlap: combined.length ? Math.min(...combined) : 1,
    meanCommentOverlap: mean(pairwise(runs, sharesComment)),
    meanWordingOverlap: mean(pairwise(runs, similarWording)),
    inAllRuns: hits.filter((h) => h === others.length).length,
    inMajority: hits.filter((h) => h >= others.length / 2).length,
    unstableStrong: findUnstableStrong(runs),
  };
}
