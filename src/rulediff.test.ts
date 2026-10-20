import { describe, expect, it } from "vitest";
import type { Rule } from "./rule.js";
import { diffRules, MIN_WORDING_SIMILARITY, renderRuleDiff, wordingSimilarity } from "./rulediff.js";

const src = (...ns: number[]) => ns.map((n) => ({ prNumber: n, commentUrl: `https://github.com/o/r/pull/${n}#discussion_r${n}`, reviewer: `r${n}` }));
const rule = (id: string, description: string, ...ns: number[]): Rule => ({ id, description, scope: [], confidence: 0.6, sources: src(...ns) });

describe("diffRules", () => {
  const approved = [rule("a1", "Use gate() in tests.", 1, 2, 3), rule("a2", "Name hooks with a use prefix.", 4, 5, 6), rule("a3", "Avoid default exports.", 7, 8, 9)];

  it("matches by cited comments, not by wording, and sorts the rest into new and not found again", () => {
    const fresh = [
      rule("f9", "use gate() in tests", 1, 2, 3, 10), // same rule, case and full stop differ only
      rule("f8", "Hooks must start with use.", 4, 5, 99), // 2 of 3 shared: reworded
      rule("f7", "Add a rate limit to endpoints.", 20, 21, 22), // new
    ];
    const d = diffRules(approved, fresh);
    expect(d.same.map((m) => [m.approved.id, m.fresh.id])).toEqual([["a1", "f9"]]);
    expect([...d.reworded, ...d.related].map((m) => [m.approved.id, m.fresh.id])).toEqual([["a2", "f8"]]);
    expect(d.added.map((r) => r.id)).toEqual(["f7"]);
    expect(d.missing.map((r) => r.id)).toEqual(["a3"]);
  });

  it("does not match on a single shared comment out of three, and matches each rule at most once", () => {
    const d = diffRules([rule("a", "One thing.", 1, 2, 3)], [rule("x", "Other.", 3, 50, 51), rule("y", "One thing.", 1, 2, 3), rule("z", "One thing again.", 1, 2, 3)]);
    expect(d.same.length + d.reworded.length).toBe(1);
    expect(d.added).toHaveLength(2);
    expect(d.missing).toHaveLength(0);
  });

  it("gives the same result whatever the input order", () => {
    const fresh = [rule("f1", "Use gate() in tests.", 1, 2, 3), rule("f2", "Use gate() in tests!", 1, 2, 3)];
    const a = diffRules(approved, fresh);
    const b = diffRules([...approved].reverse(), [...fresh].reverse());
    expect(b.same.map((m) => m.fresh.id)).toEqual(a.same.map((m) => m.fresh.id));
    expect(b.added.map((r) => r.id)).toEqual(a.added.map((r) => r.id));
  });

  it("an empty approved set makes every rule new, and an empty run leaves every approved rule not found", () => {
    expect(diffRules([], approved).added).toHaveLength(3);
    expect(diffRules(approved, []).missing).toHaveLength(3);
  });

  it("renders a summary that never says an approved rule should be removed", () => {
    const text = renderRuleDiff(diffRules(approved, [rule("f1", "Add a rate limit.", 20, 21)]));
    expect(text).toContain("0 unchanged, 0 reworded, 0 related, 1 new, 3 not found again");
    expect(text).toContain("+ Add a rate limit. (2 comments)");
    expect(text).toContain("keep unless the team retires it");
  });
});

describe("diffRules: edge cases from review and QA", () => {
  it("lists new candidates that share a comment with an approved rule, with the count", () => {
    const d = diffRules([rule("a", "Approved rule.", 1, 2, 3, 4)], [rule("f", "Different wording entirely.", 4, 50, 51)]);
    expect(d.added).toHaveLength(1);
    expect(d.sharing.get(d.added[0]!)![0]).toMatchObject({ shared: 1 });
    expect(renderRuleDiff(d)).toContain("related to approved: Approved rule. (1 shared comment)");
  });

  it("a one-source approved rule is absorbed by a large fresh rule that cites its comment and says similar things", () => {
    const d = diffRules([rule("a", "Name hooks with a use prefix.", 1)], [rule("f", "Hooks should have a use prefix in the name.", 1, 2, 3, 4, 5, 6)]);
    expect(d.reworded).toHaveLength(1);
  });

  it("same evidence with different wording goes to a separate 'related' bucket: not reworded, not new, not missing", () => {
    const approved = [rule("a", "No docstrings in tests.", 1, 2, 3)];
    const fresh = [rule("f", "Do not put ticket numbers in test comments.", 1, 2, 3, 4)];
    const d = diffRules(approved, fresh);
    expect(d.related.map((m) => [m.approved.id, m.fresh.id])).toEqual([["a", "f"]]);
    expect(d.same.length + d.reworded.length + d.added.length + d.missing.length).toBe(0);
    const text = renderRuleDiff(d);
    expect(text).toContain("1 related, 0 new, 0 not found again");
    expect(text).toContain("decide if it is the same rule");
  });

  it("similar wording with the same evidence is reworded", () => {
    const d = diffRules([rule("a", "Name hooks with a use prefix.", 1, 2, 3)], [rule("f", "Hooks should have a use prefix in the name.", 1, 2, 3)]);
    expect(d.reworded).toHaveLength(1);
    expect(d.related).toHaveLength(0);
  });

  it("measures wording by words, ignoring case, punctuation and short words", () => {
    expect(wordingSimilarity("Use gate() in tests.", "use GATE in the tests")).toBeGreaterThanOrEqual(MIN_WORDING_SIMILARITY);
    expect(wordingSimilarity("No docstrings in tests.", "Do not put ticket numbers in test comments.")).toBeLessThan(MIN_WORDING_SIMILARITY);
  });

  it("reports rules without sources as cannot be matched instead of producing NaN", () => {
    const empty = { ...rule("e", "No evidence.", 1), sources: [] };
    const d = diffRules([empty], [rule("f", "Fresh.", 1, 2)]);
    expect(d.unmatchable.map((r) => r.id)).toEqual(["e"]);
    expect(d.same.length + d.reworded.length).toBe(0);
    expect(renderRuleDiff(d)).toContain("Cannot be matched");
  });

  it("prints rule text on one line without escape sequences or forged lines", () => {
    const evil = "Real rule\n  + FORGED approved rule \u001b[31mred\u001b[0m \u001b]0;title\u0007 end ‮abc";
    const out = renderRuleDiff(diffRules([], [rule("f", evil, 1, 2)]));
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f‮]/);
    expect(out.split("\n").filter((l) => l.startsWith("  + "))).toHaveLength(1);
    expect(out).toContain("Real rule + FORGED approved rule red end abc");
  });
});
