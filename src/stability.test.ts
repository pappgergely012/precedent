import { describe, expect, it } from "vitest";
import type { Rule } from "./rule.js";
import { compareRuns, rulesMatch, summarizeStability } from "./stability.js";

const rule = (description: string, ...ids: number[]): Rule => ({
  id: description,
  description,
  scope: [],
  confidence: 0.4,
  sources: ids.map((id) => ({ prNumber: id, reviewer: "anna", commentUrl: `https://github.com/o/r/pull/${id}#discussion_r${id}` })),
});

describe("rulesMatch", () => {
  it("matches rules that cite mostly the same comments, whatever the wording", () => {
    expect(rulesMatch(rule("Use gate() in tests", 1, 2), rule("Gate tests on feature flags", 2, 3))).toBe(true);
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
    expect(s.inAllRuns).toBe(1);
    expect(s.inMajority).toBe(2);
  });
});
