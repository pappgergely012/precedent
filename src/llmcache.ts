import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Llm } from "./llm.js";

/** Bump when the cache layout or the way keys are built changes. */
export const STAGE_CACHE_VERSION = "1";

/** Answers the model gave, by request key. */
export interface ResponseStore {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
  save(): Promise<void>;
}

export interface CacheStats {
  hits: number;
  misses: number;
}

export function memoryStore(initial: Record<string, unknown> = {}): ResponseStore & { entries(): Record<string, unknown> } {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    get: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    save: async () => {},
    entries: () => Object.fromEntries(map),
  };
}

const FileSchema = z.object({ version: z.literal(1), responses: z.record(z.string(), z.unknown()) });

/** Responses stored as JSON at `path`. A missing, unreadable or outdated file is an empty store. */
export async function fileStore(path: string): Promise<ResponseStore> {
  let initial: Record<string, unknown> = {};
  try {
    initial = FileSchema.parse(JSON.parse(await readFile(path, "utf8"))).responses;
  } catch {
    // Start empty: a cache is only ever an optimisation.
  }
  const store = memoryStore(initial);
  return {
    get: store.get,
    set: store.set,
    async save() {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ version: 1, responses: store.entries() })}\n`);
    },
  };
}

/**
 * The key of one request: everything that determines the answer, so a changed prompt, model or
 * output schema is a miss. The n-th identical request within a run gets its own key (`#n`), so
 * calls that deliberately repeat a prompt to vote (`--docs`, consensus) still get independent
 * answers on the first run and the same answers on a replay.
 */
export function requestKey(prompt: string, schema: z.ZodTypeAny, model: string, occurrence: number): string {
  const shape = JSON.stringify(z.toJSONSchema(schema));
  const hash = createHash("sha256").update(`${STAGE_CACHE_VERSION}\n${model}\n${shape}\n${prompt}`).digest("hex").slice(0, 24);
  return `${hash}#${occurrence}`;
}

export type CachedLlm = Llm & { cacheStats(): CacheStats; save(): Promise<void> };

/**
 * Wraps a model client so every structured answer is stored and re-used. Because the key is the
 * whole prompt, this covers each stage (extraction, merge, audit, dedupe, docs) alike: re-mining
 * unchanged data asks the model nothing and gives the same rules.
 */
export function cachedLlm(inner: Llm, store: ResponseStore, model: string): CachedLlm {
  const stats: CacheStats = { hits: 0, misses: 0 };
  const seen = new Map<string, number>();
  return {
    usage: inner.usage?.bind(inner),
    cacheStats: () => ({ ...stats }),
    save: () => store.save(),
    async parse(prompt, schema) {
      const base = requestKey(prompt, schema, model, 0).split("#")[0]!;
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      const key = `${base}#${occurrence}`;
      const stored = store.get(key);
      if (stored !== undefined) {
        const check = schema.safeParse(stored);
        if (check.success) {
          stats.hits++;
          return check.data;
        }
      }
      stats.misses++;
      const value = await inner.parse(prompt, schema);
      store.set(key, value);
      return value;
    },
  };
}

/** A client that answers only from recorded responses and fails on anything new (for CI without credit). */
export function replayLlm(store: ResponseStore, model: string): CachedLlm {
  const refuse: Llm = {
    async parse() {
      throw new Error("No recorded response for this request; re-record the fixture.");
    },
  };
  return cachedLlm(refuse, store, model);
}

export function describeCache(stats: CacheStats): string {
  const total = stats.hits + stats.misses;
  return `Cache: ${stats.hits} of ${total} model requests answered from the cache, ${stats.misses} sent to the model.`;
}
