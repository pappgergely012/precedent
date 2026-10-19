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
  /** Ignore comments older than this many days: conventions drift and old reviews mislead. */
  maxAgeDays?: number;
  /** Current time, injectable for tests. */
  now?: Date;
  /** Called with a human-readable status line as the work advances. */
  onProgress?: (message: string) => void;
}

const MIN_BODY_LENGTH = 25;
const DEFAULT_MAX_AGE_DAYS = 730;
/** Confidence is scaled by this when every source comment comes from one reviewer. */
const SINGLE_REVIEWER_FACTOR = 0.75;
/** Candidates merged per model call; larger inputs overflow the output limit. */
const MERGE_BATCH_SIZE = 150;

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

type MergedRule = z.infer<typeof MergedSchema>["rules"][number];

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

/**
 * Merge candidates into rules. Inputs larger than one call can answer are merged
 * in chunks, and the resulting rules are merged again until they fit in a single
 * call, so duplicates across chunks still collapse.
 */
async function mergeCandidates(
  candidates: { id: number; principle: string }[],
  llm: Llm,
  onProgress: (message: string) => void = () => {},
): Promise<MergedRule[]> {
  // First level: ids are real comment ids.
  let rules: MergedRule[] = [];
  let fitsOneCall = candidates.length <= MERGE_BATCH_SIZE;
  const firstChunks = Math.ceil(candidates.length / MERGE_BATCH_SIZE);
  for (let i = 0; i < candidates.length; i += MERGE_BATCH_SIZE) {
    const chunk = candidates.slice(i, i + MERGE_BATCH_SIZE);
    rules.push(...(await llm.parse(mergePrompt(chunk), MergedSchema)).rules);
    onProgress(`Merge level 1: chunk ${i / MERGE_BATCH_SIZE + 1}/${firstChunks} done, ${rules.length} rules so far`);
  }
  let level = 1;
  // Higher levels: each rule is a candidate identified by its index in its chunk.
  while (!fitsOneCall) {
    level++;
    fitsOneCall = rules.length <= MERGE_BATCH_SIZE;
    const sorted = [...rules].sort((a, b) => a.description.localeCompare(b.description));
    const next: MergedRule[] = [];
    for (let i = 0; i < sorted.length; i += MERGE_BATCH_SIZE) {
      const chunk = sorted.slice(i, i + MERGE_BATCH_SIZE);
      const out = await llm.parse(
        mergePrompt(chunk.map((r, index) => ({ id: index, principle: r.description }))),
        MergedSchema,
      );
      for (const m of out.rules) {
        const parts = [...new Set(m.commentIds)].flatMap((index) => (chunk[index] ? [chunk[index]] : []));
        if (parts.length === 0) continue;
        next.push({
          description: m.description,
          scope: m.scope.length ? m.scope : [...new Set(parts.flatMap((r) => r.scope))],
          commentIds: parts.flatMap((r) => r.commentIds),
        });
      }
    }
    onProgress(`Merge level ${level}: ${rules.length} -> ${next.length} rules`);
    // Stop when merging no longer shrinks the list, to avoid looping forever.
    if (next.length >= rules.length) fitsOneCall = true;
    rules = next;
  }
  return rules;
}

const DedupeSchema = z.object({
  groups: z.array(z.array(z.number())),
});

function dedupePrompt(rules: Rule[]): string {
  const lines = rules.map((r, i) => `[${i}] ${r.description}`).join("\n");
  return `Below are coding rules mined from a team's code reviews. Some state the same obligation in different words, or one is a narrower case of another.

Return groups of indices that should be merged into a single rule. Only group rules that a reviewer would treat as the same request; rules about different situations or different obligations must stay separate. Omit rules that have no duplicate. Do not reuse an index in more than one group.

${lines}`;
}

/** Merge rules that restate the same obligation, pooling their sources. */
export async function dedupeRules(rules: Rule[], llm: Llm): Promise<Rule[]> {
  if (rules.length < 2) return rules;
  const { groups } = await llm.parse(dedupePrompt(rules), DedupeSchema);

  const used = new Set<number>();
  const absorbed = new Set<number>();
  const result: Rule[] = [];
  for (const group of groups) {
    const members = [...new Set(group)].filter((i) => rules[i] && !used.has(i));
    if (members.length < 2) continue;
    members.forEach((i) => used.add(i));
    // The rule with the most distinct PRs speaks for the group.
    const [lead, ...rest] = members.map((i) => rules[i]!).sort((a, b) => prCount(b) - prCount(a));
    const sources = new Map(lead!.sources.map((x) => [x.commentUrl, x]));
    for (const r of rest) for (const x of r.sources) sources.set(x.commentUrl, x);
    const merged = [...sources.values()];
    result.push({
      ...lead!,
      scope: [...new Set([lead!, ...rest].flatMap((r) => r.scope))],
      sources: merged,
      confidence: confidenceFor(merged),
    });
    members.forEach((i) => absorbed.add(i));
  }
  rules.forEach((r, i) => {
    if (!absorbed.has(i)) result.push(r);
  });
  return rankRules(result);
}

