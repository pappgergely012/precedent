import { describe, expect, it } from "vitest";
import { extractRules, filterComments } from "./extract.js";
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
