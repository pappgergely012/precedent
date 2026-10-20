import { describe, expect, it } from "vitest";
import { describeError } from "./errors.js";

describe("describeError", () => {
  it("explains a dropped connection and what to do, whatever the runtime calls it", () => {
    for (const error of [new Error("terminated"), new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }), Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" })]) {
      const line = describeError(error);
      expect(line).toContain("network problem");
      expect(line).toContain("run the command again");
      expect(line).not.toContain("\n");
    }
  });
  it("leaves other errors as their first line", () => {
    expect(describeError(new Error("Repository not found\n  at x"))).toBe("Error: Repository not found");
    expect(describeError("plain")).toBe("Error: plain");
  });
});
