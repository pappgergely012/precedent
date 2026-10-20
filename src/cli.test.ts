import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const run = (args: string[], env: Record<string, string | undefined> = {}) =>
  spawnSync("npx", ["tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, PRECEDENT_ANTHROPIC_API_KEY: "test-key", GITHUB_TOKEN: undefined, ...env },
  });

describe("cli errors", () => {
  it("prints a one-line error without a stack trace for an invalid repo", () => {
    const r = run(["mine", "nonsense"]);
    expect(r.status).toBe(1);
    expect(r.stderr.trim().split("\n").pop()).toBe('Error: Invalid repo "nonsense", expected "owner/name"');
    expect(r.stderr).not.toContain("    at ");
  });

  it("warns up front when GITHUB_TOKEN is unset", () => {
    const r = run(["mine", "nonsense"]);
    expect(r.stderr).toContain("Warning: GITHUB_TOKEN is not set");
  });

  it("does not need an Anthropic key for a dry run", () => {
    const r = run(["mine", "nonsense", "--dry-run"], { PRECEDENT_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "" });
    expect(r.stderr).not.toContain("Set PRECEDENT_ANTHROPIC_API_KEY");
    expect(r.stderr.trim().split("\n").pop()).toBe('Error: Invalid repo "nonsense", expected "owner/name"');
  });

  it("still requires an Anthropic key", () => {
    const r = run(["mine", "o/r"], { PRECEDENT_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Set PRECEDENT_ANTHROPIC_API_KEY");
  });
});

describe("cli export", () => {
  const rulesFile = (dir: string) => {
    const path = join(dir, "rules.json");
    const sources = [1, 2, 3].map((n) => ({ prNumber: n, reviewer: n === 2 ? "bob" : "anna", commentUrl: `https://github.com/o/r/pull/${n}#discussion_r${n}` }));
    writeFileSync(path, JSON.stringify({ version: 1, repo: "o/r", minedAt: "2026-10-19T00:00:00.000Z", rules: [{ id: "r1", description: "Use gate() in tests.", scope: [], confidence: 0.4, sources }] }));
    return path;
  };

  it("writes the block into a file and keeps existing content on re-export", () => {
    const dir = mkdtempSync(join(tmpdir(), "precedent-"));
    const out = join(dir, "CLAUDE.md");
    writeFileSync(out, "# Hand-written\n");
    for (let i = 0; i < 2; i++) {
      const r = run(["export", "--format", "claude", "--rules", rulesFile(dir), "--out", out]);
      expect(r.status).toBe(0);
    }
    const text = readFileSync(out, "utf8");
    expect(text.startsWith("# Hand-written\n")).toBe(true);
    expect(text.match(/precedent:start/g)).toHaveLength(1);
    expect(text).toContain("Use gate() in tests.");
  });

  it("refuses a file with a stale start marker and leaves it untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "precedent-"));
    const out = join(dir, "AGENTS.md");
    const original = "Intro\n<!-- precedent:start (stale) -->\nMY NOTES\n";
    writeFileSync(out, original);
    const r = run(["export", "--format", "agents", "--rules", rulesFile(dir), "--out", out]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Nothing was written");
    expect(readFileSync(out, "utf8")).toBe(original);
  });

  it("keeps the original as .bak on the first change", () => {
    const dir = mkdtempSync(join(tmpdir(), "precedent-"));
    const out = join(dir, "AGENTS.md");
    writeFileSync(out, "# Mine\n");
    const r = run(["export", "--format", "agents", "--rules", rulesFile(dir), "--out", out]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("AGENTS.md.bak");
    expect(readFileSync(`${out}.bak`, "utf8")).toBe("# Mine\n");
  });

  it("rejects bad numeric flags in one line, never with a stack trace", () => {
    for (const args of [["--max-rules", "-3"], ["--max-rules", "0"], ["--min-confidence", "5"]]) {
      const r = run(["export", "--format", "claude", ...args]);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).not.toMatch(/\n\s+at /);
    }
  });

  it("explains a missing rules file and a bad format in one line", () => {
    const missing = run(["export", "--format", "claude", "--rules", "/nonexistent/rules.json"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('Rules file /nonexistent/rules.json not found. Run "precedent mine owner/repo --out /nonexistent/rules.json" first.');
    const bad = run(["export", "--format", "xml"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("--format must be one of");
  });
});

describe("cli help, version and early validation", () => {
  it("prints usage for --help and help, and the package version for --version", () => {
    for (const args of [["--help"], ["-h"], ["help"]]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.stdout).toContain("precedent mine <owner/repo>");
    }
    const v = run(["--version"]);
    expect(v.status).toBe(0);
    expect(v.stdout.trim()).toBe(JSON.parse(readFileSync("package.json", "utf8")).version);
    expect(run(["-v"]).stdout.trim()).toBe(v.stdout.trim());
  });

  it("explains a missing rules file for review instead of printing ENOENT", () => {
    const r = run(["review", "--diff", "/dev/null", "--rules", "/nonexistent/rules.json"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Rules file /nonexistent/rules.json not found. Run "precedent mine owner/repo --out /nonexistent/rules.json" first.');
    expect(r.stderr).not.toContain("ENOENT");
  });
});

describe("cli review --dry-run", () => {
  it("estimates the calls for a local diff without an API key or a model call, and honours --max-files", () => {
    const dir = mkdtempSync(join(tmpdir(), "precedent-"));
    const sources = [1, 2].map((n) => ({ prNumber: n, reviewer: "anna", commentUrl: `https://github.com/o/r/pull/${n}#discussion_r${n}` }));
    const rules = join(dir, "rules.json");
    writeFileSync(rules, JSON.stringify({ version: 1, repo: "o/r", minedAt: "2026-10-19T00:00:00.000Z", rules: [{ id: "r1", description: "Use gate() in tests.", scope: ["src/**"], confidence: 0.5, sources }] }));
    const file = (name: string) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,1 +1,2 @@\n keep\n+added\n`;
    const diff = join(dir, "pr.diff");
    writeFileSync(diff, [file("src/a.ts"), file("src/b ts/c.ts"), file("docs/readme.md")].join(""));
    const r = run(["review", "--diff", diff, "--rules", rules, "--dry-run"], { PRECEDENT_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Reviewing 3 changed files");
    expect(r.stdout).toContain("2 of 3 files have an applicable rule; 2 model calls");
    expect(r.stdout).toContain("No model call was made.");
    const capped = run(["review", "--diff", diff, "--rules", rules, "--dry-run", "--max-files", "1"], { PRECEDENT_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "" });
    expect(capped.stdout).toContain("1 model calls (cap --max-files 1)");
  });
});
