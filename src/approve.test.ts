import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(selectCandidates(cands, { ids: ["rule-3", "rule-404"] })).toEqual({ chosen: [cands[2]], unknown: ["rule-404"], duplicateIds: [] });
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
    expect(res.stdout).toContain("Compared with the approved rules: 1 unchanged, 0 reworded, 0 related, 1 new, 0 not found again");
  });
});

describe("cli: files are never overwritten by their own output", () => {
  const cli = resolve("src/cli.ts");
  const tsx = resolve("node_modules/.bin/tsx");
  const dir = mkdtempSync(join(tmpdir(), "precedent-safe-"));
  const sh = (args: string[]) => spawnSync(tsx, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PRECEDENT_ANTHROPIC_API_KEY: "", GITHUB_TOKEN: "" } });
  const put = (name: string, repo: string, rules: Rule[]) => writeFileSync(join(dir, name), JSON.stringify({ version: 1, repo, minedAt: "2026-10-20T00:00:00Z", rules }));
  const three = [rule("r1", "One.", 1, 2, 3), rule("r2", "Two.", 4, 5, 6), rule("r3", "Three.", 7, 8, 9)];

  it("compare --out equal to an input (also through a symlink) is refused and the file is untouched", () => {
    put("a.json", "o/r", three);
    put("b.json", "o/r", [rule("r9", "New.", 20, 21, 22)]);
    symlinkSync("a.json", join(dir, "link.json"));
    const before = readFileSync(join(dir, "a.json"), "utf8");
    for (const out of ["a.json", "./a.json", "link.json", "b.json"]) {
      const r = sh(["compare", "--approved", "a.json", "--rules", "b.json", "--out", out]);
      expect(r.status, out).toBe(1);
      expect(r.stderr).toContain("is one of the input files");
    }
    expect(readFileSync(join(dir, "a.json"), "utf8")).toBe(before);
  });

  it("approve refuses --to equal to --from", () => {
    const r = sh(["approve", "--from", "a.json", "--to", "link.json", "--all-core"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("are the same file");
  });

  it("a broken rules file names the failing field, and different repos produce a warning", () => {
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ version: 1, repo: "o/r", minedAt: "x", rules: [{ id: "x" }] }));
    expect(sh(["compare", "--approved", "bad.json", "--rules", "a.json"]).stderr).toMatch(/bad\.json is not a rules file: rules\.0\./);
    put("other.json", "x/y", three);
    const r = sh(["compare", "--approved", "a.json", "--rules", "other.json"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("Warning: the approved rules are for o/r but the new run is for x/y");
  });

  it("an option missing its value gets a one-line hint instead of the bare 'ambiguous' error", () => {
    expect(sh(["mine", "o/r", "--cache", "--no-cache"]).stderr).toContain("cannot be followed by another option");
  });
});

describe("hand-written rules, export header, approved export and minedAt", () => {
  const cli = resolve("src/cli.ts");
  const tsx = resolve("node_modules/.bin/tsx");
  const dir = mkdtempSync(join(tmpdir(), "precedent-hand-"));
  const sh = (args: string[]) => spawnSync(tsx, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PRECEDENT_ANTHROPIC_API_KEY: "", GITHUB_TOKEN: "" } });
  const put = (name: string, rules: unknown[], minedAt = "2026-01-02T00:00:00Z") => {
    mkdirSync(join(dir, ".precedent"), { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify({ version: 1, repo: "o/r", minedAt, rules }));
  };
  const handWritten = { id: "t1", description: "Every endpoint needs a rate limit.", scope: [], confidence: 1 };

  it("a rule your team wrote by hand (no cited comments) works in export and compare", () => {
    put("hand.json", [handWritten]);
    const exp = sh(["export", "--format", "agents", "--rules", "hand.json", "--include-emerging", "--include-single-reviewer"]);
    expect(exp.status).toBe(0);
    expect(exp.stdout).toContain("Every endpoint needs a rate limit.");
    const cmp = sh(["compare", "--approved", "hand.json", "--rules", "hand.json"]);
    expect(cmp.status).toBe(0);
    expect(cmp.stdout).toContain("Cannot be matched (no source comments)");
  });

  it("the export header names the file the rules came from", () => {
    const exp = sh(["export", "--format", "agents", "--rules", "hand.json", "--include-emerging", "--include-single-reviewer"]);
    expect(exp.stdout).toContain("edit hand.json and re-run");
    expect(exp.stdout).not.toContain("edit .precedent/rules.json");
  });

  it("export of the approved file includes every approved rule, even thin ones", () => {
    put(".precedent/approved.json", [handWritten, { ...rule("a-thin", "Thin but approved.", 1), confidence: 0.2 }]);
    const exp = sh(["export", "--format", "agents"]);
    expect(exp.stdout).toContain("Every endpoint needs a rate limit.");
    expect(exp.stdout).toContain("Thin but approved.");
    expect(exp.stdout).toContain("edit .precedent/approved.json and re-run");
  });

  it("compare --out keeps the fresh run's minedAt", () => {
    put("fresh.json", [rule("f", "Brand new rule.", 90, 91, 92)], "2026-03-04T05:06:07Z");
    const out = join(dir, "cands.json");
    expect(sh(["compare", "--approved", "hand.json", "--rules", "fresh.json", "--out", out]).status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).minedAt).toBe("2026-03-04T05:06:07Z");
  });
});

