// A deterministic fake model and comment set for the "default output is unchanged" golden test.
// The golden file fixtures/golden-default.json was produced by commit 7f7c3ce (the gate pack commit) with exactly this code.
import { createHash } from "node:crypto";

export const comments = Array.from({ length: 260 }, (_, i) => ({
  id: i + 1,
  prNumber: 1000 + (i % 40),
  reviewer: ["anna", "bob", "cy", "dee"][i % 4]!,
  body: `Please handle case ${i % 13} consistently in module ${i % 7}, as discussed before.`,
  path: `src/mod${i % 7}/file${i % 5}.ts`,
  diffHunk: "@@",
  url: `https://github.com/o/r/pull/${1000 + (i % 40)}#discussion_r${i + 1}`,
  createdAt: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
}));

export const now = new Date(Date.UTC(2026, 9, 19));

type Schema = { safeParse: (v: unknown) => { success: boolean; data?: unknown } };

/** Answers every prompt from its ids; records a hash of each prompt so the exact prompt sequence is pinned. */
export function fakeModel(promptHashes: string[]) {
  return {
    async parse(prompt: string, schema: Schema) {
      promptHashes.push(createHash("sha256").update(prompt).digest("hex").slice(0, 16));
      const ids = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
      const candidates: unknown[] = [
        { items: ids.map((id) => ({ id, principle: id % 3 === 0 ? null : `Handle case ${id % 13} the same way in module ${id % 7}` })) },
        {
          rules: [...new Set(ids.map((id) => id % 13))].map((k) => ({
            description: `Handle case ${k} the same way`,
            scope: [`src/mod${k % 7}/**`],
            commentIds: ids.filter((id) => id % 13 === k),
          })),
        },
        { rules: [] },
        { groups: [] },
      ];
      for (const c of candidates) {
        const r = schema.safeParse(c);
        if (r.success) return r.data;
      }
      throw new Error("no fake answer fits the schema");
    },
  };
}
