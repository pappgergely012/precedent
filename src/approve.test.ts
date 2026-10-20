import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { approvedId, approveRules, selectCandidates } from "./approve.js";
import type { Rule } from "./rule.js";

const src = (...ns: number[]) => ns.map((n) => ({ prNumber: n, commentUrl: `https://github.com/o/r/pull/${n}#discussion_r${n}`, reviewer: `u${n % 3}` }));
const rule = (id: string, description: string, ...ns: number[]): Rule => ({ id, description, scope: [], confidence: 0.7, sources: src(...ns) });

describe("approveRules", () => {
  it("pins selected rules under ids derived from their cited comments, so ids do not collide between runs", () => {
    const a = approveRules([], [rule("rule-1", "Use gate().", 1, 2, 3)]);
    const b = approveRules(a.rules, [rule("rule-1", "Name hooks with use.", 4, 5, 6)]); // same run id, different rule
    expect(b.rules.map((r) => r.description)).toEqual(["Use gate().", "Name hooks with use."]);
    expect(new Set(b.rules.map((r) => r.id)).size).toBe(2);
    expect(a.added[0]!.id).toBe(approvedId(rule("x", "other wording", 3, 2, 1)));
  });

  it("never changes or removes an approved rule, and skips a candidate that cites the same comments", () => {
    const first = approveRules([], [rule("rule-1", "Use gate().", 1, 2, 3)]);
    const again = approveRules(first.rules, [rule("rule-9", "Always use gate() in tests", 1, 2, 3, 4)]);
    expect(again.rules).toEqual(first.rules);
    expect(again.added).toEqual([]);
    expect(again.skipped[0]!.reason).toContain(`already approved as ${first.rules[0]!.id}`);
  });

  it("selects by id or by core tier and reports unknown ids", () => {
    const cands = [rule("rule-1", "Core.", 1, 2, 3), { ...rule("rule-2", "Single reviewer.", 3, 6, 9), sources: src(3, 6, 9) }, rule("rule-3", "Thin.", 7)];
    expect(selectCandidates(cands, { ids: ["rule-3", "rule-404"] })).toEqual({ chosen: [cands[2]], unknown: ["rule-404"] });
    expect(selectCandidates(cands, { allCore: true }).chosen.map((r) => r.id)).toEqual(["rule-1"]);
  });
});

describe("cli approve, export and compare with the approved file", () => {
  const cli = resolve("src/cli.ts");
  const tsx = resolve("node_modules/.bin/tsx");
  const dir = mkdtempSync(join(tmpdir(), "precedent-approve-"));
  const sh = (args: string[]) => spawnSync(tsx, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PRECEDENT_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "", GITHUB_TOKEN: "" } });
  const write = (path: string, repo: string, rules: Rule[]) => {
    mkdirSync(join(dir, ".precedent"), { recursive: true });
    writeFileSync(join(dir, path), JSON.stringify({ version: 1, repo, minedAt: "2026-10-20T00:00:00Z", rules }));
  };

  it("lists candidates, approves by id into a team file, refuses to mix repos, and export then uses that file", () => {
    write(".precedent/rules.json", "o/r", [rule("rule-1", "Use gate() in tests.", 1, 2, 3), rule("rule-2", "Avoid default exports.", 4, 5, 6)]);
    const list = sh(["approve"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("rule-1  [core] Use gate() in tests.");
    expect(existsSync(join(dir, ".precedent/approved.json"))).toBe(false);

    expect(sh(["approve", "--id", "rule-404"]).stderr).toContain("No rule with id rule-404");
    const ok = sh(["approve", "--id", "rule-2"]);
    expect(ok.stdout).toContain("1 rule(s) approved into .precedent/approved.json (1 in total)");
    const approved = JSON.parse(readFileSync(join(dir, ".precedent/approved.json"), "utf8"));
    expect(approved.rules.map((r: Rule) => r.description)).toEqual(["Avoid default exports."]);

    const again = sh(["approve", "--id", "rule-2"]);
    expect(again.stdout).toContain("skipped:");
    expect(again.stdout).toContain("nothing written");

    const exported = sh(["export", "--format", "agents"]);
    expect(exported.stderr).toContain("Using the approved rules in .precedent/approved.json");
    expect(exported.stdout).toContain("Avoid default exports.");
    expect(exported.stdout).not.toContain("Use gate() in tests.");

    write(".precedent/other.json", "x/y", [rule("rule-1", "Elsewhere.", 1, 2, 3)]);
    expect(sh(["approve", "--from", ".precedent/other.json", "--all-core"]).stderr).toContain("refusing to mix them");
  });

  it("compare uses the approved file by default", () => {
    const res = sh(["compare"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Compared with the approved rules: 1 unchanged, 0 reworded, 1 new, 0 not found again");
  });
});
