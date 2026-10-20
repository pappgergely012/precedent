import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { z } from "zod";
import { RuleSchema, type Rule } from "./rule.js";

/** The file `precedent mine --out` writes and `precedent review` reads. */
export const RulesFileSchema = z.object({
  version: z.literal(1),
  repo: z.string(),
  minedAt: z.string(),
  rules: z.array(RuleSchema),
  /** Rules the guide states that no review evidence backs (only with `mine --docs`). */
  documentedOnly: z.array(z.object({ description: z.string(), path: z.string(), quote: z.string() })).optional(),
});

export type RulesFile = z.infer<typeof RulesFileSchema>;

export async function writeRulesFile(
  path: string,
  repo: string,
  rules: Rule[],
  documentedOnly?: RulesFile["documentedOnly"],
  minedAt: string = new Date().toISOString(),
): Promise<void> {
  const file: RulesFile = { version: 1, repo, minedAt, rules, ...(documentedOnly ? { documentedOnly } : {}) };
  await mkdir(dirname(path), { recursive: true });
  // Atomic: a crash or a full disk never leaves a half-written rules file.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
  await rename(tmp, path);
}

/** True when two paths name the same file, also through symlinks and `./` spellings (a path that does not exist yet is compared as written). */
export function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

export async function readRulesFile(path: string): Promise<RulesFile> {
  const text = await readFile(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON (${(error as Error).message.split("\n")[0]})`);
  }
  const parsed = RulesFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`);
    throw new Error(`${path} is not a rules file: ${issues.join("; ")}`);
  }
  return parsed.data;
}
