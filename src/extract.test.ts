import { describe, expect, it } from "vitest";
import { auditSupport, cacheText, dedupeRules, extractRules, filterComments, isSingleReviewer, mergeCandidates, mergeSharedSources, mergeWithPreClusters, preClusters } from "./extract.js";
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
      { rules: [{ index: 0, supportingIds: [1, 2], revisedDescription: null }] },
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
    const llm = fakeLlm(
      merge,
      { rules: [{ description: "P", scope: [], commentIds: [1, 2] }] },
      { rules: [{ index: 0, supportingIds: [1, 2], revisedDescription: null }] },
    );
    const rules = await extractRules([comment(1, { reviewer: "anna" }), comment(2, { reviewer: "anna" })], llm);
    expect(isSingleReviewer(rules[0]!)).toBe(true);
    expect(rules[0]!.confidence).toBeCloseTo(0.2);
  });

  it("skips comments older than maxAgeDays", async () => {
    const llm: Llm = { parse: async () => { throw new Error("should not be called"); } };
    const old = [comment(1, { createdAt: "2020-01-01T00:00:00Z" }), comment(2, { createdAt: "2020-01-02T00:00:00Z" })];
    expect(await extractRules(old, llm, { now: new Date("2026-10-19T00:00:00Z"), minRecentComments: 0 })).toEqual([]);
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
      { rules: [
        { index: 0, supportingIds: [1, 2], revisedDescription: null },
        { index: 1, supportingIds: [3, 4], revisedDescription: null },
      ] },
      { groups: [[0, 1]] },
    );
    const rules = await extractRules([1, 2, 3, 4].map((i) => comment(i)), llm);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sources).toHaveLength(4);
  });
});

describe("filterComments accuracy guards", () => {
  it("drops comments written by the pull request author", () => {
    const kept = filterComments([comment(1), comment(2, { byPullRequestAuthor: true })]);
    expect(kept.map((c) => c.id)).toEqual([1]);
  });

  it("counts identical text from one reviewer on one PR once, but not across PRs", () => {
    const kept = filterComments([
      comment(1, { prNumber: 5, reviewer: "anna" }),
      comment(2, { prNumber: 5, reviewer: "anna", body: "  PLEASE add a rate  limit to this new endpoint. " }),
      comment(3, { prNumber: 6, reviewer: "anna" }),
      comment(4, { prNumber: 5, reviewer: "bob" }),
    ]);
    expect(kept.map((c) => c.id)).toEqual([1, 3, 4]);
  });
});

