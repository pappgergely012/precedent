import { isSingleReviewer } from "./extract.js";
import { ruleTier, type Rule } from "./rule.js";

export interface MineOutputOptions {
  /** List the emerging candidates too. */
  all?: boolean;
  /** Rules listed per section. */
  top?: number;
}

function ruleLines(rule: Rule, index: number): string[] {
  const scope = rule.scope.length ? ` (${rule.scope.join(", ")})` : "";
  const flag = isSingleReviewer(rule) ? ", single reviewer" : "";
  const lines = [`\n${index}. ${rule.description}${scope}`, `   confidence ${rule.confidence.toFixed(2)}, ${rule.sources.length} comments${flag}:`];
  for (const s of rule.sources.slice(0, 3)) lines.push(`   - #${s.prNumber} @${s.reviewer} ${s.commentUrl}`);
  const ref = rule.docRefs?.[0];
  if (rule.origin === "both" && ref) lines.push(`   documented in ${ref.path}: "${ref.quote.slice(0, 120)}"`);
  else if (rule.origin === "conflict" && ref) lines.push(`   POSSIBLE CONFLICT with ${ref.path}: "${ref.quote.slice(0, 120)}"`);
  else if (rule.origin === "enforced") lines.push("   enforced in reviews, not written in the guide");
  return lines;
}

/**
 * What `mine` prints. The headline is the core tier: rules with 3+ comments from 2+ reviewers,
 * the same definition `stability` measures. Candidates with thinner evidence are counted, and
 * listed only on request, so the default output is the part with the most evidence behind it.
 */
export function renderMineOutput(rules: Rule[], opts: MineOutputOptions = {}): string[] {
  const { all = false, top = 10 } = opts;
  const core = rules.filter((r) => ruleTier(r) === "core");
  const emerging = rules.filter((r) => ruleTier(r) === "emerging");
  const out: string[] = [];

  out.push(`${core.length} core rules (3+ comments from 2+ reviewers) and ${emerging.length} emerging candidates (thinner evidence).`);
  if (core.length === 0) {
    out.push(emerging.length > 0 ? "No core rules were found." : "No recurring rules found.");
  } else {
    out.push(core.length > top ? `\nCore rules (top ${top} of ${core.length}):` : "\nCore rules:");
    core.slice(0, top).forEach((r, i) => out.push(...ruleLines(r, i + 1)));
  }

  if (emerging.length > 0) {
    if (all) {
      out.push(emerging.length > top ? `\nEmerging candidates (top ${top} of ${emerging.length}); thinner evidence, the first to change when you mine again:` : "\nEmerging candidates (thinner evidence, the first to change when you mine again):");
      emerging.slice(0, top).forEach((r, i) => out.push(...ruleLines(r, i + 1)));
    } else {
      out.push(`\n${emerging.length} emerging candidates not shown. Add --all to list them; --out saves every rule.`);
    }
  }
  return out;
}
