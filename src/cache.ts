import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Bump when the extraction prompt changes: cached answers were produced by the old wording.
 */
export const PROMPT_VERSION = "1";

/**
 * What the model said about each review comment: the general rule it expresses, or `null` when
 * it expresses none. Re-mining a repository then only pays for comments that are new, and the
 * per-comment judgements stop varying between runs.
 */
export interface PrincipleCache {
  /** `undefined` means "not cached"; `null` is a cached "this comment states no rule". */
  get(commentId: number, text: string): string | null | undefined;
  set(commentId: number, text: string, principle: string | null): void;
  save(): Promise<void>;
  /** How many lookups found an answer (a run that uses the cache is not a fresh run). */
  hits(): number;
}

const keyOf = (text: string, model: string) =>
  createHash("sha256").update(`${PROMPT_VERSION}\n${model}\n${text}`).digest("hex").slice(0, 16);

const FileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.object({ k: z.string(), p: z.string().nullable() })),
});

function build(model: string, entries: Map<number, { k: string; p: string | null }>, save: () => Promise<void>): PrincipleCache {
  let hitCount = 0;
  return {
    get(id, text) {
      const hit = entries.get(id);
      if (!hit || hit.k !== keyOf(text, model)) return undefined;
      hitCount++;
      return hit.p;
    },
    hits: () => hitCount,
    set(id, text, principle) {
      entries.set(id, { k: keyOf(text, model), p: principle });
    },
    save,
  };
}

export function memoryCache(model = "test"): PrincipleCache {
  return build(model, new Map(), async () => {});
}

/** A cache stored as JSON at `path`. A missing, unreadable or outdated file is an empty cache. */
export async function fileCache(path: string, model: string): Promise<PrincipleCache> {
  const entries = new Map<number, { k: string; p: string | null }>();
  try {
    const file = FileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    for (const [id, entry] of Object.entries(file.entries)) entries.set(Number(id), entry);
  } catch {
    // Start empty: a cache is only ever an optimisation.
  }
  return build(model, entries, async () => {
    await mkdir(dirname(path), { recursive: true });
    const file = { version: 1 as const, entries: Object.fromEntries(entries) };
    await writeFile(path, `${JSON.stringify(file)}\n`);
  });
}