describe("auditSupport", () => {
  const byId = (...ids: number[]) => new Map(ids.map((id) => [id, comment(id)]));
  const opts = { minOccurrences: 2, minPullRequests: 2 };
  const base = (): Rule => rule("a", "Do X everywhere", [src(1, "anna"), src(2, "bob"), src(3, "cy")]);

  it("keeps only supporting sources and narrows overreaching text", async () => {
    const llm = fakeLlm({ rules: [{ index: 0, supportingIds: [1, 2], revisedDescription: "Do X in TypeScript files" }] });
    const { rules, dropped } = await auditSupport([base()], byId(1, 2, 3), llm, opts);
    expect(dropped).toBe(0);
    expect(rules[0]!.description).toBe("Do X in TypeScript files");
    expect(rules[0]!.sources.map((x) => x.prNumber)).toEqual([1, 2]);
  });

  it("drops a rule left with fewer than two supporting comments", async () => {
    const llm = fakeLlm({ rules: [{ index: 0, supportingIds: [1], revisedDescription: null }] });
    const { rules, dropped } = await auditSupport([base()], byId(1, 2, 3), llm, opts);
    expect(rules).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("drops a rule whose supporting comments come from one pull request", async () => {
    const same = rule("a", "Do X", [src(1, "anna", 1), src(1, "bob", 2)]);
    const llm = fakeLlm({ rules: [{ index: 0, supportingIds: [1, 2], revisedDescription: null }] });
    expect((await auditSupport([same], byId(1, 2), llm, opts)).rules).toEqual([]);
  });

  it("keeps a rule the model skipped instead of losing it silently", async () => {
    const llm = fakeLlm({ rules: [] });
    const { rules } = await auditSupport([base()], byId(1, 2, 3), llm, opts);
    expect(rules).toHaveLength(1);
  });
});

describe("mergeSharedSources", () => {
  it("merges rules that rest on the same comments and keeps unrelated ones", () => {
    const merged = mergeSharedSources([
      rule("a", "Use gate()", [src(1, "anna"), src(2, "bob")]),
      rule("b", "Gate tests on flags", [src(1, "anna"), src(2, "bob"), src(3, "cy")]),
      rule("c", "Name hooks use*", [src(7, "anna"), src(8, "bob")]),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((r) => r.sources.some((x) => x.prNumber === 3))!.sources).toHaveLength(3);
  });
});

describe("adaptive staleness cutoff", () => {
  const old = (n: number) => Array.from({ length: n }, (_, i) => comment(i + 1, { prNumber: 100 + i, createdAt: `2020-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
  const now = new Date("2026-10-19T00:00:00Z");

  it("keeps the newest old comments when too little recent evidence is left", async () => {
    const lines: string[] = [];
    let analysed = 0;
    const llm: Llm = { parse: async (prompt) => { analysed = (prompt.match(/^\[\d+\] file:/gm) ?? []).length; return { items: [] } as never; } };
    await extractRules(old(5), llm, { now, minRecentComments: 3, onProgress: (m) => lines.push(m) });
    expect(analysed).toBe(3);
    expect(lines.join("\n")).toContain("Only 0 comments are newer than 730 days; keeping the 3 newest");
  });

  it("applies the cutoff normally once enough recent comments remain", async () => {
    const recent = [1, 2, 3].map((i) => comment(i, { prNumber: 200 + i, createdAt: "2026-10-01T00:00:00Z" }));
    let analysed = 0;
    const llm: Llm = { parse: async (prompt) => { analysed = (prompt.match(/^\[\d+\] file:/gm) ?? []).length; return { items: [] } as never; } };
    await extractRules([...recent, ...old(5).map((c) => ({ ...c, id: c.id + 100 }))], llm, { now, minRecentComments: 3 });
    expect(analysed).toBe(3);
  });
});

describe("empty result hint", () => {
  const hintFor = async (comments: ReviewComment[], llm: Llm) => {
    const lines: string[] = [];
    await extractRules(comments, llm, { onProgress: (m) => lines.push(m) });
    return lines.find((l) => l.startsWith("Hint:"));
  };

  it("explains an empty fetch", async () => {
    expect(await hintFor([], fakeLlm())).toContain("No review comments were found");
  });

  it("explains comments that are all replies or too short", async () => {
    expect(await hintFor([comment(1, { inReplyTo: 9 })], fakeLlm())).toContain("None of the 1 fetched comments is a usable top-level review comment");
  });

  it("explains candidates that never recur", async () => {
    const llm = fakeLlm({ items: [{ id: 1, principle: "P" }] }, { rules: [] });
    expect(await hintFor([comment(1)], llm)).toContain("none recurs in 2+ comments from 2+ pull requests");
  });

  it("is not printed when rules are found", async () => {
    const llm = fakeLlm(
      { items: [{ id: 1, principle: "P" }, { id: 2, principle: "P" }] },
      { rules: [{ description: "P", scope: [], commentIds: [1, 2] }] },
      { rules: [{ index: 0, supportingIds: [1, 2], revisedDescription: null }] },
    );
    expect(await hintFor([comment(1), comment(2)], llm)).toBeUndefined();
  });
});

describe("mergeCandidates", () => {
  it("carries a rule through higher merge levels when the model finds no partner for it", async () => {
    const candidates = Array.from({ length: 151 }, (_, i) => ({ id: i + 1, principle: `P${i}` }));
    // Level 1: chunk of 150 yields one rule from ids 1 and 2; the last chunk yields nothing.
    // Level 2: no partner for the surviving rule, so the model returns no groups.
    const llm = fakeLlm(
      { rules: [{ description: "Rule A", scope: [], commentIds: [1, 2] }] },
      { rules: [] },
      { rules: [] },
    );
    const merged = await mergeCandidates(candidates, llm);
    expect(merged).toEqual([{ description: "Rule A", scope: [], commentIds: [1, 2] }]);
  });
});

describe("batch concurrency", () => {
  it("keeps results complete and ordered when batches run in parallel", async () => {
    const comments = [1, 2, 3, 4].map((i) => comment(i));
    const seen: number[] = [];
    const llm: Llm = {
      parse: async (prompt, schema) => {
        const ids = [...prompt.matchAll(/^\[(\d+)\] file:/gm)].map((m) => Number(m[1]));
        await new Promise((r) => setTimeout(r, ids[0] === 4 ? 1 : 15));
        seen.push(...ids);
        if (prompt.includes("candidate coding rules")) return schema.parse({ rules: [{ description: "P", scope: [], commentIds: [1, 2, 3, 4] }] });
        if (prompt.includes("audit rules")) return schema.parse({ rules: [{ index: 0, supportingIds: [1, 2, 3, 4], revisedDescription: null }] });
        return schema.parse({ items: ids.map((id) => ({ id, principle: "P" })) });
      },
    };
    const rules = await extractRules(comments, llm, { batchSize: 1, concurrency: 4 });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sources).toHaveLength(4);
  });
});

describe("pre-merge of near-identical candidates", () => {
  const cand = (id: number, principle: string) => ({ id, principle });
  const gate = [
    cand(1, "Use assertConsoleErrorDev to assert console.error output in tests"),
    cand(2, "Use assertConsoleErrorDev to assert console.error calls in tests"),
    cand(3, "Use assertConsoleErrorDev for asserting console.error output in tests"),
  ];
  const unrelated = [cand(10, "Name hooks with a use prefix"), cand(11, "Wrap lines at 79 columns in documentation")];

  it("clusters candidates whose wording is almost the same, and only those", () => {
    expect(preClusters([...gate, ...unrelated])).toEqual([[1, 2, 3]]);
    expect(preClusters(unrelated)).toEqual([]);
  });

  it("is deterministic and respects the cluster size cap", () => {
    const many = Array.from({ length: 12 }, (_, i) => cand(i + 1, "Use assertConsoleErrorDev to assert console.error output in tests"));
    const a = preClusters(many, { maxSize: 5 });
    expect(preClusters(many, { maxSize: 5 })).toEqual(a);
    expect(a.every((c) => c.length <= 5)).toBe(true);
    expect(a.flat().length).toBeGreaterThan(5);
  });

  it("keeps a cluster the model leaves alone as a rule of its own, with every member", async () => {
    // The model sees representatives only (1, 10, 11) and groups none of them.
    const llm = fakeLlm({ rules: [] });
    const merged = await mergeWithPreClusters([...gate, ...unrelated], llm);
    expect(merged).toEqual([{ description: "Use assertConsoleErrorDev to assert console.error output in tests", scope: [], commentIds: [1, 2, 3] }]);
  });

  it("expands a group the model forms around a representative to all cluster members", async () => {
    const llm = fakeLlm({ rules: [{ description: "Console and naming conventions", scope: [], commentIds: [1, 10] }] });
    const merged = await mergeWithPreClusters([...gate, ...unrelated], llm);
    expect(merged).toEqual([{ description: "Console and naming conventions", scope: [], commentIds: [1, 2, 3, 10] }]);
  });

  it("shows the model only the representatives", async () => {
    const seen: string[] = [];
    const llm: Llm = { parse: async (prompt, schema) => { seen.push(prompt); return schema.parse({ rules: [] }); } };
    await mergeWithPreClusters([...gate, ...unrelated], llm);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("[1]");
    expect(seen[0]).not.toContain("[2]");
    expect(seen[0]).not.toContain("[3]");
    expect(seen[0]).toContain("[10]");
  });

  it("falls back to the plain merge when nothing clusters", async () => {
    const llm = fakeLlm({ rules: [{ description: "Both conventions", scope: [], commentIds: [10, 11] }] });
    const merged = await mergeWithPreClusters(unrelated, llm);
    expect(merged).toEqual([{ description: "Both conventions", scope: [], commentIds: [10, 11] }]);
  });
});

describe("extractRules with a recorded model", () => {
  it("re-mining the same data replays every stage and returns identical rules", async () => {
    const { cachedLlm, memoryStore, replayLlm } = await import("./llmcache.js");
    const answers = [
      { items: [{ id: 1, principle: "Add a rate limit to new endpoints" }, { id: 2, principle: "New endpoints need rate limiting" }] },
      { rules: [{ description: "Add a rate limit to every new endpoint", scope: ["src/api/**"], commentIds: [1, 2] }] },
      { rules: [{ index: 0, supportingIds: [1, 2], revisedDescription: null }] },
    ];
    const store = memoryStore();
    const first = cachedLlm(fakeLlm(...answers), store, "m");
    const rules = await extractRules([comment(1), comment(2)], first);
    expect(first.cacheStats()).toEqual({ hits: 0, misses: 3 });

    const replay = replayLlm(store, "m");
    expect(await extractRules([comment(1), comment(2)], replay)).toEqual(rules);
    expect(replay.cacheStats()).toEqual({ hits: 3, misses: 0 });
  });
});

describe("extractRules detail output", () => {
  const answers = () => [
    { items: [{ id: 1, principle: "Ignore .claude/settings.local.json" }, { id: 2, principle: "Ignore the .claude local settings" }] },
    { rules: [{ description: "Add settings.local.json to .gitignore in .claude", scope: [".claude/**"], commentIds: [1, 2] }] },
  ];

  it("prints a dropped rule's text on one line, without escape sequences or forged lines", async () => {
    const evil = [
      { items: [{ id: 1, principle: "Ignore .claude/settings.local.json" }, { id: 2, principle: "Ignore the .claude local settings" }] },
      { rules: [{ description: "Add settings.local.json to .gitignore in .claude\n  filtered: FORGED \u001b[31mred\u001b[0m", scope: [".claude/**"], commentIds: [1, 2] }] },
    ];
    const lines: string[] = [];
    await extractRules([comment(1), comment(2)], fakeLlm(...evil), { onDetail: (m) => lines.push(m) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\u0000-\u001f]/);
  });

  it("lists the texts of filtered rules only when asked, and the result is the same either way", async () => {
    const quiet = await extractRules([comment(1), comment(2)], fakeLlm(...answers()));
    const lines: string[] = [];
    const loud = await extractRules([comment(1), comment(2)], fakeLlm(...answers()), { onDetail: (m) => lines.push(m) });
    expect(loud).toEqual(quiet);
    expect(quiet).toEqual([]);
    expect(lines).toEqual(["  filtered: tool-artefact: Add settings.local.json to .gitignore in .claude (.claude/**)"]);
  });
});

describe("extraction votes (flag-gated variant)", () => {
  const rateLimit = (id: number) => ({ id, principle: "Add a rate limit to new endpoints" });
  /** Scripted model: answers extraction prompts from a queue, then merge/audit prompts. */
  const scripted = (extraction: unknown[], rest: unknown[]) => {
    let e = 0;
    let r = 0;
    const llm = {
      calls: 0,
      parse: async (prompt: string, schema: { parse: (v: unknown) => unknown }) => {
        llm.calls++;
        return schema.parse(prompt.includes("You analyse code review comments") ? extraction[e++] : rest[r++]);
      },
    };
    return llm as unknown as Llm & { calls: number };
  };
  const comments = [comment(1), comment(2), comment(3)];

  it("asks three times and keeps a comment only when most answers call it a rule", async () => {
    const yes = { items: [rateLimit(1), rateLimit(2), { id: 3, principle: null }] };
    const mixed = { items: [{ id: 1, principle: null }, rateLimit(2), { id: 3, principle: null }] };
    const llm = scripted([yes, mixed, yes], [
      { rules: [{ description: "Add a rate limit to every new endpoint", scope: [], commentIds: [1, 2] }] },
      { rules: [{ index: 0, supportingIds: [1, 2], revisedDescription: null }] },
    ]);
    const lines: string[] = [];
    const rules = await extractRules(comments, llm, { extractionVotes: 3, onProgress: (m) => lines.push(m) });
    expect(lines.some((l) => l.includes("each asked 3 times"))).toBe(true);
    expect(llm.calls).toBe(3 + 2);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.sources.map((s) => s.prNumber)).toEqual([101, 102]);
  });

  it("drops a comment that only one of three answers calls a rule", async () => {
    const one = { items: [rateLimit(1), { id: 2, principle: null }, { id: 3, principle: null }] };
    const none = { items: [{ id: 1, principle: null }, { id: 2, principle: null }, { id: 3, principle: null }] };
    const llm = scripted([one, none, none], []);
    expect(await extractRules(comments, llm, { extractionVotes: 3 })).toEqual([]);
    expect(llm.calls).toBe(3);
  });

  it("is identical to the default when the option is 1 or unset", async () => {
    const run = async (opts: { extractionVotes?: number }) => {
      const yes = { items: [rateLimit(1), rateLimit(2), { id: 3, principle: null }] };
      const llm = scripted([yes], [
        { rules: [{ description: "Add a rate limit to every new endpoint", scope: [], commentIds: [1, 2] }] },
        { rules: [{ index: 0, supportingIds: [1, 2], revisedDescription: null }] },
      ]);
      return { rules: await extractRules(comments, llm, opts), calls: llm.calls };
    };
    expect(await run({ extractionVotes: 1 })).toEqual(await run({}));
  });
});

describe("sharedMergeThreshold (flag-gated variant)", () => {
  it("pools rules that share only one comment when the threshold is near zero, and not by default", async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    const answers = () => [
      { items: ids.map((id) => ({ id, principle: `Rule text number ${id} about endpoints` })) },
      { rules: [
        { description: "Add a rate limit to new endpoints", scope: [], commentIds: [1, 2, 3, 4] },
        { description: "Document rate limits on endpoints", scope: [], commentIds: [4, 5, 6, 7, 8] },
      ] },
      { rules: [{ index: 0, supportingIds: [1, 2, 3, 4], revisedDescription: null }, { index: 1, supportingIds: [4, 5, 6, 7, 8], revisedDescription: null }] },
      { groups: [] },
    ];
    const all = ids.map((id) => comment(id));
    // one shared comment out of the smaller rule's four is 0.25, below the default 0.5
    expect(await extractRules(all, fakeLlm(...answers()))).toHaveLength(2);
    const pooled = await extractRules(all, fakeLlm(...answers()), { sharedMergeThreshold: 0.01 });
    expect(pooled).toHaveLength(1);
    expect(pooled[0]!.sources).toHaveLength(8);
  });
});

describe("reusing per-comment extractions from a file (--reuse-extractions)", () => {
  const answersFor = (ids: number[], all: number[]) => [
    { items: ids.map((id) => ({ id, principle: "Add a rate limit to new endpoints" })) },
    { rules: [{ description: "Add a rate limit to new endpoints", scope: [], commentIds: all }] },
    { rules: [{ index: 0, supportingIds: all, revisedDescription: null }] },
    { groups: [] },
  ];
  const spy = (...answers: unknown[]) => {
    const prompts: string[] = [];
    let i = 0;
    return { prompts, llm: { parse: async (p: string, schema: { parse: (v: unknown) => unknown }) => (prompts.push(p), schema.parse(answers[i++])) } as unknown as Llm };
  };

  it("asks only about new or edited comments, but runs merge, audit and dedupe again on every run", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileCache } = await import("./cache.js");
    const file = join(mkdtempSync(join(tmpdir(), "precedent-reuse-")), "ext.json");

    const first = spy(...answersFor([1, 2, 3, 4], [1, 2, 3, 4]));
    await extractRules([1, 2, 3, 4].map((id) => comment(id)), first.llm, { cache: await fileCache(file, "m") });
    expect(first.prompts.length).toBeGreaterThanOrEqual(3); // extraction, merge, audit

    // second run: comment 5 is new, comment 2 was edited; 1, 3 and 4 are reused from the file
    const second = spy(...answersFor([2, 5], [1, 2, 3, 4, 5]));
    const cache = await fileCache(file, "m");
    await extractRules([comment(1), comment(2, { body: "Please add a rate limit to this new endpoint (edited)." }), comment(3), comment(4), comment(5)], second.llm, { cache });
    const extraction = second.prompts[0]!;
    expect(extraction).toContain("[2]");
    expect(extraction).toContain("[5]");
    expect(extraction).not.toMatch(/\[1\]|\[3\]|\[4\]/);
    expect(cache.hits()).toBe(3);
    expect(second.prompts.length).toBeGreaterThanOrEqual(3); // extraction, then merge and audit again: nothing replays them

    // a different model never reuses the file
    const other = await fileCache(file, "another-model");
    expect(other.get(1, cacheText(comment(1), 1))).toBeUndefined();
  });
});

