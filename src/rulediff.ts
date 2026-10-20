import type { Rule } from "./rule.js";

export interface RuleMatch {
  approved: Rule;
  fresh: Rule;
  /** Share of the smaller rule's source comments that both rules cite. */
  overlap: number;
}

export interface RuleDiff {
  /** Same rule, same wording: nothing to review. */
  same: RuleMatch[];
  /** Same evidence, different wording: the approved text stays; a person decides whether to adopt the new one. */
  reworded: RuleMatch[];
  /** Not in the approved set: candidates for a person to approve. */
  added: Rule[];
  /** Approved, but this run did not find it again. Not a reason to remove it. */
  missing: Rule[];
}

export const MIN_SOURCE_OVERLAP = 0.5;

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();

function overlapOf(a: Rule, b: Rule): number {
  const urls = new Set(a.sources.map((s) => s.commentUrl));
  const shared = new Set(b.sources.filter((s) => urls.has(s.commentUrl)).map((s) => s.commentUrl)).size;
  return shared / Math.min(urls.size, new Set(b.sources.map((s) => s.commentUrl)).size);
}

/**
 * Compare a fresh run with the rules a team already approved, treating the run as a diff and never as a replacement.
 * Rules are matched by the review comments they cite (not by wording, which changes from run to run), one-to-one,
 * best overlap first, ties by id so the result does not depend on input order.
 */
export function diffRules(approved: Rule[], fresh: Rule[]): RuleDiff {
  const pairs: RuleMatch[] = [];
  for (const a of approved) for (const f of fresh) {
    const overlap = overlapOf(a, f);
    if (overlap >= MIN_SOURCE_OVERLAP) pairs.push({ approved: a, fresh: f, overlap });
  }
  pairs.sort((x, y) => y.overlap - x.overlap || x.approved.id.localeCompare(y.approved.id) || x.fresh.id.localeCompare(y.fresh.id));
  const usedA = new Set<Rule>();
  const usedF = new Set<Rule>();
  const matches: RuleMatch[] = [];
  for (const p of pairs) {
    if (usedA.has(p.approved) || usedF.has(p.fresh)) continue;
    usedA.add(p.approved);
    usedF.add(p.fresh);
    matches.push(p);
  }
  return {
    same: matches.filter((m) => norm(m.approved.description) === norm(m.fresh.description)),
    reworded: matches.filter((m) => norm(m.approved.description) !== norm(m.fresh.description)),
    added: fresh.filter((f) => !usedF.has(f)),
    missing: approved.filter((a) => !usedA.has(a)),
  };
}

export function renderRuleDiff(diff: RuleDiff): string {
  const lines = [`Compared with the approved rules: ${diff.same.length} unchanged, ${diff.reworded.length} reworded, ${diff.added.length} new, ${diff.missing.length} not found again.`];
  const section = (title: string, items: string[]) => items.length > 0 && lines.push("", `${title}:`, ...items);
  section("New candidates (a person decides)", diff.added.map((r) => `  + ${r.description} (${r.sources.length} comments)`));
  section("Reworded (approved text is kept)", diff.reworded.map((m) => `  ~ approved: ${m.approved.description}\n    new run:  ${m.fresh.description}`));
  section("Approved but not found again (keep unless the team retires it)", diff.missing.map((r) => `  - ${r.description}`));
  return lines.join("\n");
}
