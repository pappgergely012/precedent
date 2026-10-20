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
  /** Same evidence, similar wording: the approved text stays; a person decides whether to adopt the new one. */
  reworded: RuleMatch[];
  /**
   * Same evidence, different wording. Usually a rewording, sometimes a different rule that cites the same comments;
   * no word-overlap threshold separates the two, so a person decides. Counted neither as new nor as missing.
   */
  related: RuleMatch[];
  /** Not in the approved set: candidates for a person to approve. */
  added: Rule[];
  /** Approved, but this run did not find it again. Not a reason to remove it. */
  missing: Rule[];
  /** Rules with no source comments on either side: nothing to match on, so they are reported, never guessed. */
  unmatchable: Rule[];
  /** For each new candidate that shares at least one comment with an approved rule (below the match threshold). */
  sharing: Map<Rule, { approved: Rule; shared: number }[]>;
}

export const MIN_SOURCE_OVERLAP = 0.5;
/** Wording this close (shared words / all words) with the same evidence counts as the same rule, reworded. */
export const MIN_WORDING_SIMILARITY = 0.5;

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);

export function wordingSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const union = new Set([...x, ...y]).size;
  return union === 0 ? 0 : [...x].filter((w) => y.has(w)).length / union;
}

const noteOf = (r: Rule) => (r.note ? ` [note: ${safeLine(r.note, 120)}]` : "");

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
  const sharing = new Map<Rule, { approved: Rule; shared: number }[]>();
  for (const f of added) {
    const hits = approved.map((a) => ({ approved: a, shared: sharedComments(a, f).shared })).filter((h) => h.shared > 0).sort((x, y) => y.shared - x.shared);
    if (hits.length > 0) sharing.set(f, hits);
  }
  return {
    unmatchable,
    sharing,
    same: matches.filter((m) => norm(m.approved.description) === norm(m.fresh.description)),
    reworded: matches.filter((m) => norm(m.approved.description) !== norm(m.fresh.description) && wordingSimilarity(m.approved.description, m.fresh.description) >= MIN_WORDING_SIMILARITY),
    related: matches.filter((m) => norm(m.approved.description) !== norm(m.fresh.description) && wordingSimilarity(m.approved.description, m.fresh.description) < MIN_WORDING_SIMILARITY),
    added,
    missing: approved.filter((a) => !usedA.has(a) && a.sources.length > 0),
  };
}

export function renderRuleDiff(diff: RuleDiff): string {
  const lines = [`Compared with the approved rules: ${diff.same.length} unchanged, ${diff.reworded.length} reworded, ${diff.related.length} related, ${diff.added.length} new, ${diff.missing.length} not found again.`];
  const section = (title: string, items: string[]) => items.length > 0 && lines.push("", `${title}:`, ...items);
  section(
    "New candidates (a person decides)",
    diff.added.flatMap((r) => [
      `  + ${safeLine(r.description)} (${r.sources.length} comments)`,
      ...(diff.sharing.get(r) ?? []).slice(0, 2).map((h) => `      related to approved: ${safeLine(h.approved.description, 120)} (${h.shared} shared comment${h.shared === 1 ? "" : "s"})`),
    ]),
  );
  section("Reworded (approved text is kept)", diff.reworded.map((m) => `  ~ approved: ${safeLine(m.approved.description)}${noteOf(m.approved)}\n    new run:  ${safeLine(m.fresh.description)}`));
  section("Related: same evidence, different wording (decide if it is the same rule)", diff.related.map((m) => `  ? approved: ${safeLine(m.approved.description)}${noteOf(m.approved)}\n    new run:  ${safeLine(m.fresh.description)} (${Math.round(m.overlap * 100)}% of comments shared)`));
  section("Approved but not found again (keep unless the team retires it)", diff.missing.map((r) => `  - ${safeLine(r.description)}${noteOf(r)}`));
  section("Cannot be matched (no source comments)", diff.unmatchable.map((r) => `  ! ${safeLine(r.description)}`));
  return lines.join("\n");
}
