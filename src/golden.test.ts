import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { comments, fakeModel, now } from "./testing/golden-fake.js";
import { extractRules } from "./extract.js";

// fixtures/golden-default.json was produced by the gate pack commit 7f7c3ce with the same fake model and comments.
// With no variant flag the current code must send the same prompts and return the same rules, byte for byte.
const golden = JSON.parse(readFileSync("fixtures/golden-default.json", "utf8")) as { producedBy: string; promptHashes: string[]; rules: unknown[] };

describe("default mining output is unchanged since the gate pack commit", () => {
  it("sends the same prompts and returns the same rules with default options", async () => {
    const promptHashes: string[] = [];
    const rules = await extractRules(comments as never, fakeModel(promptHashes) as never, { now });
    expect(golden.producedBy).toBe("7f7c3cee25c8b7a5daf9952435fa86d766a01ba6");
    expect(promptHashes).toEqual(golden.promptHashes);
    expect(JSON.stringify(rules)).toBe(JSON.stringify(golden.rules));
    expect(rules.length).toBeGreaterThan(5);
  });

  it("is also unchanged when the variant options are set to their no-op values", async () => {
    const promptHashes: string[] = [];
    const rules = await extractRules(comments as never, fakeModel(promptHashes) as never, { now, extractionVotes: 1, sharedMergeThreshold: 0.5, preMerge: false });
    expect(promptHashes).toEqual(golden.promptHashes);
    expect(JSON.stringify(rules)).toBe(JSON.stringify(golden.rules));
  });

  it("really differs when a variant is on (the test can fail)", async () => {
    const promptHashes: string[] = [];
    await extractRules(comments as never, fakeModel(promptHashes) as never, { now, extractionVotes: 3 });
    expect(promptHashes.length).toBeGreaterThan(golden.promptHashes.length);
  });
});
