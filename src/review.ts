import { z } from "zod";
import type { FileDiff } from "./diff.js";
import { cleanText, SAFE_URL } from "./export.js";
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

/** Expand `{a,b}` alternatives (also nested) into plain globs. */
export function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  if (open === -1) return [glob];
  let depth = 0;
  const cuts: number[] = [];
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth++;
    else if (glob[i] === "}" && --depth === 0) {
      cuts.push(i);
      break;
    } else if (glob[i] === "," && depth === 1) cuts.push(i);
  }
  const close = cuts[cuts.length - 1];
  if (close === undefined || glob[close] !== "}") return [glob];
  const parts: string[] = [];
  let from = open + 1;
  for (const cut of cuts) {
    parts.push(glob.slice(from, cut));
    from = cut + 1;
  }
  return parts.flatMap((part) => expandBraces(glob.slice(0, open) + part + glob.slice(close + 1)));
}

function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${pattern}$`);
}

/**
 * Match a path against a glob where `**` crosses directories and `*` does not. `{a,b}` alternatives are
 * supported, and a leading `./` or `/` on the glob (or the path) is ignored.
 */
export function matchesGlob(glob: string, path: string): boolean {
  const clean = (text: string) => text.replace(/^(?:\.\/|\/)+/, "");
  const target = clean(path);
  return expandBraces(clean(glob)).some((g) => globToRegExp(g).test(target));
}

/**
 * The files to review when there are more than `maxFiles`: the ones with the most added lines (they carry the most
 * code that can break a rule), ties broken by path, then put back in diff order. Deterministic for a given diff.
 */
export function chooseFiles(files: FileDiff[], maxFiles: number): FileDiff[] {
  if (files.length <= maxFiles) return files;
  const keep = new Set(
    [...files]
      .sort((a, b) => b.addedLines.size - a.addedLines.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, maxFiles),
  );
  return files.filter((f) => keep.has(f));
}

/**
 * A rough cost estimate for reviewing `files` (one call per file): about 3.5 characters per token for the patch (cut
 * at 12,000 characters) and the applicable rules, 350 tokens of instructions, and about 120 output tokens per call
 * (an assumption: a short list of findings). Not measured against model usage.
 */
export function estimateReview(files: FileDiff[], rules: Rule[], maxPatchLength = 12000): { calls: number; inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  for (const f of files) {
    const ruleChars = rulesForFile(rules, f.path).reduce((n, r) => n + r.description.length + 8, 0);
    inputTokens += Math.round((Math.min(f.patch.length, maxPatchLength) + ruleChars) / 3.5) + 350;
  }
  return { calls: files.length, inputTokens, outputTokens: files.length * 120 };
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

const MENTION = /(^|[^\w`])@(?=[A-Za-z0-9_])([A-Za-z0-9_/-]+)/g;
const LINK = /\[([^\]]*)\]\((?:[^)]*)\)/g;
const BARE_URL = /\b(?:https?|ftp|javascript|data):[^\s)>\]]*/gi;

/**
 * Text that reaches a public pull request comment from the rule or the model. Rule text comes from review
 * comments and the model's message comes from a model that reads a diff the PR author controls, so both are
 * untrusted: export's cleaner (control and bidi characters, `<`, fences, images, length), plus no links and no
 * mentions (a mention notifies people, a link or image sends the reader or their client to a third party).
 */
export function sanitizeCommentText(text: string, maxChars: number): string {
  const unlinked = text.replace(LINK, "$1").replace(BARE_URL, "[link removed]");
  return cleanText(unlinked, maxChars).replace(MENTION, (_m, before: string, name: string) => `${before}\`@${name}\``);
}

/** The text of one inline comment: what to change, which rule, and where the team asked for it before. */
export function formatComment(violation: Violation, rule: Rule): string {
  const seen = new Set<number>();
  const evidence = rule.sources
    .filter((s) => SAFE_URL.test(s.commentUrl) && !seen.has(s.prNumber) && seen.add(s.prNumber))
    .slice(0, 2)
    .map((s) => `[#${s.prNumber}](${s.commentUrl})`)
    .join(", ");
  const why = evidence ? `Reviewers asked for this before in ${evidence} (${rule.sources.length} comments in total).` : `${rule.sources.length} earlier review comments asked for this.`;
  return `${sanitizeCommentText(violation.message, 300)}\n\n**Team rule:** ${sanitizeCommentText(rule.description, 500)}\n\n${why}`;
}
