import { describe, expect, it } from "vitest";
import * as lib from "./index.js";

describe("library surface", () => {
  it("exports exactly the documented functions and values", () => {
    expect(Object.keys(lib).sort()).toEqual(
      [
        "CORE_MIN_COMMENTS", "CORE_MIN_REVIEWERS", "DEFAULT_MODEL", "ExportError", "GitHubApiError", "RuleSchema", "RulesFileSchema",
        "anthropicLlm", "applyBlock", "cachedLlm", "compareRuns", "createRedactor", "describeCache", "describeEstimate", "describeRedaction",
        "estimateUsage", "extractRules", "fetchPullDiff", "fetchReviewComments", "fileCache", "fileStore", "filterComments", "formatComment",
        "isCoreRule", "memoryCache", "memoryStore", "postPullReview", "readRulesFile", "redactText", "renderBlock", "renderMineOutput",
        "replayLlm", "reviewDiff", "ruleTier", "rulesForFile", "selectRules", "selectUsable", "stabilityCuts", "summarizeStability",
        "suspiciousRules", "verifyRules", "withRetry", "writeExport", "writeRulesFile",
      ].sort(),
    );
  });

  it("imports without side effects: no exit, no argument parsing, no output", async () => {
    const exit = process.exit;
    let exited = false;
    process.exit = (() => {
      exited = true;
    }) as never;
    try {
      await import("./index.js");
    } finally {
      process.exit = exit;
    }
    expect(exited).toBe(false);
  });

  it("runs the pipeline from the library entry point with a replayed model", async () => {
    const store = lib.memoryStore();
    const comment = (id: number) => ({
      id, prNumber: 100 + id, reviewer: id % 2 ? "anna" : "bob", body: "Please add a rate limit to this new endpoint.",
      path: "src/api/users.ts", diffHunk: "@@", url: `https://github.com/o/r/pull/${100 + id}#discussion_r${id}`, createdAt: `2026-01-0${id}T00:00:00Z`,
    });
    const answers = [
      { items: [{ id: 1, principle: "Add a rate limit to new endpoints" }, { id: 2, principle: "New endpoints need rate limiting" }] },
      { rules: [{ description: "Add a rate limit to every new endpoint", scope: ["src/api/**"], commentIds: [1, 2] }] },
      { rules: [{ index: 0, supportingIds: [1, 2], revisedDescription: null }] },
    ];
    let i = 0;
    const live: lib.Llm = { parse: async (_p, schema) => schema.parse(answers[i++]) } as lib.Llm;
    const recorded = await lib.extractRules([comment(1), comment(2)], lib.cachedLlm(live, store, "m"));
    const replayed = await lib.extractRules([comment(1), comment(2)], lib.replayLlm(store, "m"));
    expect(replayed).toEqual(recorded);
    expect(replayed).toHaveLength(1);
  });
});
