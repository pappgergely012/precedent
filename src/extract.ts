import { dropReason } from "./rulefilter.js";
import { z } from "zod";
import type { ReviewComment } from "./github.js";
import type { PrincipleCache } from "./cache.js";
import { wordJaccard } from "./lexical.js";
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
  /** Prefer comments newer than this many days: conventions drift and old reviews mislead. */
  maxAgeDays?: number;
  /**
   * The age cutoff never leaves fewer than this many usable comments: slow, long-lived repos
   * would otherwise lose the evidence for conventions that are still in force.
   */
  minRecentComments?: number;
  /** Extraction batches sent to the model at the same time. */
  concurrency?: number;
  /**
   * Group candidate principles that are worded almost identically before the model merges them,
   * so those groups are a function of the text and not of one model sample. Off by default.
   */
  preMerge?: boolean;
  /** Per-comment answers from earlier runs; comments found in it are not sent to the model again. */
  cache?: PrincipleCache;
  /** Current time, injectable for tests. */
  now?: Date;
  /** Called with a human-readable status line as the work advances. */
  onProgress?: (message: string) => void;
}

const MIN_BODY_LENGTH = 25;
const DEFAULT_MAX_AGE_DAYS = 730;
const DEFAULT_MIN_RECENT_COMMENTS = 300;
/** Confidence is scaled by this when every source comment comes from one reviewer. */
const SINGLE_REVIEWER_FACTOR = 0.5;
/** Candidates merged per model call; larger inputs overflow the output limit. */
const MERGE_BATCH_SIZE = 150;

const normalizeBody = (body: string) => body.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Keep top-level, substantive review comments. Replies and one-word approvals carry no rule,
 * a PR author describing their own change is not a reviewer asking for something, and the
 * same text posted twice by one reviewer on one PR is one piece of evidence, not two.
 */
