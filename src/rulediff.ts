import type { Rule } from "./rule.js";
import { safeLine } from "./terminal.js";

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
  /** Rules with no source comments on either side: nothing to match on, so they are reported, never guessed. */
  unmatchable: Rule[];
  /** For each new candidate that shares at least one comment with an approved rule (below the match threshold). */
  related: Map<Rule, { approved: Rule; shared: number }[]>;
}

export const MIN_SOURCE_OVERLAP = 0.5;

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();

function sharedComments(a: Rule, b: Rule): { shared: number; smaller: number } {
  const urls = new Set(a.sources.map((s) => s.commentUrl));
  const others = new Set(b.sources.map((s) => s.commentUrl));
  const shared = [...others].filter((u) => urls.has(u)).length;
  return { shared, smaller: Math.min(urls.size, others.size) };
}

function overlapOf(a: Rule, b: Rule): number {
  const { shared, smaller } = sharedComments(a, b);
  return smaller === 0 ? 0 : shared / smaller;
}

/**
 * Compare a fresh run with the rules a team already approved, treating the run as a diff and never as a replacement.
 * Rules are matched by the review comments they cite (not by wording, which changes from run to run), one-to-one,
 * best overlap first, ties by id so the result does not depend on input order.
 */
export function diffRules(approved: Rule[], fresh: Rule[]): RuleDiff {
  const unmatchable = [...approved, ...fresh].filter((r) => r.sources.length === 0);
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
  const added = fresh.filter((f) => !usedF.has(f) && f.sources.length > 0);
  const related = new Map<Rule, { approved: Rule; shared: number }[]>();
  for (const f of added) {
    const hits = approved.map((a) => ({ approved: a, shared: sharedComments(a, f).shared })).filter((h) => h.shared > 0).sort((x, y) => y.shared - x.shared);
    if (hits.length > 0) related.set(f, hits);
  }
  return {
    unmatchable,
    related,
    same: matches.filter((m) => norm(m.approved.description) === norm(m.fresh.description)),
    reworded: matches.filter((m) => norm(m.approved.description) !== norm(m.fresh.description)),
    added,
    missing: approved.filter((a) => !usedA.has(a) && a.sources.length > 0),
  };
}

export function renderRuleDiff(diff: RuleDiff): string {
  const lines = [`Compared with the approved rules: ${diff.same.length} unchanged, ${diff.reworded.length} reworded, ${diff.added.length} new, ${diff.missing.length} not found again.`];
  const section = (title: string, items: string[]) => items.length > 0 && lines.push("", `${title}:`, ...items);
  section(
    "New candidates (a person decides)",
    diff.added.flatMap((r) => [
      `  + ${safeLine(r.description)} (${r.sources.length} comments)`,
      ...(diff.related.get(r) ?? []).slice(0, 2).map((h) => `      related to approved: ${safeLine(h.approved.description, 120)} (${h.shared} shared comment${h.shared === 1 ? "" : "s"})`),
    ]),
  );
  section("Reworded (approved text is kept)", diff.reworded.map((m) => `  ~ approved: ${safeLine(m.approved.description)}\n    new run:  ${safeLine(m.fresh.description)}`));
  section("Approved but not found again (keep unless the team retires it)", diff.missing.map((r) => `  - ${safeLine(r.description)}`));
  section("Cannot be matched (no source comments)", diff.unmatchable.map((r) => `  ? ${safeLine(r.description)}`));
  return lines.join("\n");
}
