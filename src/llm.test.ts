import { describe, expect, it } from "vitest";
import { withRetry } from "./llm.js";

describe("withRetry", () => {
  it("retries transient failures and returns the first success", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      if (++calls < 3) throw new Error("bad json");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws the last error after exhausting attempts", async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error(`fail ${calls}`); })).rejects.toThrow("fail 3");
  });

  it("does not retry refusals", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error("The model declined to process this request"); }),
    ).rejects.toThrow("declined");
    expect(calls).toBe(1);
  });
});
