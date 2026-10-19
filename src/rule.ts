import { z } from "zod";

/** A review rule mined from a team's pull request history. */
export const RuleSchema = z.object({
  id: z.string(),
  description: z.string().min(1),
  /** Glob patterns the rule applies to, e.g. "src/billing/**". Empty means repo-wide. */
  scope: z.array(z.string()).default([]),
  goodExample: z.string().optional(),
  badExample: z.string().optional(),
  /** 0..1, raised when comments are accepted, lowered when dismissed. */
  confidence: z.number().min(0).max(1),
  /**
   * Set by `mine --docs`: "enforced" (only in review comments), "both" (also in the written guide)
   * or "conflict" (the guide says something that contradicts it).
   */
  origin: z.enum(["enforced", "both", "conflict"]).optional(),
  /** Where the guide states (or contradicts) the rule, quoted verbatim. */
  docRefs: z.array(z.object({ path: z.string(), quote: z.string() })).optional(),
  /** Review comments this rule was derived from. */
  sources: z
    .array(
      z.object({
        prNumber: z.number().int(),
        commentUrl: z.string().url(),
        reviewer: z.string(),
      }),
    )
    .min(1),
});

export type Rule = z.infer<typeof RuleSchema>;

/**
 * How much evidence a rule has. "core": several comments from several reviewers asked for it;
 * in repeated runs on the same repository these rules were found again more often than the
 * others, but not always (measured retention between 0.4 and 0.9 depending on the repository).
 * "emerging": everything else, rules that may well be real but rest on thinner evidence, among
 * them rules a single maintainer asked for many times.
 */
export type RuleTier = "core" | "emerging";

export const CORE_MIN_COMMENTS = 3;
export const CORE_MIN_REVIEWERS = 2;

export function ruleTier(rule: Pick<Rule, "sources">): RuleTier {
  const reviewers = new Set(rule.sources.map((s) => s.reviewer)).size;
  return rule.sources.length >= CORE_MIN_COMMENTS && reviewers >= CORE_MIN_REVIEWERS ? "core" : "emerging";
}
