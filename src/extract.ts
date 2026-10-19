import { z } from "zod";
import type { ReviewComment } from "./github.js";
import type { Llm } from "./llm.js";
import type { Rule } from "./rule.js";

export interface ExtractOptions {
  /** Comments sent to the model per call. */
  batchSize?: number;
  /** Only the newest N comments are analysed, to bound cost. */
  maxComments?: number;
  /** A rule needs at least this many source comments. */
  minOccurrences?: number;
  /** ...from at least this many distinct pull requests (one PR's style nits are not a team rule). */
  minPullRequests?: number;
}

const MIN_BODY_LENGTH = 25;

/** Keep top-level, substantive comments; replies and one-word approvals carry no rule. */
export function filterComments(comments: ReviewComment[]): ReviewComment[] {
  return comments.filter((c) => c.inReplyTo === undefined && c.body.trim().length >= MIN_BODY_LENGTH);
}

const PrinciplesSchema = z.object({
  items: z.array(z.object({ id: z.number(), principle: z.string().nullable() })),
});

const MergedSchema = z.object({
  rules: z.array(
    z.object({
      description: z.string(),
      scope: z.array(z.string()),
      commentIds: z.array(z.number()),
    }),
  ),
});

function principlesPrompt(batch: ReviewComment[]): string {
  const lines = batch
    .map((c) => `[${c.id}] file: ${c.path}\n${c.body.trim().slice(0, 600)}`)
    .join("\n\n");
  return `You analyse code review comments to find a team's recurring coding rules.

For each comment below, decide whether it expresses a GENERAL, reusable rule (something a reviewer would ask for in many pull requests). If so, give the rule as one short imperative sentence without PR-specific details (for example "Add a rate limit to every new endpoint"). The rule must express exactly ONE obligation.

Return null when the comment is a one-off fix, a question, praise, an explanation of this specific change, or too specific to this change. Also return null for generic engineering advice that would apply to any codebase and that no linter or style guide would be surprised by (for example "keep comments accurate", "use descriptive names", "avoid duplicate code", "add tests"). Keep only rules that encode a convention of THIS project: name the concrete API, module, tool, file kind or situation it applies to.

Return one item per comment, using the same id.

${lines}`;
}

function mergePrompt(principles: { id: number; principle: string }[]): string {
  const lines = principles.map((p) => `[${p.id}] ${p.principle}`).join("\n");
  return `Below are candidate coding rules extracted from different review comments, each tagged with its comment id. Many are phrasings of the same rule.

Merge the ones that mean the same thing into canonical rules. Only merge candidates that state the same single obligation; never combine different obligations into one rule, and keep rules about different situations separate. For each rule return:
- description: one clear imperative sentence
- scope: glob patterns it applies to if obvious from the wording (for example "src/api/**"), otherwise an empty array
- commentIds: ids of every candidate merged into it

Only return rules supported by two or more candidates; omit candidates that match nothing else. Do not invent rules and do not reuse an id in more than one rule.

${lines}`;
}

/** Turn review comments into rules, citing the comments each rule came from. */
export async function extractRules(
  comments: ReviewComment[],
  llm: Llm,
  opts: ExtractOptions = {},
): Promise<Rule[]> {
  const { batchSize = 40, maxComments = 600, minOccurrences = 2, minPullRequests = 2 } = opts;

  const usable = filterComments(comments)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, maxComments);
  if (usable.length === 0) return [];
  const byId = new Map(usable.map((c) => [c.id, c]));

  const candidates: { id: number; principle: string }[] = [];
  for (let i = 0; i < usable.length; i += batchSize) {
    const out = await llm.parse(principlesPrompt(usable.slice(i, i + batchSize)), PrinciplesSchema);
    for (const item of out.items) {
      if (item.principle && byId.has(item.id)) candidates.push({ id: item.id, principle: item.principle });
    }
  }
  if (process.env.PRECEDENT_DEBUG) console.error(`[debug] ${usable.length} usable comments, ${candidates.length} candidate principles`);
  if (candidates.length === 0) return [];

  const merged = await llm.parse(mergePrompt(candidates), MergedSchema);

  if (process.env.PRECEDENT_DEBUG) {
    console.error(`[debug] merge returned ${merged.rules.length} rules; sizes: ${merged.rules.map((m) => m.commentIds.length).join(",")}`);
  }
  const rules: Rule[] = [];
  merged.rules.forEach((m, index) => {
    const sources = [...new Set(m.commentIds)].flatMap((id) => {
      const c = byId.get(id);
      return c ? [{ prNumber: c.prNumber, commentUrl: c.url, reviewer: c.reviewer }] : [];
    });
    if (sources.length < minOccurrences) return;
    const distinctPrs = new Set(sources.map((s) => s.prNumber)).size;
    if (distinctPrs < minPullRequests) return;
    rules.push({
      id: `rule-${index + 1}`,
      description: m.description,
      scope: m.scope,
      confidence: Math.min(1, distinctPrs / 5),
      sources,
    });
  });
  const prCount = (r: Rule) => new Set(r.sources.map((s) => s.prNumber)).size;
  return rules.sort((a, b) => prCount(b) - prCount(a) || b.sources.length - a.sources.length);
}
