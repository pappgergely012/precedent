import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileCache, memoryCache } from "./cache.js";
import { extractRules } from "./extract.js";
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

describe("PrincipleCache", () => {
  it("misses unknown comments, hits stored ones (including 'no rule') and misses when the text changes", () => {
    const cache = memoryCache();
    expect(cache.get(1, "text")).toBeUndefined();
    cache.set(1, "text", "Add a rate limit");
    cache.set(2, "text", null);
    expect(cache.get(1, "text")).toBe("Add a rate limit");
    expect(cache.get(2, "text")).toBeNull();
    expect(cache.get(1, "edited text")).toBeUndefined();
  });

  it("round-trips through a file, and a different model does not see the entries", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "precedent-")), "nested", "cache.json");
    const a = await fileCache(path, "model-a");
    a.set(1, "text", "Rule");
    await a.save();
    expect(await (await fileCache(path, "model-a")).get(1, "text")).toBe("Rule");
    expect(await (await fileCache(path, "model-b")).get(1, "text")).toBeUndefined();
  });

  it("treats a corrupt or missing file as empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "precedent-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    expect((await fileCache(bad, "m")).get(1, "t")).toBeUndefined();
    expect((await fileCache(join(dir, "missing.json"), "m")).get(1, "t")).toBeUndefined();
    const c = await fileCache(bad, "m");
    c.set(1, "t", "R");
    await c.save();
    expect(JSON.parse(readFileSync(bad, "utf8")).version).toBe(1);
  });
});

describe("extractRules with a cache", () => {
  /** Counts extraction calls (prompts listing comment ids) and answers every comment with one principle. */
  const countingLlm = () => {
    const state = { extractionCalls: 0, askedIds: [] as number[] };
    const llm: Llm = {
      parse: async (prompt, schema) => {
        if (prompt.includes("analyse code review comments")) {
          state.extractionCalls++;
          const ids = [...prompt.matchAll(/^\[(\d+)\] file:/gm)].map((m) => Number(m[1]));
          state.askedIds.push(...ids);
          return schema.parse({ items: ids.map((id) => ({ id, principle: id === 3 ? null : "Add a rate limit" })) });
        }
        if (prompt.includes("candidate coding rules")) return schema.parse({ rules: [{ description: "Add a rate limit to every endpoint", scope: [], commentIds: [1, 2] }] });
        if (prompt.includes("audit rules")) return schema.parse({ rules: [{ index: 0, supportingIds: [1, 2], revisedDescription: null }] });
        return schema.parse({ groups: [] });
      },
    };
    return { llm, state };
  };

  it("does not send cached comments to the model again, and still produces the same rule", async () => {
    const cache = memoryCache();
    const comments = [comment(1), comment(2), comment(3)];
    const first = countingLlm();
    const rules1 = await extractRules(comments, first.llm, { cache });
    expect(first.state.askedIds.sort()).toEqual([1, 2, 3]);

    const second = countingLlm();
    const rules2 = await extractRules(comments, second.llm, { cache });
    expect(second.state.extractionCalls).toBe(0);
    expect(rules2.map((r) => r.description)).toEqual(rules1.map((r) => r.description));
    expect(rules2[0]!.sources).toHaveLength(2);
  });

  it("asks only about new or edited comments", async () => {
    const cache = memoryCache();
    await extractRules([comment(1), comment(2)], countingLlm().llm, { cache });
    const next = countingLlm();
    await extractRules([comment(1), comment(2, { body: "Please add a rate limit, and document it here." }), comment(4)], next.llm, { cache });
    expect(next.state.askedIds.sort()).toEqual([2, 4]);
  });

  it("does not cache comments the model skipped", async () => {
    const cache = memoryCache();
    const skipping: Llm = { parse: async (_p, schema) => schema.parse({ items: [] }) };
    await extractRules([comment(1), comment(2)], skipping, { cache });
    expect(cache.get(1, "x")).toBeUndefined();
    const next = countingLlm();
    await extractRules([comment(1), comment(2)], next.llm, { cache });
    expect(next.state.askedIds.sort()).toEqual([1, 2]);
  });
});
