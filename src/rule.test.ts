import { describe, expect, it } from "vitest";
import { ruleTier } from "./rule.js";

const src = (pr: number, reviewer: string) => ({ prNumber: pr, reviewer, commentUrl: `https://github.com/o/r/pull/${pr}#discussion_r${pr}` });

describe("ruleTier", () => {
  it("is core with 3+ comments from 2+ reviewers", () => {
    expect(ruleTier({ sources: [src(1, "a"), src(2, "b"), src(3, "a")] })).toBe("core");
  });

  it("is emerging with fewer than 3 comments or a single reviewer", () => {
    expect(ruleTier({ sources: [src(1, "a"), src(2, "b")] })).toBe("emerging");
    expect(ruleTier({ sources: [src(1, "a"), src(2, "a"), src(3, "a")] })).toBe("emerging");
  });
});
