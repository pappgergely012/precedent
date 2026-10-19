import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cachedLlm, describeCache, memoryStore, replayLlm } from "./llmcache.js";
import type { Llm } from "./llm.js";

const Answer = z.object({ n: z.number() });

function counting(): Llm & { calls: number } {
  const llm = {
    calls: 0,
    async parse(prompt: string, schema: z.ZodTypeAny) {
      llm.calls++;
      return schema.parse({ n: prompt.length * 100 + llm.calls });
    },
  };
  return llm as Llm & { calls: number };
}

describe("cachedLlm", () => {
  it("answers a repeated request from the store and counts hits and misses", async () => {
    const inner = counting();
    const store = memoryStore();
    const first = cachedLlm(inner, store, "m");
    const a = await first.parse("merge these", Answer);
    expect(first.cacheStats()).toEqual({ hits: 0, misses: 1 });

    const second = cachedLlm(inner, store, "m");
    expect(await second.parse("merge these", Answer)).toEqual(a);
    expect(inner.calls).toBe(1);
    expect(second.cacheStats()).toEqual({ hits: 1, misses: 0 });
    expect(describeCache(second.cacheStats())).toBe("Cache: 1 of 1 model requests answered from the cache, 0 sent to the model.");
  });

  it("misses when the prompt, model or schema changes", async () => {
    const inner = counting();
    const store = memoryStore();
    await cachedLlm(inner, store, "m").parse("p", Answer);
    await cachedLlm(inner, store, "m").parse("p changed", Answer);
    await cachedLlm(inner, store, "other-model").parse("p", Answer);
    await cachedLlm(inner, store, "m").parse("p", z.object({ n: z.number(), extra: z.number().optional() }));
    expect(inner.calls).toBe(4);
  });

  it("keeps repeated identical prompts independent on a first run and identical on a replay", async () => {
    const inner = counting();
    const store = memoryStore();
    const run1 = cachedLlm(inner, store, "m");
    const votes1 = [await run1.parse("vote", Answer), await run1.parse("vote", Answer), await run1.parse("vote", Answer)];
    expect(inner.calls).toBe(3);
    expect(new Set(votes1.map((v) => v.n)).size).toBe(3);

    const run2 = cachedLlm(inner, store, "m");
    const votes2 = [await run2.parse("vote", Answer), await run2.parse("vote", Answer), await run2.parse("vote", Answer)];
    expect(votes2).toEqual(votes1);
    expect(inner.calls).toBe(3);
  });

  it("ignores a stored answer that no longer matches the schema", async () => {
    const inner = counting();
    const store = memoryStore();
    await cachedLlm(inner, store, "m").parse("p", Answer);
    const key = Object.keys(store.entries())[0]!;
    store.set(key, { n: "not a number" });
    const again = cachedLlm(inner, store, "m");
    await again.parse("p", Answer);
    expect(again.cacheStats().misses).toBe(1);
  });
});

describe("replayLlm", () => {
  it("replays recorded answers and refuses new requests", async () => {
    const store = memoryStore();
    const recorded = await cachedLlm(counting(), store, "m").parse("p", Answer);
    const replay = replayLlm(store, "m");
    expect(await replay.parse("p", Answer)).toEqual(recorded);
    await expect(replay.parse("never recorded", Answer)).rejects.toThrow(/No recorded response/);
  });
});
