// Small lexical helpers shared by `--docs` pairing and the pre-merge of candidate principles.
// Pure functions of the texts: no model, no randomness.

const STOP = new Set(["a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "when", "with", "that", "is", "are", "be", "not", "do", "does", "it", "its", "as", "at", "by", "from", "this", "than", "instead", "rather", "should", "must", "always", "never", "use", "add", "each", "every", "new"]);

/**
 * Lower-cased content words with a crude plural/-ing stem, so "tests" and "test" meet. Identifiers
 * are split at camelCase boundaries and runs of one letter are shortened ("XXXX" and "XX" are the
 * same placeholder), so RemovedInDjangoXXWarning and RemovedInDjangoXXXXWarning share their words.
 */
export const words = (text: string): Set<string> =>
  new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map((t) => t.replace(/(.)\1{2,}/g, "$1$1"))
      .filter((t) => t.length > 1 && !STOP.has(t))
      .map((t) => (t.length > 3 ? t.replace(/(ing|es|s)$/, "") : t)),
  );

/** Shared content words as a share of the shorter text, and how many there are. */
export function wordOverlap(a: string, b: string): { share: number; shared: number } {
  const wa = words(a);
  const wb = words(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return { share: shared / Math.max(1, Math.min(wa.size, wb.size)), shared };
}

/** Inverse document frequency over a set of texts: words that few texts use say more about a pair. */
export function idfOf(texts: string[]): (word: string) => number {
  const df = new Map<string, number>();
  for (const t of texts) for (const w of words(t)) df.set(w, (df.get(w) ?? 0) + 1);
  return (w) => Math.log(1 + texts.length / (df.get(w) ?? 1));
}

/** Weight of the words two texts share, as a share of the lighter text's total weight. */
export function weightedOverlap(a: Set<string>, b: Set<string>, idf: (w: string) => number): number {
  let shared = 0;
  let wa = 0;
  let wb = 0;
  for (const w of a) wa += idf(w);
  for (const w of b) wb += idf(w);
  for (const w of a) if (b.has(w)) shared += idf(w);
  const base = Math.min(wa, wb);
  return base === 0 ? 0 : shared / base;
}

/** Shared content words over all content words of both texts (1 = same words). */
export function wordJaccard(a: string, b: string): { jaccard: number; shared: number } {
  const wa = words(a);
  const wb = words(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  const union = wa.size + wb.size - shared;
  return { jaccard: union === 0 ? 0 : shared / union, shared };
}
