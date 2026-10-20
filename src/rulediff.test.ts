import { describe, expect, it } from "vitest";
import type { Rule } from "./rule.js";
import { diffRules, renderRuleDiff } from "./rulediff.js";

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
    expect(d.reworded.map((m) => [m.approved.id, m.fresh.id])).toEqual([["a2", "f8"]]);
    expect(d.added.map((r) => r.id)).toEqual(["f7"]);
    expect(d.missing.map((r) => r.id)).toEqual(["a3"]);
  });

  it("does not match on a single shared comment out of three, and matches each rule at most once", () => {
    const d = diffRules([rule("a", "One.", 1, 2, 3)], [rule("x", "Other.", 3, 50, 51), rule("y", "Same thing.", 1, 2, 3), rule("z", "Same thing again.", 1, 2, 3)]);
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
    expect(text).toContain("0 unchanged, 0 reworded, 1 new, 3 not found again");
    expect(text).toContain("+ Add a rate limit. (2 comments)");
    expect(text).toContain("keep unless the team retires it");
  });
});
