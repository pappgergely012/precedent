import { describe, expect, it } from "vitest";
import type { Rule } from "./rule.js";
import { compareRuns, findUnstableStrong, isCoreRule, rulesMatch, sharesComment, similarWording, stabilityCuts, summarizeStability } from "./stability.js";

const rule = (description: string, ...ids: number[]): Rule => ({
  id: description,
  description,
  scope: [],
  confidence: 0.4,
  sources: ids.map((id) => ({ prNumber: id, reviewer: "anna", commentUrl: `https://github.com/o/r/pull/${id}#discussion_r${id}` })),
});

describe("rulesMatch", () => {
  it("matches rules that cite a comment in common, whatever the wording", () => {
    expect(rulesMatch(rule("Use gate() in tests", 1, 2), rule("Gate tests on feature flags", 2, 3))).toBe(true);
    expect(sharesComment(rule("A", 1, 2), rule("B", 2, 3))).toBe(true);
    expect(sharesComment(rule("A", 1, 2), rule("B", 3, 4))).toBe(false);
  });

  it("reports wording similarity on its own", () => {
    expect(similarWording(rule("Add a rate limit to every new endpoint", 1), rule("Add rate limit to new endpoints every time", 9))).toBe(true);
    expect(similarWording(rule("Use gate() in tests", 1), rule("Name hooks with a use prefix", 2))).toBe(false);
  });

  it("matches near-identical wording with different evidence", () => {
    expect(rulesMatch(rule("Add a rate limit to every new endpoint", 1, 2), rule("Add rate limit to new endpoints every time", 8, 9))).toBe(true);
  });

  it("does not match unrelated rules", () => {
    expect(rulesMatch(rule("Use gate() in tests", 1, 2), rule("Name hooks with a use prefix", 7, 8))).toBe(false);
  });
});

describe("compareRuns / summarizeStability", () => {
  const a = [rule("Use gate() in tests", 1, 2), rule("Name hooks with a use prefix", 7, 8)];
  const b = [rule("Gate tests with flags", 1, 2), rule("Avoid floating promises", 20, 21)];

  it("matches one-to-one and reports Jaccard overlap", () => {
    expect(compareRuns(a, b)).toEqual({ matched: 1, jaccard: 1 / 3 });
    expect(compareRuns(a, a).jaccard).toBe(1);
    expect(compareRuns([], []).jaccard).toBe(1);
  });

  it("summarises many runs", () => {
    const s = summarizeStability([a, a, b]);
    expect(s.runs).toBe(3);
    expect(s.ruleCounts).toEqual([2, 2, 2]);
    expect(s.meanOverlap).toBeCloseTo((1 + 1 / 3 + 1 / 3) / 3);
    expect(s.minOverlap).toBeCloseTo(1 / 3);
    expect(s.meanCommentOverlap).toBeCloseTo((1 + 1 / 3 + 1 / 3) / 3);
    expect(s.meanWordingOverlap).toBeGreaterThan(0);
    expect(s.inAllRuns).toBe(1);
    expect(s.inMajority).toBe(2);
  });

  it("cuts every run to its top N before comparing", () => {
    const x = [rule("Use gate() in tests", 1, 2), rule("Name hooks with a use prefix", 7, 8)];
    const y = [rule("Use gate() in tests", 1, 2), rule("Avoid floating promises", 20, 21)];
    expect(summarizeStability([x, y], 1).meanOverlap).toBe(1);
    expect(summarizeStability([x, y], 0).meanOverlap).toBeCloseTo(1 / 3);
  });

  it("lists strong rules that fewer than two runs reproduce", () => {
    const strong = rule("Wrap lines at 79 columns", 30, 31, 32);
    const weak = rule("Prefer named exports", 40, 41);
    const common = rule("Use gate() in tests", 1, 2, 3);
    const runs = [[common, strong, weak], [rule("Gate tests", 1, 2, 3)], [rule("Gate tests too", 1, 2, 3)]];
    expect(findUnstableStrong(runs)).toEqual([{ description: "Wrap lines at 79 columns", comments: 3, runsPresent: 1 }]);
  });
});

describe("stabilityCuts", () => {
  const sourcesFor = (ids: number[], reviewers = ["anna", "bob", "cy"]) =>
    ids.map((id, i) => ({ prNumber: id, reviewer: reviewers[i % reviewers.length]!, commentUrl: `https://github.com/o/r/pull/${id}#discussion_r${id}` }));
  const r = (description: string, ids: number[], confidence = 0.4): Rule => ({ id: description, description, scope: [], confidence, sources: sourcesFor(ids) });

  it("recognises core rules", () => {
    expect(isCoreRule(r("a", [1, 2, 3]))).toBe(true);
    expect(isCoreRule(r("b", [1, 2]))).toBe(false);
    expect(isCoreRule(r("c", [1, 2], 0.6))).toBe(true);
    expect(isCoreRule({ ...r("d", [1, 2, 3]), sources: sourcesFor([1, 2, 3], ["anna"]) })).toBe(false);
  });

  it("separates ranking noise from extraction noise", () => {
    // Same pool of rules every run; only the order of the tied tail differs, so the full lists agree perfectly.
    const strong = r("strong", [1, 2, 3], 0.6);
    const tail = [10, 20, 30, 40].map((n) => r(`tail-${n}`, [n, n + 1]));
    const runs = [[strong, tail[0]!, tail[1]!, tail[2]!, tail[3]!], [strong, tail[2]!, tail[3]!, tail[0]!, tail[1]!], [strong, tail[1]!, tail[0]!, tail[3]!, tail[2]!]];
    const cuts = stabilityCuts(runs, 3);
    expect(cuts.all.commentOverlap).toBe(1);
    expect(cuts.top.commentOverlap).toBeLessThan(1);
    expect(cuts.core.commentOverlap).toBe(1);
    expect(cuts.coreRetention).toEqual({ mean: 1, worst: 1, coreRules: [1, 1, 1] });
    expect(cuts.all.evidenceJaccard).toBe(1);
  });

  it("reports how many core rules each run keeps", () => {
    const a = r("a", [1, 2, 3], 0.6);
    const b = r("b", [4, 5, 6], 0.6);
    const cuts = stabilityCuts([[a, b], [a], [a, b]]);
    // run 1 reference: b is missing in run 2 -> 1/2; run 2: a is in all -> 1; run 3: b missing in run 2 -> 1/2
    expect(cuts.coreRetention.mean).toBeCloseTo((0.5 + 1 + 0.5) / 3);
    expect(cuts.coreRetention.worst).toBe(0.5);
  });
});
