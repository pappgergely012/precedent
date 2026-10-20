import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.js";
import type { Llm } from "./llm.js";
import type { Rule } from "./rule.js";
import { formatComment, matchesGlob, reviewDiff, rulesForFile, sanitizeCommentText } from "./review.js";

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

describe("matchesGlob: braces and leading separators", () => {
  it("supports brace alternatives, also nested and with ** and a prefix", () => {
    expect(matchesGlob("src/**/*.{ts,tsx}", "src/a/b/c.tsx")).toBe(true);
    expect(matchesGlob("src/**/*.{ts,tsx}", "src/a/b/c.js")).toBe(false);
    expect(matchesGlob("{src,lib}/**", "lib/x/y.ts")).toBe(true);
    expect(matchesGlob("src/{a,b/{c,d}}/*.ts", "src/b/d/x.ts")).toBe(true);
    expect(matchesGlob("src/{a,b/{c,d}}/*.ts", "src/b/e/x.ts")).toBe(false);
  });
  it("ignores a leading ./ or / on the glob and the path, and keeps literal braces without a closing one", () => {
    expect(matchesGlob("./src/**", "src/a.ts")).toBe(true);
    expect(matchesGlob("/src/**", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/**", "./src/a.ts")).toBe(true);
    expect(matchesGlob("a{b", "a{b")).toBe(true);
  });
});

describe("sanitizeCommentText and formatComment", () => {
  const rule = {
    id: "r1", description: "Use gate() in tests. @everyone see ![x](http://evil.example/p.png) [click](javascript:alert(1)) <script>x</script> https://evil.example/a",
    scope: [], confidence: 0.8,
    sources: [
      { prNumber: 1, reviewer: "a", commentUrl: "https://github.com/o/r/pull/1#discussion_r1" },
      { prNumber: 2, reviewer: "b", commentUrl: "https://x.example/) [bad](http://evil" },
      { prNumber: 3, reviewer: "c", commentUrl: "https://github.com/o/r/pull/3#discussion_r3" },
    ],
  };

  it("removes images, links, raw URLs, HTML and bidi characters, and defuses mentions", () => {
    const text = sanitizeCommentText("Ping @octocat and @org/team now ‮evil ![i](http://e/x.png) [t](http://e) http://e.example <b>x</b>", 300);
    expect(text).not.toMatch(/http|!\[|<b>|‮/);
    expect(text).toContain("`@octocat`");
    expect(text).toContain("`@org/team`");
  });

  it("caps long text and leaves ordinary text alone", () => {
    expect(sanitizeCommentText("Use `gate()` in tests, not `jest.fn()`.", 300)).toBe("Use `gate()` in tests, not `jest.fn()`.");
    expect(sanitizeCommentText("x".repeat(1000), 300).length).toBeLessThanOrEqual(300);
  });

  it("builds the posted comment only from cleaned text and safe citation links", () => {
    const body = formatComment({ ruleId: "r1", path: "a.ts", line: 1, message: "Call @maintainer, see http://evil.example/steal ![p](http://evil/p.png)" }, rule as never);
    expect(body).not.toMatch(/evil|<script>|javascript:|!\[/);
    expect(body).not.toMatch(/(^|[^`\w])@\w/);
    expect(body).toContain("[#1](https://github.com/o/r/pull/1#discussion_r1)");
    expect(body).toContain("[#3](https://github.com/o/r/pull/3#discussion_r3)");
  });
});

describe("parseDiff paths", () => {
  const one = (header: string, eol = "\n") =>
    parseDiff(["diff --git a/x b/x", "index 1..2 100644", "--- a/x", header, "@@ -1,1 +1,2 @@", " keep", "+added", ""].join(eol));

  it("drops the tab git adds after a path with spaces", () => {
    expect(one("+++ b/my file.ts\t")[0]!.path).toBe("my file.ts");
    expect(one("+++ b/dir/with space/a b.ts\t2026-01-01 00:00:00")[0]!.path).toBe("dir/with space/a b.ts");
  });
  it("decodes git's quoted paths: octal UTF-8 bytes, escaped quotes and tabs", () => {
    expect(one('+++ "b/caf\\303\\251.ts"')[0]!.path).toBe("café.ts");
    expect(one('+++ "b/\\346\\227\\245\\346\\234\\254.ts"')[0]!.path).toBe("日本.ts");
    expect(one('+++ "b/say \\"hi\\".ts"')[0]!.path).toBe('say "hi".ts');
    expect(one('+++ "b/a\\tb.ts"')[0]!.path).toBe("a\tb.ts");
  });
  it("handles CRLF diffs: no carriage return on paths, and line numbers still right", () => {
    const files = one("+++ b/c.ts", "\r\n");
    expect(files[0]!.path).toBe("c.ts");
    expect([...files[0]!.addedLines]).toEqual([2]);
  });
  it("keeps ordinary paths, renames and deleted files working", () => {
    expect(one("+++ b/src/a.ts")[0]!.path).toBe("src/a.ts");
    expect(one("+++ /dev/null")).toEqual([]);
  });
});
