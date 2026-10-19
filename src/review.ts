import { z } from "zod";
import type { FileDiff } from "./diff.js";
import type { Llm } from "./llm.js";
import type { Rule } from "./rule.js";

export interface Violation {
  ruleId: string;
  path: string;
  line: number;
  message: string;
}

export interface ReviewOptions {
  /** Longest patch (in characters) sent to the model for one file. */
  maxPatchLength?: number;
  /** Called with a human-readable status line as the work advances. */
  onProgress?: (message: string) => void;
}

const FindingsSchema = z.object({
  findings: z.array(z.object({ ruleId: z.string(), line: z.number(), message: z.string() })),
});

/** Match a path against a glob where `**` crosses directories and `*` does not. */
export function matchesGlob(glob: string, path: string): boolean {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${pattern}$`).test(path);
}

export function rulesForFile(rules: Rule[], path: string): Rule[] {
  return rules.filter((r) => r.scope.length === 0 || r.scope.some((g) => matchesGlob(g, path)));
}

function reviewPrompt(file: FileDiff, rules: Rule[], maxPatchLength: number): string {
  const ruleLines = rules.map((r) => `[${r.id}] ${r.description}`).join("\n");
  const patch = file.patch.length > maxPatchLength ? `${file.patch.slice(0, maxPatchLength)}\n... (truncated)` : file.patch;
  return `You review a pull request against a team's established review rules. Report a finding only when an ADDED line in the diff clearly breaks one of the rules. Be conservative: if a rule is not clearly violated, or the rule does not apply to this kind of change, report nothing.

Rules:
${ruleLines}

Diff of ${file.path}. Lines starting with "N: +" are added lines and N is their line number; "N:  " are unchanged context and "   -" are removed lines.

${patch}

For each finding return the rule id, the line number N of the offending added line, and one short sentence saying what to change in this code (not a restatement of the rule).`;
}

/**
 * Check a pull request diff against mined rules. Findings that point at lines the
 * PR did not add, or at unknown rules, are dropped. Each rule is reported at most
 * once per PR so a repeated pattern does not turn into spam.
 */
export async function reviewDiff(
  files: FileDiff[],
  rules: Rule[],
  llm: Llm,
  opts: ReviewOptions = {},
): Promise<Violation[]> {
  const { maxPatchLength = 12000, onProgress = () => {} } = opts;
  const byId = new Map(rules.map((r) => [r.id, r]));
  const violations: Violation[] = [];

  for (const [index, file] of files.entries()) {
    const applicable = rulesForFile(rules, file.path);
    if (applicable.length === 0) continue;
    const allowed = new Set(applicable.map((r) => r.id));
    const out = await llm.parse(reviewPrompt(file, applicable, maxPatchLength), FindingsSchema);
    for (const f of out.findings) {
      if (!allowed.has(f.ruleId) || !file.addedLines.has(f.line) || f.message.trim() === "") continue;
      violations.push({ ruleId: f.ruleId, path: file.path, line: f.line, message: f.message.trim() });
    }
    onProgress(`File ${index + 1}/${files.length} (${file.path}): ${violations.length} findings so far`);
  }

  const seen = new Set<string>();
  return violations
    .sort((a, b) => (byId.get(b.ruleId)?.confidence ?? 0) - (byId.get(a.ruleId)?.confidence ?? 0))
    .filter((v) => (seen.has(v.ruleId) ? false : (seen.add(v.ruleId), true)));
}

/** The text of one inline comment: what to change, which rule, and where the team asked for it before. */
export function formatComment(violation: Violation, rule: Rule): string {
  const evidence = rule.sources.slice(0, 2).map((s) => `[#${s.prNumber}](${s.commentUrl})`).join(", ");
  return `${violation.message}\n\n**Team rule:** ${rule.description}\n\nReviewers asked for this before in ${evidence} (${rule.sources.length} comments in total).`;
}