describe("approve marks its file so export shows everything, wherever it is saved", () => {
  const cli = resolve("src/cli.ts");
  const tsx = resolve("node_modules/.bin/tsx");
  const dir = mkdtempSync(join(tmpdir(), "precedent-kind-"));
  const sh = (args: string[]) => spawnSync(tsx, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PRECEDENT_ANTHROPIC_API_KEY: "", GITHUB_TOKEN: "" } });
  const thin = { ...rule("rule-1", "Thin but chosen.", 1), confidence: 0.2 };

  it("a file written by approve --to elsewhere is exported whole; a plain rules file is not, unless --all", () => {
    writeFileSync(join(dir, "cands.json"), JSON.stringify({ version: 1, repo: "o/r", minedAt: "2026-02-03T00:00:00Z", rules: [thin] }));
    expect(sh(["approve", "--from", "cands.json", "--to", "team.json", "--id", "rule-1"]).status).toBe(0);
    const saved = JSON.parse(readFileSync(join(dir, "team.json"), "utf8"));
    expect(saved.kind).toBe("approved");
    expect(saved.minedAt).toBe("2026-02-03T00:00:00Z");
    expect(sh(["export", "--format", "agents", "--rules", "team.json"]).stdout).toContain("Thin but chosen.");
    expect(sh(["export", "--format", "agents", "--rules", "cands.json"]).stdout).not.toContain("Thin but chosen.");
    expect(sh(["export", "--format", "agents", "--rules", "cands.json", "--all"]).stdout).toContain("Thin but chosen.");
  });
});

describe("approve --note", () => {
  const cli = resolve("src/cli.ts");
  const tsx = resolve("node_modules/.bin/tsx");
  const dir = mkdtempSync(join(tmpdir(), "precedent-note-"));
  const sh = (args: string[]) => spawnSync(tsx, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PRECEDENT_ANTHROPIC_API_KEY: "", GITHUB_TOKEN: "" } });
  const NOTE = "Agreed in the Oct review meeting; owner: dana";

  it("stores the note on newly approved rules, shows it in approve and compare, and never exports it or puts it in a prompt", async () => {
    writeFileSync(join(dir, "cands.json"), JSON.stringify({ version: 1, repo: "o/r", minedAt: "2026-02-03T00:00:00Z", rules: [rule("rule-1", "Use gate() in tests.", 1, 2, 3), rule("rule-2", "Avoid default exports.", 4, 5, 6)] }));
    const res = sh(["approve", "--from", "cands.json", "--to", "team.json", "--id", "rule-1", "--note", NOTE]);
    expect(res.stdout).toContain(`with the note "${NOTE}"`);
    const saved = JSON.parse(readFileSync(join(dir, "team.json"), "utf8"));
    expect(saved.rules[0].note).toBe(NOTE);

    // a later run that no longer has the rule: compare shows the note next to it
    writeFileSync(join(dir, "later.json"), JSON.stringify({ version: 1, repo: "o/r", minedAt: "2026-03-03T00:00:00Z", rules: [rule("rule-9", "Something else.", 50, 51, 52)] }));
    expect(sh(["compare", "--approved", "team.json", "--rules", "later.json"]).stdout).toContain(`[note: ${NOTE}]`);

    expect(sh(["export", "--format", "agents", "--rules", "team.json"]).stdout).not.toContain("Oct review meeting");

    const { reviewPrompt } = await import("./review.js");
    expect(reviewPrompt({ path: "a.ts", patch: "1: +x", addedLines: new Set([1]) }, saved.rules, 12000)).not.toContain("Oct review meeting");
  });

  it("rejects notes over 500 characters at the schema, and trims what the CLI stores", () => {
    const long = "x".repeat(600);
    writeFileSync(join(dir, "c2.json"), JSON.stringify({ version: 1, repo: "o/r", minedAt: "2026-02-03T00:00:00Z", rules: [rule("rule-1", "Use gate() in tests.", 1, 2, 3)] }));
    expect(sh(["approve", "--from", "c2.json", "--to", "t2.json", "--id", "rule-1", "--note", long]).status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "t2.json"), "utf8")).rules[0].note).toHaveLength(500);
  });
});

