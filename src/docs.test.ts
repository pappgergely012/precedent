import { describe, expect, it } from "vitest";
import { extractDocRules, fetchGuideDocs, isPointer, proposePairs, quoteInText, reconcileRules, selectGuidePaths, wordOverlap, type DocRule } from "./docs.js";
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
      if (url.includes("/git/trees/")) return Promise.resolve(new Response("Not Found", { status: 404 }));
      expect((init.headers as Record<string, string>).Accept).toBe("application/vnd.github.raw+json");
      if (url === "https://api.github.com/repos/o/r/contents/CONTRIBUTING.md") return Promise.resolve(new Response("x".repeat(40_000)));
      if (url === "https://api.github.com/repos/o/r/contents/AGENTS.md") return Promise.resolve(new Response("Use pnpm."));
      if (url === "https://api.github.com/repos/o/r/contents/STYLE.md") return Promise.resolve(new Response("denied", { status: 403 }));
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }) as unknown as typeof fetch;
    const docs = await fetchGuideDocs("o/r", { fetchImpl });
    expect(docs.map((d) => d.path)).toEqual(["CONTRIBUTING.md", "AGENTS.md"]);
    expect(docs[0]!.text).toHaveLength(30_000);
    expect(seen[1]).toBe("https://api.github.com/repos/o/r/contents/CONTRIBUTING.md");
  });

  it("finds guides by scanning the repository tree and reads only those", async () => {
    const tree = { tree: [
      { path: "README.md", type: "blob", size: 100 },
      { path: "CONTRIBUTING.md", type: "blob", size: 100 },
      { path: "guides/source/contributing_to_ruby_on_rails.md", type: "blob", size: 5000 },
      { path: "src/index.ts", type: "blob", size: 100 },
    ] };
    const fetched: string[] = [];
    const fetchImpl = ((url: string) => {
      if (url.includes("/git/trees/")) return Promise.resolve(new Response(JSON.stringify(tree)));
      fetched.push(url.split("/contents/")[1]!);
      return Promise.resolve(new Response("Write tests that fail without the change."));
    }) as unknown as typeof fetch;
    const docs = await fetchGuideDocs("o/r", { fetchImpl });
    expect(docs.map((d) => d.path)).toEqual(["CONTRIBUTING.md", "guides/source/contributing_to_ruby_on_rails.md"]);
    expect(fetched).toEqual(["CONTRIBUTING.md", "guides/source/contributing_to_ruby_on_rails.md"]);
  });
});

