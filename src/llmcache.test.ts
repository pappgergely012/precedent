import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cachedLlm, describeCache, memoryStore, replayLlm, requestKey, STAGE_CACHE_VERSION } from "./llmcache.js";
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

describe("replay correctness (validator's checks)", () => {
  const prompts = ["extract batch 1", "extract batch 2", "merge all", "audit", "dedupe"];

  it("replays a recorded run twice with identical output, in order, and zero live calls", async () => {
    const live = counting();
    const store = memoryStore();
    const recorder = cachedLlm(live, store, "m");
    const recorded = [];
    for (const p of prompts) recorded.push(await recorder.parse(p, Answer));
    const liveCalls = live.calls;
    expect(liveCalls).toBe(prompts.length);

    for (let pass = 0; pass < 2; pass++) {
      const replay = replayLlm(store, "m");
      const out = [];
      for (const p of prompts) out.push(await replay.parse(p, Answer));
      expect(JSON.stringify(out)).toBe(JSON.stringify(recorded));
      expect(replay.cacheStats()).toEqual({ hits: prompts.length, misses: 0 });
    }
    expect(live.calls).toBe(liveCalls);
  });

  it("invalidates on a changed prompt, model, output schema or cache version", async () => {
    const store = memoryStore();
    await cachedLlm(counting(), store, "m").parse("p", Answer);
    const base = requestKey("p", Answer, "m", 0);
    expect(requestKey("p", Answer, "m", 0)).toBe(base);
    expect(requestKey("p!", Answer, "m", 0)).not.toBe(base);
    expect(requestKey("p", Answer, "other", 0)).not.toBe(base);
    expect(requestKey("p", z.object({ n: z.number(), more: z.string() }), "m", 0)).not.toBe(base);
    expect(requestKey("p", Answer, "m", 0, `${STAGE_CACHE_VERSION}-next`)).not.toBe(base);
    await expect(replayLlm(store, "m", `${STAGE_CACHE_VERSION}-next`).parse("p", Answer)).rejects.toThrow(/No recorded response/);
    await expect(replayLlm(store, "other").parse("p", Answer)).rejects.toThrow(/No recorded response/);
    await expect(replayLlm(store, "m").parse("p changed", Answer)).rejects.toThrow(/No recorded response/);
  });

  it("stores two entries for two identical prompts in one run", async () => {
    const store = memoryStore();
    const llm = cachedLlm(counting(), store, "m");
    await llm.parse("vote", Answer);
    await llm.parse("vote", Answer);
    expect(Object.keys(store.entries())).toHaveLength(2);
  });
});

describe("cachedLlm with saveEachCall", () => {
  it("writes every new answer to the store as it arrives, so a failure later does not lose it", async () => {
    const saved: number[] = [];
    const memory = memoryStore();
    const store = { get: memory.get, set: memory.set, save: async () => void saved.push(Object.keys(memory.entries()).length) };
    let n = 0;
    const inner = { parse: async (_p: string, schema: { parse: (v: unknown) => unknown }) => { if (++n === 3) throw new Error("terminated"); return schema.parse({ ok: true }); } } as never;
    const llm = cachedLlm(inner, store, "m", undefined, { saveEachCall: true });
    const schema = z.object({ ok: z.boolean() });
    await llm.parse("one", schema);
    await llm.parse("two", schema);
    await expect(llm.parse("three", schema)).rejects.toThrow("terminated");
    expect(saved).toEqual([1, 2]);
  });
});
