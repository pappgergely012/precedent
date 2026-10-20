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

export function selectCandidates(candidates: Rule[], pick: { ids?: string[]; allCore?: boolean }): { chosen: Rule[]; unknown: string[] } {
  const byId = new Map(candidates.map((r) => [r.id, r]));
  const unknown = (pick.ids ?? []).filter((id) => !byId.has(id));
  const chosen = new Set<Rule>((pick.ids ?? []).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])));
  if (pick.allCore) for (const r of candidates) if (ruleTier(r) === "core") chosen.add(r);
  return { chosen: candidates.filter((r) => chosen.has(r)), unknown };
}

/**
 * Pin selected candidate rules into the team's approved set. Approved rules are never changed or removed: a candidate
 * that cites mostly the same comments as an approved rule is skipped, whatever its wording. Pure: returns the new set.
 */
export function approveRules(approved: Rule[], selected: Rule[]): { rules: Rule[]; added: Rule[]; skipped: Skipped[] } {
  const added: Rule[] = [];
  const skipped: Skipped[] = [];
  let rules = [...approved];
  for (const candidate of selected) {
    const pinned: Rule = { ...candidate, id: approvedId(candidate) };
    const same = diffRules(rules, [pinned]);
    const match = [...same.same, ...same.reworded][0];
    if (match) {
      skipped.push({ rule: candidate, reason: `already approved as ${match.approved.id}` });
      continue;
    }
    rules = [...rules, pinned];
    added.push(pinned);
  }
  return { rules, added, skipped };
}
