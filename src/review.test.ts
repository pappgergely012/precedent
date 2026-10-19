import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.js";
import type { Llm } from "./llm.js";
import type { Rule } from "./rule.js";
import { formatComment, matchesGlob, reviewDiff, rulesForFile } from "./review.js";

const diff = `diff --git a/src/api.ts b/src/api.ts
index 111..222 100644
--- a/src/api.ts
+++ b/src/api.ts
@@ -1,3 +1,5 @@
 import x from "x";
-const old = 1;
+export function handler() {}
+const unused = 2;
 export default x;
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
`;

const rule = (id: string, scope: string[] = [], confidence = 0.6): Rule => ({
  id,
  description: `Rule ${id}`,
  scope,
  confidence,
  sources: [{ prNumber: 7, commentUrl: "https://github.com/o/r/pull/7#discussion_r1", reviewer: "anna" }],
});

const fakeLlm = (findings: unknown[]): Llm => ({ parse: async (_p, schema) => schema.parse({ findings }) }) as Llm;

describe("parseDiff", () => {
  it("numbers added lines in the new file and skips deleted files", () => {
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("src/api.ts");
    expect([...files[0]!.addedLines]).toEqual([2, 3]);
    expect(files[0]!.patch).toContain("2: +export function handler() {}");
  });
});

describe("matchesGlob", () => {
  it("handles ** and *", () => {
    expect(matchesGlob("tests/**", "tests/a/b/test_x.py")).toBe(true);
    expect(matchesGlob("tests/components/**/test_init.py", "tests/components/foo/test_init.py")).toBe(true);
    expect(matchesGlob("tests/components/**/test_init.py", "tests/components/test_init.py")).toBe(true);
    expect(matchesGlob("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(matchesGlob("**/quality_scale.yaml", "homeassistant/components/x/quality_scale.yaml")).toBe(true);
  });

  it("treats rules without scope as repo-wide", () => {
    expect(rulesForFile([rule("a"), rule("b", ["tests/**"])], "src/api.ts").map((r) => r.id)).toEqual(["a"]);
  });
});

describe("reviewDiff", () => {
  it("drops findings on lines the PR did not add and on unknown rules", async () => {
    const llm = fakeLlm([
      { ruleId: "a", line: 2, message: "Inline this." },
      { ruleId: "a", line: 1, message: "Context line." },
      { ruleId: "zzz", line: 3, message: "Unknown rule." },
    ]);
    const out = await reviewDiff(parseDiff(diff), [rule("a")], llm);
    expect(out).toEqual([{ ruleId: "a", path: "src/api.ts", line: 2, message: "Inline this." }]);
  });

  it("reports each rule once, highest confidence first", async () => {
    const llm = fakeLlm([
      { ruleId: "a", line: 2, message: "First." },
      { ruleId: "a", line: 3, message: "Second." },
      { ruleId: "b", line: 3, message: "Other rule." },
    ]);
    const out = await reviewDiff(parseDiff(diff), [rule("a", [], 0.4), rule("b", [], 1)], llm);
    expect(out.map((v) => v.ruleId)).toEqual(["b", "a"]);
    expect(out[1]!.message).toBe("First.");
  });

  it("does not call the model when no rule applies to the file", async () => {
    const llm: Llm = { parse: async () => { throw new Error("should not be called"); } };
    expect(await reviewDiff(parseDiff(diff), [rule("t", ["tests/**"])], llm)).toEqual([]);
  });
});

describe("formatComment", () => {
  it("cites the rule and where reviewers asked for it", () => {
    const body = formatComment({ ruleId: "a", path: "p", line: 1, message: "Inline this." }, rule("a"));
    expect(body).toContain("Inline this.");
    expect(body).toContain("Rule a");
    expect(body).toContain("[#7](https://github.com/o/r/pull/7#discussion_r1)");
  });
});
