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

/**
 * Two rules from different runs are "the same rule" when most of the smaller rule's cited
 * comments are shared, or their wording is close. Evidence is the stronger signal, because
 * the model rephrases rules between runs.
 */
export function rulesMatch(a: Rule, b: Rule): boolean {
  const urlsA = new Set(a.sources.map((s) => s.commentUrl));
  const urlsB = new Set(b.sources.map((s) => s.commentUrl));
  let shared = 0;
  for (const u of urlsA) if (urlsB.has(u)) shared++;
  if (shared / Math.min(urlsA.size, urlsB.size) >= 0.5) return true;
  return jaccard(tokens(a.description), tokens(b.description)) >= 0.6;
}

export interface Overlap {
  /** One-to-one matches between the two runs. */
  matched: number;
  /** matched / rules in the union: 1 means identical output, 0 means nothing in common. */
  jaccard: number;
}

/** Greedy one-to-one matching of rules between two runs. */
export function compareRuns(a: Rule[], b: Rule[]): Overlap {
  const taken = new Set<number>();
  let matched = 0;
  for (const ra of a) {
    const j = b.findIndex((rb, idx) => !taken.has(idx) && rulesMatch(ra, rb));
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
  ruleCounts: number[];
  /** Mean pairwise Jaccard overlap over all pairs of runs. */
  meanOverlap: number;
  minOverlap: number;
  /** Rules of the first run that have a match in every other run. */
  inAllRuns: number;
  /** Rules of the first run that have a match in at least half of the other runs. */
  inMajority: number;
}

export function summarizeStability(runs: Rule[][]): StabilitySummary {
  const overlaps: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) overlaps.push(compareRuns(runs[i]!, runs[j]!).jaccard);
  }
  const [first = [], ...others] = runs;
  const hits = first.map((rule) => others.filter((run) => run.some((r) => rulesMatch(rule, r))).length);
  return {
    runs: runs.length,
    ruleCounts: runs.map((r) => r.length),
    meanOverlap: overlaps.length ? overlaps.reduce((x, y) => x + y, 0) / overlaps.length : 1,
    minOverlap: overlaps.length ? Math.min(...overlaps) : 1,
    inAllRuns: hits.filter((h) => h === others.length).length,
    inMajority: hits.filter((h) => h >= others.length / 2).length,
  };
}
