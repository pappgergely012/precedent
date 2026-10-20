import { describe, expect, it } from "vitest";
import { describeError, describeResume } from "./errors.js";

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

describe("describeError for the model API", () => {
  it("turns a 404 JSON body for a wrong model name into one line that names PRECEDENT_MODEL", () => {
    const line = describeError(new Error('404 {"type":"error","error":{"type":"not_found_error","message":"model: bogus-model-x"},"request_id":"req_1"}'));
    expect(line).toBe("Error: the model was not found (model: bogus-model-x). Check PRECEDENT_MODEL, or unset it to use the default.");
  });
  it("shows other API errors as a sentence, never raw JSON", () => {
    expect(describeError(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'))).toContain("rejected the key");
    expect(describeError(new Error('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'))).toBe("Error: the Anthropic API answered 529: Overloaded.");
  });
});

describe("describeResume", () => {
  it("says what was kept and what was spent, and does not claim progress when nothing was saved", () => {
    const usage = { calls: 3, inputTokens: 12345, outputTokens: 678 };
    expect(describeResume("c.json", true, usage)).toContain("Progress so far is saved in c.json");
    expect(describeResume("c.json", true, usage)).toContain("3 calls, 12,345 input and 678 output tokens");
    const none = describeResume("c.json", false);
    expect(none).toContain("Nothing from this run was saved in c.json");
    expect(none).not.toContain("Progress so far");
  });
});