describe("selectGuidePaths", () => {
  const blob = (path: string, size = 1000) => ({ path, type: "blob", size });

  it("always takes the root guides, then ranks topical documents and skips noise", () => {
    const tree = [
      blob("AGENTS.md"),
      blob(".github/PULL_REQUEST_TEMPLATE.md"),
      blob("docs/internals/contributing/writing-code/coding-style.txt"),
      blob("docs/internals/contributing/writing-code/submitting-patches.txt"),
      blob("docs/internals/contributing/triaging-tickets.txt"),
      blob("docs/releases/5.0.txt"),
      blob("tests/contributing/fixture.md"),
      blob("docs/ref/models.txt"),
      blob("docs/huge-contributing-notes.md", 500_000),
      blob("src/contributing.ts"),
      { path: "docs/internals", type: "tree" },
    ];
    expect(selectGuidePaths(tree)).toEqual([
      ".github/PULL_REQUEST_TEMPLATE.md",
      "AGENTS.md",
      "docs/internals/contributing/writing-code/coding-style.txt",
      "docs/internals/contributing/writing-code/submitting-patches.txt",
      "docs/internals/contributing/triaging-tickets.txt",
    ]);
  });

  it("caps the number of files", () => {
    const tree = Array.from({ length: 30 }, (_, i) => blob(`docs/contributing/guide-${i}.md`));
    expect(selectGuidePaths(tree, 5)).toHaveLength(5);
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
  const doc = (description: string, quote: string): DocRule => ({ description, path: "CONTRIBUTING.md", quote });

  /**
   * Fake model: the first-pass prompt returns `matches`; verification prompts are answered by
   * `judge(ruleText, quote)`, so tests do not depend on call order or pair numbering.
   */
  const fakeModel = (matches: unknown[], judge: (ruleText: string, quote: string) => "same" | "conflict" | "no") => {
    const verifyCalls: number[] = [];
    const llm: Llm = {
      parse: async (prompt, schema) => {
        if (prompt.includes("Two lists of coding rules")) return schema.parse({ matches });
        const pairs = [...prompt.matchAll(/Pair (\d+)\nMined rule: (.*)\nGuide text: "(.*)"/g)];
        verifyCalls.push(pairs.length);
        return schema.parse({ verdicts: pairs.map((m) => ({ pair: Number(m[1]), verdict: judge(m[2]!, m[3]!) })) });
      },
    };
    return { llm, verifyCalls };
  };

  const changelog = doc("Add a changelog entry for features", "Add a changelog entry.");
  const noChangelog = doc("Do not add changelog entries for fixes", "No changelog for fixes.");
  const sign = doc("Sign commits", "Sign commits.");
  const rules = [rule("a", "Add a changelog entry to feature PRs"), rule("b", "Add changelog entries to bug fixes"), rule("c", "Use gate() in tests")];
  const docRules = [changelog, noChangelog, sign];

  it("tags both, conflict and enforced, and lists documented-only rules", async () => {
    const { llm } = fakeModel(
      [{ ruleIndex: 0, docIndex: 0, relation: "same" }, { ruleIndex: 1, docIndex: 1, relation: "conflict" }],
      (rule, quote) => (quote === "Add a changelog entry." && rule.includes("feature") ? "same" : quote === "No changelog for fixes." && rule.includes("bug fixes") ? "conflict" : "no"),
    );
    const out = await reconcileRules(rules, docRules, llm);
    expect(out.rules.map((r) => r.origin)).toEqual(["both", "conflict", "enforced"]);
    expect(out.rules[0]!.docRefs).toEqual([{ path: "CONTRIBUTING.md", quote: "Add a changelog entry." }]);
    expect(out.rules[2]!.docRefs).toBeUndefined();
    expect(out.documentedOnly.map((d) => d.description)).toEqual(["Sign commits"]);
  });

  it("finds a pair the first pass missed through the closest wording, but only if the second look confirms it", async () => {
    const mined = [rule("a", "Use assertRaisesMessage when the exception message matters")];
    const docs = [doc("Prefer assertRaisesMessage over assertRaises", "Use assertRaisesMessage() rather than assertRaises() when the message matters."), sign];
    const confirmed = await reconcileRules(mined, docs, fakeModel([], () => "same").llm);
    expect(confirmed.rules[0]!.origin).toBe("both");
    const rejected = await reconcileRules(mined, docs, fakeModel([], () => "no").llm);
    expect(rejected.rules[0]!.origin).toBe("enforced");
  });

  it("ignores invalid indices from the first pass", async () => {
    const { llm } = fakeModel([{ ruleIndex: 9, docIndex: 0, relation: "same" }, { ruleIndex: 0, docIndex: 9, relation: "same" }], () => "no");
    const out = await reconcileRules(rules, docRules, llm);
    expect(out.rules.every((r) => r.origin === "enforced")).toBe(true);
  });

  it("never calls an unconfirmed pair documented", async () => {
    const { llm } = fakeModel([{ ruleIndex: 0, docIndex: 0, relation: "same" }, { ruleIndex: 2, docIndex: 2, relation: "same" }], () => "no");
    const out = await reconcileRules(rules, docRules, llm);
    expect(out.rules.map((r) => r.origin)).toEqual(["enforced", "enforced", "enforced"]);
  });

  it("requires a conflict to be confirmed twice", async () => {
    let asked = 0;
    const { llm } = fakeModel([{ ruleIndex: 1, docIndex: 1, relation: "conflict" }], (rule) => (rule.includes("bug fixes") && ++asked === 1 ? "conflict" : "no"));
    const out = await reconcileRules(rules, docRules, llm);
    expect(out.rules[1]!.origin).toBe("enforced");
  });

  it("drops documented-only entries that restate a mined rule, whatever the second look said", async () => {
    const mined = [rule("a", "Use assertRaisesMessage rather than assertRaises when the exception message matters")];
    const docs = [doc("Use assertRaisesMessage rather than assertRaises when the exception message matters", "Prefer assertRaisesMessage."), sign];
    const out = await reconcileRules(mined, docs, fakeModel([], () => "no").llm);
    expect(out.documentedOnly.map((d) => d.description)).toEqual(["Sign commits"]);
  });

  it("makes no model call when there is nothing to compare", async () => {
    const llm: Llm = { parse: async () => { throw new Error("should not be called"); } };
    const out = await reconcileRules(rules, [], llm);
    expect(out.rules.every((r) => r.origin === "enforced")).toBe(true);
    expect(out.documentedOnly).toEqual([]);
  });
});

describe("wordOverlap", () => {
  it("counts shared content words regardless of plural and stop words", () => {
    const o = wordOverlap("Add tests for the new endpoints", "endpoint tests are required");
    expect(o.shared).toBe(2);
    expect(o.share).toBeGreaterThan(0.6);
    expect(wordOverlap("Sign commits", "Name hooks").shared).toBe(0);
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

describe("quoteInText", () => {
  const text = "* In tests, use :meth:`~django.test.SimpleTestCase.assertRaisesMessage` and\n  :meth:`~django.test.SimpleTestCase.assertWarnsMessage` instead of\n  :meth:`~unittest.TestCase.assertRaises` and so you can check the message.";

  it("finds a quote that the model gave without the markup", () => {
    expect(quoteInText("In tests, use assertRaisesMessage and assertWarnsMessage instead of assertRaises", text)).toBe(true);
  });

  it("is not fooled by different wording or a too-short quote", () => {
    expect(quoteInText("In tests, always prefer assertRaises", text)).toBe(false);
    expect(quoteInText("tests", text)).toBe(false);
  });
});

describe("regression fixture", () => {
  it("is well formed", async () => {
    const { cases } = JSON.parse(await (await import("node:fs/promises")).readFile("fixtures/docs-regression.json", "utf8")) as { cases: { id: string; rule: string; quote: string; expected: string }[] };
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(["same", "conflict", "no"]).toContain(c.expected);
      expect(c.rule.length).toBeGreaterThan(10);
      expect(isPointer(c.quote)).toBe(false);
    }
  });
});

describe("proposePairs", () => {
  const rule = (id: string, description: string): Rule => ({
    id,
    description,
    scope: [],
    confidence: 0.6,
    sources: [{ prNumber: 1, reviewer: "anna", commentUrl: "https://github.com/o/r/pull/1#discussion_r1" }],
  });
  const doc = (description: string, quote: string): DocRule => ({ description, path: "CONTRIBUTING.md", quote });

  it("is a pure function of the texts and proposes in both directions", () => {
    const rules = [rule("a", "Mark deprecated code with a RemovedInDjangoXXWarning comment."), rule("b", "Avoid the bare word note in documentation."), rule("c", "Use gate() in tests.")];
    const docs = [
      doc("Raise a RemovedInDjangoXXXXWarning when a deprecated feature is invoked", "should raise a RemovedInDjangoXXXXWarning"),
      doc("Use an admonition with a descriptive title instead of the note directive", "use ``.. admonition:: Descriptive title`` rather than ``.. note::``"),
      doc("Sign commits", "All commits must be signed."),
    ];
    const first = proposePairs(rules, docs);
    expect(proposePairs(rules, docs)).toEqual(first);
    const pairs = first.map((p) => `${p.ruleIndex}:${p.docIndex}`);
    expect(pairs).toContain("0:0"); // placeholder letters XX / XXXX do not hide the shared identifier
    expect(pairs).toContain("1:1"); // the distinctive word "note" links the two
    expect(pairs).not.toContain("2:2"); // nothing in common
  });

  it("never proposes more than the cap, keeping the best-matching pairs", () => {
    const rules = Array.from({ length: 30 }, (_, i) => rule(`r${i}`, `Keep alpha${i} and shared widget helpers documented`));
    const docs = Array.from({ length: 60 }, (_, j) => doc(`Document widget helpers for alpha${j % 30}`, `Always document widget helpers near alpha${j % 30}.`));
    const pairs = proposePairs(rules, docs);
    expect(pairs.length).toBeLessThanOrEqual(150);
    expect(pairs.length).toBeGreaterThan(0);
  });

  it("proposes from the guide side too, so a guide rule always gets its closest mined rules", () => {
    const rules = [rule("a", "Wrap docstrings at 79 columns."), rule("b", "Add a regression test for each bug fix."), rule("c", "Name hooks with a use prefix.")];
    const docs = [doc("Every bug fix needs a regression test", "A good fix should also include a regression test.")];
    const pairs = proposePairs(rules, docs).map((p) => `${p.ruleIndex}:${p.docIndex}`);
    expect(pairs).toContain("1:0");
  });
});
