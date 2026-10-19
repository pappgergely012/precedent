// "Refresh" measurement: mine a window W cold, then W plus the N newest comments with the caches kept.
// Reports the calls saved and how many rules of the first run survive when all their sources lie in W.
// Costs a cold mine plus a partly cached mine of a real repository (see ops/reports/cost-table).
// Usage: pnpm tsx scripts/eval-refresh.ts <owner/repo> [newComments=100] [maxComments=600]
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCache } from "../src/cache.js";
import { extractRules } from "../src/extract.js";
import { fetchReviewComments } from "../src/github.js";
import { anthropicLlm, DEFAULT_MODEL } from "../src/llm.js";
import { cachedLlm, fileStore } from "../src/llmcache.js";
import { compareRuns } from "../src/stability.js";

const repo = process.argv[2];
if (!repo) throw new Error("Usage: pnpm tsx scripts/eval-refresh.ts <owner/repo> [newComments] [maxComments]");
const added = Number(process.argv[3] ?? 100);
const maxComments = Number(process.argv[4] ?? 600);
const model = process.env.PRECEDENT_MODEL ?? DEFAULT_MODEL;

const all = (await fetchReviewComments(repo, { token: process.env.GITHUB_TOKEN, maxPages: 30 }))
  .filter((c) => c.inReplyTo === undefined)
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const window = all.slice(0, Math.max(0, all.length - added));
const windowIds = new Set(window.map((c) => c.id));
console.log(`${repo}: ${all.length} top-level comments; window W = ${window.length}, new = ${all.length - window.length}`);

const dir = await mkdtemp(join(tmpdir(), "precedent-refresh-"));
const principles = await fileCache(join(dir, "cache"), model);
const stages = cachedLlm(anthropicLlm(), await fileStore(join(dir, "cache.responses.json")), model);
const opts = { maxComments, cache: principles, minRecentComments: 0 };

const before = () => stages.usage?.() ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
const cold = await extractRules(window, stages, opts);
const coldUsage = before();
await stages.save();
const warm = await extractRules(all, stages, opts);
const warmUsage = before();

const warmCalls = warmUsage.calls - coldUsage.calls;
const stable = cold.filter((r) => r.sources.every((s) => windowIds.has(Number(s.commentUrl.split("_r").pop()))));
const kept = compareRuns(stable, warm);
console.log(`Cold run on W: ${cold.length} rules, ${coldUsage.calls} calls, ${coldUsage.inputTokens} input tokens.`);
console.log(`Refresh on W + new: ${warm.length} rules, ${warmCalls} calls (${warmUsage.inputTokens - coldUsage.inputTokens} input tokens), ${stages.cacheStats().hits} cache hits.`);
console.log(`Rules of the cold run whose sources are all in W: ${stable.length}; still present after the refresh: ${kept.matched} (retention ${stable.length ? (kept.matched / stable.length).toFixed(2) : "n/a"}).`);
console.log(`Rules in the refresh that were not in the cold run: ${warm.length - kept.matched}.`);
