import { describe, expect, it } from "vitest";
import { dedupeRules, extractRules, filterComments, isSingleReviewer } from "./extract.js";
import type { Rule } from "./rule.js";
import type { ReviewComment } from "./github.js";
import type { Llm } from "./llm.js";

const comment = (id: number, over: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  prNumber: 100 + id,
  reviewer: id % 2 ? "anna" : "bob",
  body: "Please add a rate limit to this new endpoint.",
  path: "src/api/users.ts",
  diffHunk: "@@",
  url: `https://github.com/o/r/pull/${100 + id}#discussion_r${id}`,
  createdAt: `2026-01-0${id}T00:00:00Z`,
  ...over,
});

/** Fake LLM that answers the two prompts in order. */
const fakeLlm = (...answers: unknown[]): Llm => {
  let i = 0;
  return { parse: async (_p, schema) => schema.parse(answers[i++]) } as Llm;
};

describe("filterComments", () => {
  it("drops replies and short comments", () => {
    const kept = filterComments([
      comment(1),
      comment(2, { inReplyTo: 1 }),
      comment(3, { body: "LGTM" }),
    ]);
    expect(kept.map((c) => c.id)).toEqual([1]);
  });
});

describe("extractRules", () => {
  it("merges candidates into rules that cite their sources", async () => {
    const llm = fakeLlm(
      {
        items: [
          { id: 1, principle: "Add a rate limit to new endpoints" },
          { id: 2, principle: "New endpoints need rate limiting" },
          { id: 3, principle: null },
        ],
      },
      {
        rules: [{ description: "Add a rate limit to every new endpoint", scope: ["src/api/**"], commentIds: [1, 2] }],
      },
    );
    const rules = await extractRules([comment(1), comment(2), comment(3)], llm);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ description: "Add a rate limit to every new endpoint", scope: ["src/api/**"] });
    expect(rules[0]!.sources.map((s) => s.prNumber)).toEqual([101, 102]);
    expect(rules[0]!.confidence).toBeCloseTo(0.4);
  });

  it("drops rules below the minimum occurrence count", async () => {
    const llm = fakeLlm(
      { items: [{ id: 1, principle: "Use named exports" }] },
      { rules: [{ description: "Use named exports", scope: [], commentIds: [1] }] },
    );
    expect(await extractRules([comment(1)], llm)).toEqual([]);
  });

  it("drops rules whose comments all come from one pull request", async () => {
    const llm = fakeLlm(
      { items: [{ id: 1, principle: "Use named exports" }, { id: 2, principle: "Use named exports" }] },
      { rules: [{ description: "Use named exports", scope: [], commentIds: [1, 2] }] },
    );
    const same = [comment(1, { prNumber: 7 }), comment(2, { prNumber: 7 })];
    expect(await extractRules(same, llm)).toEqual([]);
  });

  it("ignores ids the model made up", async () => {
    const llm = fakeLlm(
      { items: [{ id: 999, principle: "Invented" }] },
    );
    expect(await extractRules([comment(1)], llm)).toEqual([]);
  });

  it("returns nothing and makes no calls for empty input", async () => {
    const llm: Llm = { parse: async () => { throw new Error("should not be called"); } };
    expect(await extractRules([], llm)).toEqual([]);
  });
});

const rule = (id: string, description: string, sources: Rule["sources"]): Rule => ({
  id,
  description,
  scope: [],
  confidence: 0.4,
  sources,
});
const src = (pr: number, reviewer: string, n = pr) => ({
  prNumber: pr,
  reviewer,
  commentUrl: `https://github.com/o/r/pull/${pr}#discussion_r${n}`,
});

describe("dedupeRules", () => {
  it("merges grouped rules, pooling sources and keeping the strongest wording", async () => {
    const rules = [
      rule("a", "Use gate() in tests", [src(1, "anna"), src(2, "bob")]),
      rule("b", "Gate tests on feature flags with @gate", [src(2, "bob", 22), src(3, "cy")]),
      rule("c", "Name hooks with a use prefix", [src(4, "anna"), src(5, "bob")]),
    ];
    const out = await dedupeRules(rules, fakeLlm({ groups: [[0, 1]] }));
    expect(out).toHaveLength(2);
    const merged = out.find((r) => r.sources.length === 4)!;
    expect(merged.description).toBe("Use gate() in tests");
    expect(merged.sources.map((x) => x.prNumber).sort()).toEqual([1, 2, 2, 3]);
  });

  it("ignores invalid, overlapping and singleton groups", async () => {
    const rules = [
      rule("a", "One", [src(1, "anna"), src(2, "bob")]),
      rule("b", "Two", [src(3, "anna"), src(4, "bob")]),
    ];
    const out = await dedupeRules(rules, fakeLlm({ groups: [[0], [9, 10], [0, 0]] }));
    expect(out).toHaveLength(2);
  });

  it("makes no call for fewer than two rules", async () => {
    const llm: Llm = { parse: async () => { throw new Error("should not be called"); } };
    expect(await dedupeRules([rule("a", "One", [src(1, "anna")])], llm)).toHaveLength(1);
  });
});

describe("extractRules quality guards", () => {
  const merge = { items: [{ id: 1, principle: "P" }, { id: 2, principle: "P" }] };

  it("lowers confidence and flags rules backed by one reviewer", async () => {
    const llm = fakeLlm(merge, { rules: [{ description: "P", scope: [], commentIds: [1, 2] }] });
    const rules = await extractRules([comment(1, { reviewer: "anna" }), comment(2, { reviewer: "anna" })], llm);
    expect(isSingleReviewer(rules[0]!)).toBe(true);
    expect(rules[0]!.confidence).toBeCloseTo(0.3);
  });

  it("skips comments older than maxAgeDays", async () => {
    const llm: Llm = { parse: async () => { throw new Error("should not be called"); } };
    const old = [comment(1, { createdAt: "2020-01-01T00:00:00Z" }), comment(2, { createdAt: "2020-01-02T00:00:00Z" })];
    expect(await extractRules(old, llm, { now: new Date("2026-10-19T00:00:00Z") })).toEqual([]);
  });

  it("reports why merged rules were dropped", async () => {
    const llm = fakeLlm(merge, { rules: [{ description: "P", scope: [], commentIds: [1] }] });
    const lines: string[] = [];
    await extractRules([comment(1), comment(2)], llm, { onProgress: (m) => lines.push(m) });
    expect(lines.join("\n")).toContain("Kept 0 of 1 merged rules; dropped 1 with fewer than 2 comments");
  });

  it("merges near-duplicate rules end to end", async () => {
    const items = [1, 2, 3, 4].map((id) => ({ id, principle: "P" }));
    const llm = fakeLlm(
      { items },
      { rules: [
        { description: "Use gate() in tests", scope: [], commentIds: [1, 2] },
        { description: "Gate tests with @gate", scope: [], commentIds: [3, 4] },
      ] },
      { groups: [[0, 1]] },
    );
    const rules = await extractRules([1, 2, 3, 4].map((i) => comment(i)), llm);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sources).toHaveLength(4);
  });
});
