import { createHash } from "node:crypto";
import { diffRules } from "./rulediff.js";
import { ruleTier, type Rule } from "./rule.js";

export interface Skipped {
  rule: Rule;
  reason: string;
}

/**
 * A stable id for an approved rule: derived from the review comments it cites, not from the run it came from
 * (run ids are `rule-1`, `rule-2`, ... and collide between runs) and not from the wording (which changes).
 */
export function approvedId(rule: Pick<Rule, "sources">): string {
  const urls = [...new Set(rule.sources.map((s) => s.commentUrl))].sort();
  return `a-${createHash("sha256").update(urls.join("\n")).digest("hex").slice(0, 10)}`;
}

export function selectCandidates(candidates: Rule[], pick: { ids?: string[]; allCore?: boolean }): { chosen: Rule[]; unknown: string[]; duplicateIds: string[] } {
  const byId = new Map(candidates.map((r) => [r.id, r]));
  const counts = new Map<string, number>();
  for (const r of candidates) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  const duplicateIds = (pick.ids ?? []).filter((id) => (counts.get(id) ?? 0) > 1);
  const unknown = (pick.ids ?? []).filter((id) => !byId.has(id));
  const chosen = new Set<Rule>((pick.ids ?? []).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])));
  if (pick.allCore) for (const r of candidates) if (ruleTier(r) === "core") chosen.add(r);
  return { chosen: candidates.filter((r) => chosen.has(r)), unknown, duplicateIds };
}

/**
 * Pin selected candidate rules into the team's approved set. Approved rules are never changed or removed: a candidate
 * that cites mostly the same comments as an approved rule is skipped, whatever its wording. A note is stored on the
 * newly approved rules only. Pure: returns the new set.
 */
export interface ApproveOptions {
  note?: string;
  /** Candidates the person named with `--id`. The others (from `--all-core`) are skipped when they are only "related" to an approved rule. */
  explicit?: Set<Rule>;
  /** Approve related candidates from `--all-core` too. */
  forceRelated?: boolean;
}

export interface Warned {
  rule: Rule;
  relatedTo: Rule;
}

export function approveRules(approved: Rule[], selected: Rule[], opts: ApproveOptions = {}): { rules: Rule[]; added: Rule[]; skipped: Skipped[]; warned: Warned[] } {
  const added: Rule[] = [];
  const skipped: Skipped[] = [];
  const warned: Warned[] = [];
  let rules = [...approved];
  for (const candidate of selected) {
    const pinned: Rule = { ...candidate, id: approvedId(candidate), ...(opts.note ? { note: opts.note } : {}) };
    const d = diffRules(rules, [pinned]);
    const same = [...d.same, ...d.reworded][0];
    if (same) {
      skipped.push({ rule: candidate, reason: `already approved as ${same.approved.id}` });
      continue;
    }
    // Same comments, different wording (or sharing some comments): probably a near-duplicate of an approved rule.
    const near = d.related[0]?.approved ?? d.sharing.get(pinned)?.[0]?.approved;
    if (near) {
      if (!opts.explicit?.has(candidate) && !opts.forceRelated) {
        skipped.push({ rule: candidate, reason: `related to approved ${near.id} (cites the same comments); name it with --id or pass --force-related to approve it anyway` });
        continue;
      }
      warned.push({ rule: candidate, relatedTo: near });
    }
    rules = [...rules, pinned];
    added.push(pinned);
  }
  return { rules, added, skipped, warned };
}
