import { describe, expect, it } from "vitest";
import { renderMineOutput } from "./mineoutput.js";
import type { Rule } from "./rule.js";

const rule = (id: string, reviewers: string[], extra: Partial<Rule> = {}): Rule => ({
  id,
  description: `Rule ${id}`,
  scope: [],
  confidence: 0.6,
  sources: reviewers.map((reviewer, i) => ({ prNumber: i + 1, reviewer, commentUrl: `https://github.com/o/r/pull/${i + 1}#discussion_r${i + 1}` })),
  ...extra,
});

const core = (id: string) => rule(id, ["anna", "bob", "cy"]); // 3 comments, 3 reviewers
const emerging = (id: string) => rule(id, ["anna", "bob"]); // 2 comments

describe("renderMineOutput", () => {
  it("lists the core rules and only counts the emerging candidates by default", () => {
    const text = renderMineOutput([core("a"), emerging("b"), core("c")]).join("\n");
    expect(text).toContain("2 core rules (3+ comments from 2+ reviewers) and 1 emerging candidates");
    expect(text).toContain("Rule a");
    expect(text).toContain("Rule c");
    expect(text).not.toContain("Rule b");
    expect(text).toContain("1 emerging candidates not shown. Add --all to list them");
  });

  it("lists the emerging candidates in their own section with --all", () => {
    const text = renderMineOutput([core("a"), emerging("b")], { all: true }).join("\n");
    expect(text).toContain("Core rules:");
    expect(text.indexOf("Rule a")).toBeLessThan(text.indexOf("Emerging candidates"));
    expect(text.indexOf("Emerging candidates")).toBeLessThan(text.indexOf("Rule b"));
    expect(text).not.toContain("not shown");
  });

  it("says so when there is no core rule, and still counts the candidates", () => {
    const text = renderMineOutput([emerging("b")]).join("\n");
    expect(text).toContain("0 core rules");
    expect(text).toContain("No core rules were found.");
    expect(text).toContain("1 emerging candidates not shown");
  });

  it("says when nothing was found at all", () => {
    expect(renderMineOutput([]).join("\n")).toContain("No recurring rules found.");
  });

  it("caps each list and says how many there are", () => {
    const many = Array.from({ length: 12 }, (_, i) => core(`r${i}`));
    const text = renderMineOutput(many, { top: 5 }).join("\n");
    expect(text).toContain("Core rules (top 5 of 12):");
    expect(text).toContain("Rule r4");
    expect(text).not.toContain("Rule r5");
  });

  it("shows the documentation tags", () => {
    const tagged = core("a");
    tagged.origin = "both";
    tagged.docRefs = [{ path: "CONTRIBUTING.md", quote: "Do the thing." }];
    expect(renderMineOutput([tagged]).join("\n")).toContain('documented in CONTRIBUTING.md: "Do the thing."');
  });
});