describe("stress-QA fixes: near-duplicates, duplicate ids, BOM, EPIPE, unsafe links", () => {
  it("--all-core style approval skips a candidate that cites the same comments as an approved rule but says it differently; naming it with --id approves it with a warning", () => {
    const first = approveRules([], [rule("rule-1", "No docstrings in tests.", 1, 2, 3)]);
    const near = rule("rule-5", "Do not put ticket numbers in test comments.", 1, 2, 3, 4);
    const auto = approveRules(first.rules, [near]);
    expect(auto.added).toEqual([]);
    expect(auto.skipped[0]!.reason).toContain("related to approved");
    const named = approveRules(first.rules, [near], { explicit: new Set([near]) });
    expect(named.added).toHaveLength(1);
    expect(named.warned[0]!.relatedTo.id).toBe(first.rules[0]!.id);
    expect(approveRules(first.rules, [near], { forceRelated: true }).added).toHaveLength(1);
  });

  it("selectCandidates reports duplicate ids instead of silently taking the last", () => {
    const a = rule("rule-1", "One.", 1, 2, 3);
    const b = rule("rule-1", "Two.", 4, 5, 6);
    expect(selectCandidates([a, b], { ids: ["rule-1"] }).duplicateIds).toEqual(["rule-1"]);
  });

  const cli = resolve("src/cli.ts");
  const tsx = resolve("node_modules/.bin/tsx");
  const dir = mkdtempSync(join(tmpdir(), "precedent-stress-"));
  const sh = (args: string[], input?: string) => spawnSync(tsx, [cli, ...args], { cwd: dir, encoding: "utf8", input, env: { ...process.env, PRECEDENT_ANTHROPIC_API_KEY: "", GITHUB_TOKEN: "" } });

  it("reads a rules file that starts with a UTF-8 byte order mark, rejects a directory and duplicate ids in one line", () => {
    const body = JSON.stringify({ version: 1, repo: "o/r", minedAt: "2026-01-01T00:00:00Z", rules: [rule("rule-1", "One.", 1, 2, 3), rule("rule-1", "Two.", 4, 5, 6)] });
    writeFileSync(join(dir, "bom.json"), String.fromCharCode(0xfeff) + body);
    expect(sh(["approve", "--from", "bom.json", "--list"]).status).toBe(0);
    mkdirSync(join(dir, "adir"), { recursive: true });
    expect(sh(["approve", "--from", "adir", "--list"]).stderr).toContain("is a directory");
    const dup = sh(["approve", "--from", "bom.json", "--to", "o.json", "--id", "rule-1"]);
    expect(dup.status).toBe(1);
    expect(dup.stderr).toContain("More than one rule");
  });

  it("export removes javascript:, data: and file: links from rule text but keeps the label", () => {
    const evil = rule("rule-1", "See [the docs](javascript:alert(1)) and [x](data:text/html,hi) or file:///etc/passwd today", 1, 2, 3);
    writeFileSync(join(dir, "evil.json"), JSON.stringify({ version: 1, repo: "o/r", minedAt: "2026-01-01T00:00:00Z", rules: [evil] }));
    const out = sh(["export", "--format", "agents", "--rules", "evil.json", "--all"]).stdout;
    expect(out).toContain("See the docs and x or [link removed] today");
    expect(out).not.toMatch(/javascript:|data:text|file:\/\//);
  });

  it("compare piped into a reader that closes early ends quietly (needs more output than one pipe buffer)", () => {
    const many = Array.from({ length: 3000 }, (_, i) => rule(`r${i}`, `Rule number ${i} about topic ${i} ${"word ".repeat(40)}`, 10 + i * 3, 11 + i * 3, 12 + i * 3));
    writeFileSync(join(dir, "big.json"), JSON.stringify({ version: 1, repo: "o/r", minedAt: "2026-01-01T00:00:00Z", rules: many }));
    writeFileSync(join(dir, "none.json"), JSON.stringify({ version: 1, repo: "o/r", minedAt: "2026-01-01T00:00:00Z", rules: [rule("z", "Other.", 90000, 90001)] }));
    const res = spawnSync("sh", ["-c", `${tsx} ${cli} compare --approved none.json --rules big.json | head -1 >/dev/null`], { cwd: dir, encoding: "utf8", env: { ...process.env } });
    expect(res.stderr).not.toContain("EPIPE");
    expect(res.stderr).not.toContain("    at ");
  });
});