const prCount = (r: Rule) => new Set(r.sources.map((s) => s.prNumber)).size;
const reviewerCount = (r: Rule) => new Set(r.sources.map((s) => s.reviewer)).size;

/** Distinct PRs / 5, reduced when only one reviewer ever asked for it. */
function confidenceFor(sources: Rule["sources"]): number {
  const base = Math.min(1, new Set(sources.map((s) => s.prNumber)).size / 5);
  return new Set(sources.map((s) => s.reviewer)).size < 2 ? base * SINGLE_REVIEWER_FACTOR : base;
}

function rankRules(rules: Rule[]): Rule[] {
  return [...rules].sort(
    (a, b) =>
      b.confidence - a.confidence ||
      prCount(b) - prCount(a) ||
      reviewerCount(b) - reviewerCount(a) ||
      b.sources.length - a.sources.length,
  );
}

/** True when a rule rests on a single reviewer's taste rather than team consensus. */
export const isSingleReviewer = (r: Rule): boolean => reviewerCount(r) < 2;

/** Turn review comments into rules, citing the comments each rule came from. */
export async function extractRules(
  comments: ReviewComment[],
  llm: Llm,
  opts: ExtractOptions = {},
): Promise<Rule[]> {
  const { batchSize = 40, maxComments = 600, minOccurrences = 2, minPullRequests = 2 } = opts;
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;

  const log = opts.onProgress ?? (() => {});
  const cutoff = new Date((opts.now ?? new Date()).getTime() - maxAgeDays * 86_400_000).toISOString();
  const recent = filterComments(comments).filter((c) => c.createdAt >= cutoff);
  const stale = filterComments(comments).length - recent.length;
  if (stale > 0) log(`Skipped ${stale} comments older than ${maxAgeDays} days`);
  const usable = recent
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, maxComments);
  if (usable.length === 0) return [];
  const byId = new Map(usable.map((c) => [c.id, c]));

  const candidates: { id: number; principle: string }[] = [];
  const batches = Math.ceil(usable.length / batchSize);
  log(`Analysing ${usable.length} of ${comments.length} comments in ${batches} batches`);
  for (let i = 0; i < usable.length; i += batchSize) {
    const out = await llm.parse(principlesPrompt(usable.slice(i, i + batchSize)), PrinciplesSchema);
    for (const item of out.items) {
      if (item.principle && byId.has(item.id)) candidates.push({ id: item.id, principle: item.principle });
    }
    log(`Batch ${i / batchSize + 1}/${batches} done, ${candidates.length} candidate rules so far`);
  }
  if (process.env.PRECEDENT_DEBUG) console.error(`[debug] ${usable.length} usable comments, ${candidates.length} candidate principles`);
  if (candidates.length === 0) return [];

  // Stable input order keeps chunking identical between runs of the same data.
  candidates.sort((a, b) => a.id - b.id);
  log(`Merging ${candidates.length} candidate rules`);
  const merged = await mergeCandidates(candidates, llm, log);
  log(`Merged into ${merged.length} rules`);

  if (process.env.PRECEDENT_DEBUG) {
    console.error(`[debug] merge returned ${merged.length} rules; sizes: ${merged.map((m) => m.commentIds.length).join(",")}`);
  }
  const rules: Rule[] = [];
  let tooFewComments = 0;
  let tooFewPrs = 0;
  merged.forEach((m, index) => {
    const sources = [...new Set(m.commentIds)].flatMap((id) => {
      const c = byId.get(id);
      return c ? [{ prNumber: c.prNumber, commentUrl: c.url, reviewer: c.reviewer }] : [];
    });
    if (sources.length < minOccurrences) {
      tooFewComments++;
      return;
    }
    if (new Set(sources.map((s) => s.prNumber)).size < minPullRequests) {
      tooFewPrs++;
      return;
    }
    rules.push({
      id: `rule-${index + 1}`,
      description: m.description,
      scope: m.scope,
      confidence: confidenceFor(sources),
      sources,
    });
  });
  log(
    `Kept ${rules.length} of ${merged.length} merged rules; dropped ${tooFewComments} with fewer than ${minOccurrences} comments and ${tooFewPrs} with fewer than ${minPullRequests} distinct pull requests`,
  );
  if (rules.length < 2) return rules;
  const deduped = await dedupeRules(rules, llm);
  if (deduped.length < rules.length) log(`Merged ${rules.length - deduped.length} near-duplicate rules`);
  return deduped;
}
