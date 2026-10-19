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

  it("still requires an Anthropic key", () => {
    const r = run(["mine", "o/r"], { PRECEDENT_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Set PRECEDENT_ANTHROPIC_API_KEY");
  });
});

describe("cli export", () => {
  const rulesFile = (dir: string) => {
    const path = join(dir, "rules.json");
    const sources = [1, 2].map((n) => ({ prNumber: n, reviewer: n === 1 ? "anna" : "bob", commentUrl: `https://github.com/o/r/pull/${n}#discussion_r${n}` }));
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

  it("explains a missing rules file and a bad format in one line", () => {
    const missing = run(["export", "--format", "claude", "--rules", "/nonexistent/rules.json"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('Rules file /nonexistent/rules.json not found. Run "precedent mine owner/repo --out /nonexistent/rules.json" first.');
    const bad = run(["export", "--format", "xml"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("--format must be one of");
  });
});