export function filterComments(comments: ReviewComment[]): ReviewComment[] {
  const seen = new Set<string>();
  return comments.filter((c) => {
    if (c.inReplyTo !== undefined || c.byPullRequestAuthor) return false;
    if (c.body.trim().length < MIN_BODY_LENGTH) return false;
    const key = `${c.reviewer}|${c.prNumber}|${normalizeBody(c.body)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

/** Exactly what the model sees of one comment; also what the cache is keyed on. */
export const commentText = (c: ReviewComment) => `file: ${c.path}\n${c.body.trim().slice(0, 600)}`;

function principlesPrompt(batch: ReviewComment[]): string {
  const lines = batch.map((c) => `[${c.id}] ${commentText(c)}`).join("\n\n");
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
export async function mergeCandidates(
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
      const grouped = new Set<number>();
      for (const m of out.rules) {
        const indices = [...new Set(m.commentIds)].filter((index) => chunk[index] && !grouped.has(index));
        const parts = indices.map((index) => chunk[index]!);
        if (parts.length === 0) continue;
        indices.forEach((index) => grouped.add(index));
        next.push({
          description: m.description,
          scope: m.scope.length ? m.scope : [...new Set(parts.flatMap((r) => r.scope))],
          commentIds: parts.flatMap((r) => r.commentIds),
        });
      }
      // The prompt only asks for groups, so a rule with no partner in this chunk is not in
      // the answer. It is still a rule with its own evidence: carry it through unchanged.
      chunk.forEach((r, index) => {
        if (!grouped.has(index)) next.push(r);
      });
    }
    onProgress(`Merge level ${level}: ${rules.length} -> ${next.length} rules`);
    // Stop when merging no longer shrinks the list, to avoid looping forever.
    if (next.length >= rules.length) fitsOneCall = true;
    rules = next;
  }
  return rules;
}

/** Clusters of candidates (as lists of comment ids) with near-identical principles, at most `maxSize` each. */
export function preClusters(
  candidates: { id: number; principle: string }[],
  opts: { minJaccard?: number; minShared?: number; maxSize?: number } = {},
): number[][] {
  const { minJaccard = 0.7, minShared = 3, maxSize = 8 } = opts;
  const pairs: { a: number; b: number; s: number }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const { jaccard, shared } = wordJaccard(candidates[i]!.principle, candidates[j]!.principle);
      if (jaccard >= minJaccard && shared >= minShared) pairs.push({ a: i, b: j, s: jaccard });
    }
  }
  // Closest pairs first; a union that would make a cluster larger than maxSize is skipped.
  pairs.sort((x, y) => y.s - x.s || x.a - y.a || x.b - y.b);
  const parent = candidates.map((_, i) => i);
  const size = candidates.map(() => 1);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  for (const { a, b } of pairs) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb || size[ra]! + size[rb]! > maxSize) continue;
    parent[ra] = rb;
    size[rb]! += size[ra]!;
  }
  const groups = new Map<number, number[]>();
  candidates.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(c.id);
  });
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort((x, y) => x - y));
}

/**
 * Merge with the near-identical candidates pre-grouped: the model sees one representative (the
 * member with the lowest comment id) per cluster plus the remaining candidates, and its groups
 * are expanded back to every member. A cluster the model does not group with anything stays a
 * rule of its own, since it already has two or more comments.
 */
export async function mergeWithPreClusters(
  candidates: { id: number; principle: string }[],
  llm: Llm,
  onProgress: (message: string) => void = () => {},
): Promise<MergedRule[]> {
  const clusters = preClusters(candidates);
  if (clusters.length === 0) return mergeCandidates(candidates, llm, onProgress);
  const membersOf = new Map(clusters.map((c) => [c[0]!, c]));
  const absorbed = new Set(clusters.flatMap((c) => c.slice(1)));
  const principleOf = new Map(candidates.map((c) => [c.id, c.principle]));
  const representatives = candidates.filter((c) => !absorbed.has(c.id));
  onProgress(`Pre-merged ${clusters.length} clusters of near-identical candidates (${absorbed.size} candidates folded into their representatives)`);

  const merged = await mergeCandidates(representatives, llm, onProgress);
  const expand = (ids: number[]) => ids.flatMap((id) => membersOf.get(id) ?? [id]);
  const used = new Set<number>();
  const out: MergedRule[] = merged.map((m) => {
    m.commentIds.forEach((id) => used.add(id));
    return { ...m, commentIds: [...new Set(expand(m.commentIds))] };
  });
  for (const c of clusters) {
    if (!used.has(c[0]!)) out.push({ description: principleOf.get(c[0]!)!, scope: [], commentIds: c });
  }
  return out;
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

const SupportSchema = z.object({
  rules: z.array(
    z.object({
      index: z.number(),
      /** Ids of the comments that each clearly state this rule as a general requirement. */
      supportingIds: z.array(z.number()),
      /** Narrower wording, only when the rule text claims more than the supporting comments say. */
      revisedDescription: z.string().nullable(),
    }),
  ),
});

const SUPPORT_BATCH_SIZE = 8;
const SUPPORT_COMMENT_CHARS = 500;

function supportPrompt(rules: Rule[], byId: Map<number, ReviewComment>): string {
  const blocks = rules
    .map((r, i) => {
      const comments = r.sources
        .map((s) => idOfUrl(s.commentUrl))
        .flatMap((id) => (id !== undefined && byId.has(id) ? [byId.get(id)!] : []))
        .map((c) => `  [${c.id}] ${c.path}: ${c.body.trim().replace(/\s+/g, " ").slice(0, SUPPORT_COMMENT_CHARS)}`)
        .join("\n");
      return `Rule ${i}: ${r.description}\nComments:\n${comments}`;
    })
    .join("\n\n");
  return `You audit rules mined from code review comments. For each rule, decide which of its comments each independently support the rule as worded.

A comment supports a rule only if the reviewer asks for the same thing the rule states, as a general expectation. Do NOT count a comment that:
- is a one-time exception, a backport remark, a special case, or a trivial optimisation note
- is about a narrower language, framework, directory or situation than the rule claims
- only mentions the topic without asking for the rule's behaviour

If the supporting comments agree on a narrower scope than the rule text claims (for example the rule says Flow but they discuss TypeScript, or says "all packages" but they discuss one), return a revisedDescription that states exactly that narrower scope, as one imperative sentence. Otherwise return null.

Return one entry per rule, using its index. List only the supporting comment ids.

${blocks}`;
}

/** The comment id embedded in a `#discussion_r<id>` url. */
const idOfUrl = (url: string): number | undefined => {
  const m = /#discussion_r(\d+)$/.exec(url);
  return m ? Number(m[1]) : undefined;
};

/**
 * Accuracy pass: keep only the sources that really support each rule, narrow rule text that
 * claims more than its evidence, and drop rules left with too little evidence.
 */
export async function auditSupport(
  rules: Rule[],
  byId: Map<number, ReviewComment>,
  llm: Llm,
  opts: { minOccurrences: number; minPullRequests: number },
): Promise<{ rules: Rule[]; dropped: number }> {
  const out: Rule[] = [];
  let dropped = 0;
  for (let i = 0; i < rules.length; i += SUPPORT_BATCH_SIZE) {
    const batch = rules.slice(i, i + SUPPORT_BATCH_SIZE);
    const verdicts = new Map((await llm.parse(supportPrompt(batch, byId), SupportSchema)).rules.map((v) => [v.index, v]));
    batch.forEach((rule, index) => {
      const verdict = verdicts.get(index);
      // No verdict means the model skipped the rule; keep it unaudited rather than lose it silently.
      if (!verdict) return void out.push(rule);
      const supporting = new Set(verdict.supportingIds);
      const sources = rule.sources.filter((s) => {
        const id = idOfUrl(s.commentUrl);
        return id !== undefined && supporting.has(id);
      });
      if (sources.length < opts.minOccurrences || new Set(sources.map((s) => s.prNumber)).size < opts.minPullRequests) {
        dropped++;
        return;
      }
      out.push({
        ...rule,
        description: verdict.revisedDescription?.trim() || rule.description,
        sources,
        confidence: confidenceFor(sources),
      });
    });
  }
  return { rules: out, dropped };
}

/** Merge rules whose evidence is mostly the same comments: they are one rule worded twice. */
export function mergeSharedSources(rules: Rule[], threshold = 0.5): Rule[] {
  const ranked = rankRules(rules);
  const kept: Rule[] = [];
  for (const rule of ranked) {
    const urls = new Set(rule.sources.map((s) => s.commentUrl));
    const twin = kept.find((k) => {
      const shared = k.sources.filter((s) => urls.has(s.commentUrl)).length;
      return shared / Math.min(k.sources.length, urls.size) >= threshold;
    });
    if (!twin) {
      kept.push(rule);
      continue;
    }
    const pooled = new Map(twin.sources.map((s) => [s.commentUrl, s]));
    for (const s of rule.sources) pooled.set(s.commentUrl, s);
    twin.sources = [...pooled.values()];
    twin.scope = [...new Set([...twin.scope, ...rule.scope])];
    twin.confidence = confidenceFor(twin.sources);
  }
  return rankRules(kept);
}

/** What happened on the way to the result, so an empty result can say why. */
interface RunStats {
  fetched: number;
  usable: number;
  skippedStale: number;
  keptDespiteAge: number;
  candidates: number;
  merged: number;
  droppedByThreshold: number;
  droppedByAudit: number;
}

/** Run `task` over `items` with at most `limit` in flight; results keep the input order. */
async function mapPool<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Why no rules came out, and what to try. */
function emptyResultHint(stats: RunStats, opts: { maxAgeDays: number; minOccurrences: number; minPullRequests: number }): string {
  if (stats.usable === 0) {
    return stats.fetched === 0
      ? "No review comments were found. The repository may have no reviewed pull requests, or the token cannot see them."
      : `None of the ${stats.fetched} fetched comments is a usable top-level review comment (the rest are replies, short, by the PR author or older than ${opts.maxAgeDays} days). Try --max-age-days ${opts.maxAgeDays * 5}.`;
  }
  if (stats.candidates === 0) {
    return `${stats.usable} comments were analysed but none states a general, project-specific rule. This repository's reviews may be mostly one-off remarks.`;
  }
  if (stats.merged === 0 || stats.droppedByThreshold >= stats.merged) {
    return `${stats.candidates} candidate rules were found but none recurs in ${opts.minOccurrences}+ comments from ${opts.minPullRequests}+ pull requests. Try --min-occurrences 1 to see single-comment candidates, or analyse more history with --max-comments.`;
  }
  return `${stats.merged} merged rules were found but the audit judged none supported by the comments it cites.`;
}

/** Turn review comments into rules, citing the comments each rule came from. */
export async function extractRules(
  comments: ReviewComment[],
  llm: Llm,
  opts: ExtractOptions = {},
): Promise<Rule[]> {
  const stats: RunStats = { fetched: comments.length, usable: 0, skippedStale: 0, keptDespiteAge: 0, candidates: 0, merged: 0, droppedByThreshold: 0, droppedByAudit: 0 };
  const rules = await mineRules(comments, llm, opts, stats);
  if (rules.length === 0) {
    (opts.onProgress ?? (() => {}))(
      `Hint: ${emptyResultHint(stats, {
        maxAgeDays: opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
        minOccurrences: opts.minOccurrences ?? 2,
        minPullRequests: opts.minPullRequests ?? 2,
      })}`,
    );
  }
  return rules;
}

/**
 * The comments worth analysing: usable top-level review comments, newest first, restricted to the
 * last `maxAgeDays` unless that leaves fewer than `minRecent`, in which case the newest `minRecent`
 * are kept so a quiet repository's history is not thrown away.
 */
export function selectKept(
  comments: ReviewComment[],
  opts: { maxAgeDays: number; minRecent: number; now?: Date },
): { all: ReviewComment[]; withinAge: ReviewComment[]; kept: ReviewComment[] } {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - opts.maxAgeDays * 86_400_000).toISOString();
  const all = filterComments(comments).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const withinAge = all.filter((c) => c.createdAt >= cutoff);
  const kept = withinAge.length >= opts.minRecent ? withinAge : all.slice(0, Math.min(all.length, opts.minRecent));
  return { all, withinAge, kept };
}

/** The comments `extractRules` would send to the model for these options, newest first. */
export function selectUsable(comments: ReviewComment[], opts: ExtractOptions = {}): ReviewComment[] {
  const { kept } = selectKept(comments, {
    maxAgeDays: opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS,
    minRecent: opts.minRecentComments ?? DEFAULT_MIN_RECENT_COMMENTS,
    now: opts.now,
  });
  return kept.slice(0, opts.maxComments ?? 600);
}

async function mineRules(comments: ReviewComment[], llm: Llm, opts: ExtractOptions, stats: RunStats): Promise<Rule[]> {
  const { batchSize = 40, maxComments = 600, minOccurrences = 2, minPullRequests = 2 } = opts;
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const minRecent = opts.minRecentComments ?? DEFAULT_MIN_RECENT_COMMENTS;
  const concurrency = opts.concurrency ?? 4;

  const log = opts.onProgress ?? (() => {});
  const { all, withinAge, kept } = selectKept(comments, { maxAgeDays, minRecent, now: opts.now });
  stats.skippedStale = all.length - kept.length;
  stats.keptDespiteAge = kept.length - withinAge.length;
  if (stats.skippedStale > 0) log(`Skipped ${stats.skippedStale} comments older than ${maxAgeDays} days`);
  if (stats.keptDespiteAge > 0) {
    log(`Only ${withinAge.length} comments are newer than ${maxAgeDays} days; keeping the ${kept.length} newest so the history is not too thin`);
  }
  const usable = kept.slice(0, maxComments);
  stats.usable = usable.length;
  if (usable.length === 0) return [];
  const byId = new Map(usable.map((c) => [c.id, c]));

  const candidates: { id: number; principle: string }[] = [];
  const cache = opts.cache;
  const pending: ReviewComment[] = [];
  for (const c of usable) {
    const cached = cache?.get(c.id, commentText(c));
    if (cached === undefined) pending.push(c);
    else if (cached !== null) candidates.push({ id: c.id, principle: cached });
  }
  if (cache) log(`${usable.length - pending.length} of ${usable.length} comments answered from the cache`);

  const batchList = Array.from({ length: Math.ceil(pending.length / batchSize) }, (_, i) => pending.slice(i * batchSize, (i + 1) * batchSize));
  log(`Analysing ${pending.length} of ${comments.length} comments in ${batchList.length} batches`);
  let done = 0;
  const outputs = await mapPool(batchList, concurrency, async (batch) => {
    const out = await llm.parse(principlesPrompt(batch), PrinciplesSchema);
    log(`Batch ${++done}/${batchList.length} done`);
    return { batch, out };
  });
  for (const { batch, out } of outputs) {
    const answered = new Map(out.items.map((item) => [item.id, item.principle]));
    for (const c of batch) {
      // A comment the model skipped is not cached: it was not judged, so ask again next time.
      if (!answered.has(c.id)) continue;
      const principle = answered.get(c.id) ?? null;
      cache?.set(c.id, commentText(c), principle);
      if (principle) candidates.push({ id: c.id, principle });
    }
  }
  await cache?.save();
  stats.candidates = candidates.length;
  log(`${candidates.length} candidate rules found`);
  if (process.env.PRECEDENT_DEBUG) console.error(`[debug] ${usable.length} usable comments, ${candidates.length} candidate principles`);
  if (candidates.length === 0) return [];

  // Stable input order keeps chunking identical between runs of the same data.
  candidates.sort((a, b) => a.id - b.id);
  log(`Merging ${candidates.length} candidate rules`);
  const merged = opts.preMerge ? await mergeWithPreClusters(candidates, llm, log) : await mergeCandidates(candidates, llm, log);
  stats.merged = merged.length;
  log(`Merged into ${merged.length} rules`);

  if (process.env.PRECEDENT_DEBUG) {
    console.error(`[debug] merge returned ${merged.length} rules; sizes: ${merged.map((m) => m.commentIds.length).join(",")}`);
  }
  const rules: Rule[] = [];
  let tooFewComments = 0;
  let tooFewPrs = 0;
  let droppedByFilter = 0;
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
    const reason = dropReason(m);
    if (reason) {
      droppedByFilter++;
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
  stats.droppedByThreshold = tooFewComments + tooFewPrs;
  log(
    `Kept ${rules.length} of ${merged.length} merged rules; dropped ${tooFewComments} with fewer than ${minOccurrences} comments and ${tooFewPrs} with fewer than ${minPullRequests} distinct pull requests`,
  );
  if (droppedByFilter > 0) log(`Dropped ${droppedByFilter} rules that are not in English or are about tool-generated files`);
  if (rules.length === 0) return rules;

  log(`Auditing ${rules.length} rules against the comments they cite`);
  const audited = await auditSupport(rules, byId, llm, { minOccurrences, minPullRequests });
  stats.droppedByAudit = audited.dropped;
  if (audited.dropped > 0) log(`Dropped ${audited.dropped} rules whose comments do not support them`);
  if (audited.rules.length < 2) return audited.rules;

  const deduped = mergeSharedSources(await dedupeRules(audited.rules, llm));
  if (deduped.length < audited.rules.length) log(`Merged ${audited.rules.length - deduped.length} near-duplicate rules`);
  return deduped;
}
