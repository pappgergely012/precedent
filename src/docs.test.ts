import { describe, expect, it } from "vitest";
import { extractDocRules, fetchGuideDocs, isPointer, reconcileRules, type DocRule } from "./docs.js";
import type { Llm } from "./llm.js";
import type { Rule } from "./rule.js";

const fakeLlm = (...answers: unknown[]): Llm => {
  let i = 0;
  return { parse: async (_p, schema) => schema.parse(answers[i++]) } as Llm;
};

describe("fetchGuideDocs", () => {
  it("returns the guides that exist, skips missing and unreadable ones, and caps size", async () => {
    const seen: string[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      seen.push(url);
      expect((init.headers as Record<string, string>).Accept).toBe("application/vnd.github.raw+json");
      if (url === "https://api.github.com/repos/o/r/contents/CONTRIBUTING.md") return Promise.resolve(new Response("x".repeat(40_000)));
      if (url === "https://api.github.com/repos/o/r/contents/AGENTS.md") return Promise.resolve(new Response("Use pnpm."));
      if (url === "https://api.github.com/repos/o/r/contents/STYLE.md") return Promise.resolve(new Response("denied", { status: 403 }));
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }) as unknown as typeof fetch;
    const docs = await fetchGuideDocs("o/r", { fetchImpl });
    expect(docs.map((d) => d.path)).toEqual(["CONTRIBUTING.md", "AGENTS.md"]);
    expect(docs[0]!.text).toHaveLength(30_000);
    expect(seen[0]).toBe("https://api.github.com/repos/o/r/contents/CONTRIBUTING.md");
  });
});

describe("extractDocRules", () => {
  const doc = { path: "CONTRIBUTING.md", text: "## Changes\n\nAdd a changelog entry\nfor every user-facing change.\n\nRun `pnpm test` before pushing." };

  it("keeps rules whose quote appears in the guide, ignoring whitespace and case", async () => {
    const llm = fakeLlm({ rules: [{ description: "Add a changelog entry for user-facing changes", quote: "Add a changelog entry for every user-facing change." }] });
    expect(await extractDocRules([doc], llm)).toEqual([
      { description: "Add a changelog entry for user-facing changes", path: "CONTRIBUTING.md", quote: "Add a changelog entry for every user-facing change." },
    ]);
  });

  it("drops rules with an invented, empty or pointer-only quote", async () => {
    const llm = fakeLlm({ rules: [
      { description: "Sign commits", quote: "All commits must be signed." },
      { description: "Empty", quote: "  " },
      { description: "Run tests", quote: "Run `pnpm test` before pushing." },
      { description: "Pointer", quote: "Run `pnpm test`" },
    ] });
    expect((await extractDocRules([doc], llm)).map((r) => r.description)).toEqual(["Run tests"]);
  });
});

describe("reconcileRules", () => {
  const rule = (id: string, description: string): Rule => ({
    id,
    description,
    scope: [],
    confidence: 0.6,
    sources: [{ prNumber: 1, reviewer: "anna", commentUrl: "https://github.com/o/r/pull/1#discussion_r1" }],
  });
  const docRules: DocRule[] = [
    { description: "Add a changelog entry", path: "CONTRIBUTING.md", quote: "Add a changelog entry." },
    { description: "Do not add changelog entries for fixes", path: "CONTRIBUTING.md", quote: "No changelog for fixes." },
    { description: "Sign commits", path: "CONTRIBUTING.md", quote: "Sign commits." },
  ];
  const rules = [rule("a", "Add a changelog entry to feature PRs"), rule("b", "Add changelog entries to bug fixes"), rule("c", "Use gate() in tests")];

  it("tags both, conflict and enforced, and lists documented-only rules", async () => {
    const llm = fakeLlm({ matches: [
      { ruleIndex: 0, docIndex: 0, relation: "same" },
      { ruleIndex: 1, docIndex: 1, relation: "conflict" },
    ] }, { verdicts: [{ pair: 0, verdict: "same" }, { pair: 1, verdict: "conflict" }] });
    const out = await reconcileRules(rules, docRules, llm);
    expect(out.rules.map((r) => r.origin)).toEqual(["both", "conflict", "enforced"]);
    expect(out.rules[0]!.docRefs).toEqual([{ path: "CONTRIBUTING.md", quote: "Add a changelog entry." }]);
    expect(out.rules[2]!.docRefs).toBeUndefined();
    expect(out.documentedOnly.map((d) => d.description)).toEqual(["Sign commits"]);
  });

  it("ignores invalid indices and repeated matches for one rule", async () => {
    const llm = fakeLlm({ matches: [
      { ruleIndex: 9, docIndex: 0, relation: "same" },
      { ruleIndex: 0, docIndex: 9, relation: "same" },
      { ruleIndex: 0, docIndex: 0, relation: "same" },
      { ruleIndex: 0, docIndex: 1, relation: "conflict" },
    ] }, { verdicts: [{ pair: 0, verdict: "same" }] });
    const out = await reconcileRules(rules, docRules, llm);
    expect(out.rules[0]!.origin).toBe("both");
    expect(out.documentedOnly).toHaveLength(2);
  });

  it("treats a pair the second look does not confirm as enforced, and never calls it documented", async () => {
    const llm = fakeLlm(
      { matches: [{ ruleIndex: 0, docIndex: 0, relation: "same" }, { ruleIndex: 1, docIndex: 1, relation: "same" }, { ruleIndex: 2, docIndex: 2, relation: "same" }] },
      { verdicts: [{ pair: 0, verdict: "no" }, { pair: 1, verdict: "conflict" }] },
    );
    const out = await reconcileRules(rules, docRules, llm);
    // pair 0 rejected, pair 1 downgraded/upgraded to the verified relation, pair 2 got no verdict
    expect(out.rules.map((r) => r.origin)).toEqual(["enforced", "conflict", "enforced"]);
    expect(out.documentedOnly.map((d) => d.description)).toEqual(["Add a changelog entry", "Sign commits"]);
  });

  it("makes no model call when there is nothing to compare", async () => {
    const llm: Llm = { parse: async () => { throw new Error("should not be called"); } };
    const out = await reconcileRules(rules, [], llm);
    expect(out.rules.every((r) => r.origin === "enforced")).toBe(true);
    expect(out.documentedOnly).toEqual([]);
  });
});

describe("isPointer", () => {
  it("flags quotes that only point to another document", () => {
    expect(isPointer("Please read [Contributing to the Rails Documentation](https://edgeguides.rubyonrails.org/x.html) for more.")).toBe(true);
    expect(isPointer("See the style guide")).toBe(true);
    expect(isPointer("[Guide](https://example.com)")).toBe(true);
  });

  it("keeps quotes that state an expectation", () => {
    expect(isPointer("Add accompanying test case for every bug fix.")).toBe(false);
    expect(isPointer("Run `pnpm test` before pushing your changes.")).toBe(false);
  });
});
