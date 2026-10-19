import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { RuleSchema, type Rule } from "./rule.js";

/** The file `precedent mine --out` writes and `precedent review` reads. */
export const RulesFileSchema = z.object({
  version: z.literal(1),
  repo: z.string(),
  minedAt: z.string(),
  rules: z.array(RuleSchema),
});

export type RulesFile = z.infer<typeof RulesFileSchema>;

export async function writeRulesFile(path: string, repo: string, rules: Rule[]): Promise<void> {
  const file: RulesFile = { version: 1, repo, minedAt: new Date().toISOString(), rules };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
}

export async function readRulesFile(path: string): Promise<RulesFile> {
  return RulesFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
