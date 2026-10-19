import { describe, expect, it } from "vitest";
import { describeEstimate, estimateUsage } from "./estimate.js";

describe("estimateUsage", () => {
  it("is close to the measured runs it was calibrated on", () => {
    // ripgrep: 300 comments measured 13 calls, 41k input, 11k output
    const small = estimateUsage({ usable: 300 });
    expect(small.calls).toBeGreaterThanOrEqual(10);
    expect(small.calls).toBeLessThanOrEqual(16);
    expect(small.inputTokens).toBeGreaterThan(41_000 * 0.7);
    expect(small.inputTokens).toBeLessThan(41_000 * 1.3);
    // kubernetes/django: 1000 comments measured 33 calls, 143-160k input, 34-37k output
    const big = estimateUsage({ usable: 1000 });
    expect(big.calls).toBe(33);
    expect(big.inputTokens).toBeGreaterThan(143_000 * 0.7);
    expect(big.inputTokens).toBeLessThan(160_000 * 1.3);
    expect(big.outputTokens).toBeGreaterThan(34_000 * 0.7);
    expect(big.outputTokens).toBeLessThan(37_000 * 1.3);
  });

  it("charges only for comments that are not in the cache", () => {
    const cold = estimateUsage({ usable: 1000 });
    const warm = estimateUsage({ usable: 1000, pending: 80 });
    expect(warm.extractionCalls).toBe(2);
    expect(warm.calls).toBeLessThan(cold.calls);
    expect(warm.inputTokens).toBeLessThan(cold.inputTokens / 2);
  });

  it("multiplies the extraction calls by the number of votes", () => {
    const one = estimateUsage({ usable: 400 });
    const three = estimateUsage({ usable: 400, votes: 3 });
    expect(three.extractionCalls).toBe(one.extractionCalls * 3);
  });

  it("estimates nothing for no comments", () => {
    expect(estimateUsage({ usable: 0 })).toEqual({ pending: 0, extractionCalls: 0, calls: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("describes the estimate and says no call was made", () => {
    const text = describeEstimate(estimateUsage({ usable: 1000, pending: 400 }), 1000, 1).join("\n");
    expect(text).toContain("1,000 comments would be analysed (600 already in the cache)");
    expect(text).toContain("No model call was made.");
  });
});
