import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  /** Set when the file was made by another model or prompt version, or cannot be read: its answers will not be used. */
  note?: string;
  /** How many answers are held (loaded or recorded). */
  size(): number;
}

const keyOf = (text: string, model: string) =>
  createHash("sha256").update(`${PROMPT_VERSION}\n${model}\n${text}`).digest("hex").slice(0, 16);

const FileSchema = z.object({
  version: z.literal(1),
  meta: z.object({ promptVersion: z.string(), model: z.string() }).optional(),
  entries: z.record(z.string(), z.object({ k: z.string(), p: z.string().nullable() })),
});

function build(model: string, entries: Map<number, { k: string; p: string | null }>, save: () => Promise<void>, note?: string): PrincipleCache {
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
    note,
    size: () => entries.size,
  };
}

export function memoryCache(model = "test"): PrincipleCache {
  return build(model, new Map(), async () => {});
}

/** A cache stored as JSON at `path`. A missing, unreadable or outdated file is an empty cache. */
export async function fileCache(path: string, model: string): Promise<PrincipleCache> {
  const entries = new Map<number, { k: string; p: string | null }>();
  let note: string | undefined;
  let backUpFirst = false;
  try {
    const file = FileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (file.meta && (file.meta.model !== model || file.meta.promptVersion !== PROMPT_VERSION)) {
      // The notice and the behaviour agree: nothing from a file made by another model or prompt version is used.
      note = `${path} was made with model ${file.meta.model} and prompt version ${file.meta.promptVersion}; this run uses ${model} and ${PROMPT_VERSION}, so none of its answers will be reused (they are replaced as comments are judged again). Use another file name to keep the old one.`;
    } else {
      for (const [id, entry] of Object.entries(file.entries)) entries.set(Number(id), entry);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // A cut or corrupt file (a full disk, a copy that stopped): say so, and keep it aside instead of silently replacing it.
      backUpFirst = true;
      const reason = error instanceof z.ZodError ? "it is not a Precedent cache file" : (error as Error).message.split("\n")[0];
      note = `${path} is unreadable (${reason}); starting without it. The old file is kept as ${path}.unreadable when the first answers are saved.`;
    }
  }
  return build(
    model,
    entries,
    async () => {
      await mkdir(dirname(path), { recursive: true });
      if (backUpFirst) {
        await rename(path, `${path}.unreadable`).catch(() => {});
        backUpFirst = false;
      }
      const file = { version: 1 as const, meta: { promptVersion: PROMPT_VERSION, model }, entries: Object.fromEntries(entries) };
      // Atomic: an interrupted write never leaves a half-written file that would throw the saved answers away.
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(file)}\n`);
      await rename(tmp, path);
    },
    note,
  );
}
