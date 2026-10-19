/**
 * The library surface of Precedent. Importing this module has no side effects: it does not read
 * arguments, call the network or exit the process (that is `cli.ts`). Anything not exported here
 * is internal and may change without notice. The surface is pinned by `src/index.test.ts`.
 */
export { fetchReviewComments, fetchPullDiff, postPullReview, GitHubApiError, type ReviewComment } from "./github.js";
export { extractRules, filterComments, selectUsable, type ExtractOptions } from "./extract.js";
export { RuleSchema, ruleTier, CORE_MIN_COMMENTS, CORE_MIN_REVIEWERS, type Rule, type RuleTier } from "./rule.js";
export { RulesFileSchema, readRulesFile, writeRulesFile, type RulesFile } from "./rulesfile.js";
export { anthropicLlm, DEFAULT_MODEL, withRetry, type Llm } from "./llm.js";
export { memoryCache, fileCache, type PrincipleCache } from "./cache.js";
export { cachedLlm, replayLlm, memoryStore, fileStore, describeCache, type CachedLlm, type ResponseStore, type CacheStats } from "./llmcache.js";
export { reviewDiff, rulesForFile, formatComment, type Violation, type ReviewOptions } from "./review.js";
export { verifyRules } from "./verify.js";
export { estimateUsage, describeEstimate, type UsageEstimate } from "./estimate.js";
export { renderBlock, applyBlock, writeExport, selectRules, suspiciousRules, ExportError, type ExportFormat, type ExportOptions } from "./export.js";
export { redactText, createRedactor, describeRedaction, type RedactionKind, type RedactionCounts } from "./redact.js";
export { renderMineOutput } from "./mineoutput.js";
export { compareRuns, stabilityCuts, summarizeStability, isCoreRule } from "./stability.js";
