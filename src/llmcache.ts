import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { Llm } from "./llm.js";

/** Bump when the cache layout or the way keys are built changes. */
export const STAGE_CACHE_VERSION = "1";

/** Answers the model gave, by request key. */
export interface ResponseStore {
  /** Set when the file exists but cannot be read (it is kept aside as FILE.unreadable on the first save). */
  note?: string;
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
  let note: string | undefined;
  let backUpFirst = false;
  try {
    initial = FileSchema.parse(JSON.parse(await readFile(path, "utf8"))).responses;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      backUpFirst = true;
      note = `${path} is unreadable; starting without it. The old file is kept as ${path}.unreadable when the first answers are saved.`;
    }
  }
  const store = memoryStore(initial);
  return {
    note,
    get: store.get,
    set: store.set,
    async save() {
      await mkdir(dirname(path), { recursive: true });
      if (backUpFirst) {
        await rename(path, `${path}.unreadable`).catch(() => {});
        backUpFirst = false;
      }
      const tmp = `${path}.${process.pid}.tmp`; // atomic, as in the principle cache
      await writeFile(tmp, `${JSON.stringify({ version: 1, responses: store.entries() })}\n`);
      await rename(tmp, path);
    },
  };
}

/**
 * The key of one request: everything that determines the answer, so a changed prompt, model or
 * output schema is a miss. The n-th identical request within a run gets its own key (`#n`), so
 * calls that deliberately repeat a prompt to vote (`--docs`, consensus) still get independent
 * answers on the first run and the same answers on a replay.
 */
export function requestKey(prompt: string, schema: z.ZodTypeAny, model: string, occurrence: number, version = STAGE_CACHE_VERSION): string {
  const shape = JSON.stringify(z.toJSONSchema(schema));
  const hash = createHash("sha256").update(`${version}\n${model}\n${shape}\n${prompt}`).digest("hex").slice(0, 24);
  return `${hash}#${occurrence}`;
}

export type CachedLlm = Llm & { cacheStats(): CacheStats; save(): Promise<void>; /** Answers received and stored by this run (a started call that failed is not counted). */ storedCount(): number };

/**
 * Wraps a model client so every structured answer is stored and re-used. Because the key is the
 * whole prompt, this covers each stage (extraction, merge, audit, dedupe, docs) alike: re-mining
 * unchanged data asks the model nothing and gives the same rules.
 */
export function cachedLlm(inner: Llm, store: ResponseStore, model: string, version = STAGE_CACHE_VERSION, opts: { saveEachCall?: boolean } = {}): CachedLlm {
  const stats: CacheStats = { hits: 0, misses: 0 };
  // With saveEachCall every new answer is written as soon as it arrives (one write at a time), so a run that dies halfway
  // keeps what it already paid for.
  let writing: Promise<void> = Promise.resolve();
  let newAnswers = 0;
  const seen = new Map<string, number>();
  return {
    storedCount: () => newAnswers,
    usage: inner.usage?.bind(inner),
    cacheStats: () => ({ ...stats }),
    save: () => store.save(),
    async parse(prompt, schema) {
      const base = requestKey(prompt, schema, model, 0, version).split("#")[0]!;
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
      newAnswers++;
      if (opts.saveEachCall) {
        writing = writing.then(() => store.save());
        await writing;
      }
      return value;
    },
  };
}

/** A client that answers only from recorded responses and fails on anything new (for CI without credit). */
export function replayLlm(store: ResponseStore, model: string, version = STAGE_CACHE_VERSION): CachedLlm {
  const refuse: Llm = {
    async parse() {
      throw new Error("No recorded response for this request; re-record the fixture.");
    },
  };
  return cachedLlm(refuse, store, model, version);
}

export function describeCache(stats: CacheStats): string {
  const total = stats.hits + stats.misses;
  return `Cache: ${stats.hits} of ${total} model requests answered from the cache, ${stats.misses} sent to the model.`;
}
