import { ruleTier, type Rule } from "./rule.js";

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

/** A rule worth relying on: see `ruleTier`. */
export const isCoreRule = (r: Rule): boolean => ruleTier(r) === "core";

export interface CutStability {
  /** Rules per run in this cut. */
  ruleCounts: number[];
  /** Mean pairwise overlap, rules matching when they share at least one cited comment. The gate. */
  commentOverlap: number;
  /** The same, counting only near-identical wording. Diagnostic: the model rephrases. */
  wordingOverlap: number;
  /** Mean Jaccard of the cited comment sets over matched pairs. Diagnostic: 1 means identical evidence. */
  evidenceJaccard: number;
}

export interface StabilityCuts {
  runs: number;
  top: CutStability;
  all: CutStability;
  core: CutStability;
  /**
   * Of the core rules of each run, the share every other run also has (averaged over the runs
   * taken as the reference, with the worst one). What a user relies on: the strong rules stay.
   */
  coreRetention: { mean: number; worst: number; coreRules: number[] };
}

const evidenceSetJaccard = (a: Rule, b: Rule): number => {
  const sa = new Set(a.sources.map((s) => s.commentUrl));
  const sb = new Set(b.sources.map((s) => s.commentUrl));
  let shared = 0;
  for (const u of sa) if (sb.has(u)) shared++;
  return shared / (sa.size + sb.size - shared || 1);
};

function evidenceJaccard(runs: Rule[][]): number {
  const scores: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const taken = new Set<number>();
      for (const a of runs[i]!) {
        const k = runs[j]!.findIndex((b, idx) => !taken.has(idx) && sharesComment(a, b));
        if (k >= 0) {
          taken.add(k);
          scores.push(evidenceSetJaccard(a, runs[j]![k]!));
        }
      }
    }
  }
  return scores.length ? mean(scores) : 0;
}

function cut(runs: Rule[][]): CutStability {
  return {
    ruleCounts: runs.map((r) => r.length),
    commentOverlap: mean(pairwise(runs, sharesComment)),
    wordingOverlap: mean(pairwise(runs, similarWording)),
    evidenceJaccard: evidenceJaccard(runs),
  };
}

/**
 * Overlap at three cuts of the same runs: the top `topN` rules, every rule, and the core rules
 * only. If the full lists agree far better than the top-N cut, the variance is in the ranking;
 * if not, it is in what the model extracts.
 */
export function stabilityCuts(allRuns: Rule[][], topN = 10): StabilityCuts {
  const core = allRuns.map((r) => r.filter(isCoreRule));
  const retention = core.map((rules, i) => {
    if (rules.length === 0) return undefined;
    const others = allRuns.filter((_, j) => j !== i);
    const kept = rules.filter((rule) => others.every((run) => run.some((r) => sharesComment(rule, r))));
    return kept.length / rules.length;
  });
  const defined = retention.filter((x): x is number => x !== undefined);
  return {
    runs: allRuns.length,
    top: cut(allRuns.map((r) => r.slice(0, topN))),
    all: cut(allRuns),
    core: cut(core),
    coreRetention: { mean: defined.length ? mean(defined) : 1, worst: defined.length ? Math.min(...defined) : 1, coreRules: core.map((r) => r.length) },
  };
}
