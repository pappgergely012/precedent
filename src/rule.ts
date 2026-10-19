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
