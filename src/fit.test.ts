import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeFit, fitMetrics, fitTier } from "./fit.js";
import type { ReviewComment } from "./github.js";

const comment = (id: number, reviewer: string, prNumber: number): ReviewComment => ({
  id, prNumber, reviewer, body: "x", path: "a.ts", diffHunk: "@@", url: `https://github.com/o/r/pull/${prNumber}#discussion_r${id}`, createdAt: "2026-01-01T00:00:00Z",
});

/** n comments spread over `reviewers` reviewers (round robin) and `prs` pull requests. */
const spread = (n: number, reviewers: number, prs: number): ReviewComment[] =>
  Array.from({ length: n }, (_, i) => comment(i + 1, `r${i % reviewers}`, 100 + (i % prs)));

describe("fitMetrics", () => {
  it("counts comments, pull requests, reviewers, active reviewers, top share and multi-reviewer pull requests", () => {
    const cs = [comment(1, "a", 1), comment(2, "a", 1), comment(3, "a", 2), comment(4, "b", 2), comment(5, "c", 3)];
    expect(fitMetrics(cs)).toEqual({ comments: 5, prs: 3, reviewers: 3, reviewersGe3: 1, topShare: 0.6, prsMultiReviewer: 1 });
    expect(fitMetrics([])).toEqual({ comments: 0, prs: 0, reviewers: 0, reviewersGe3: 0, topShare: 0, prsMultiReviewer: 0 });
  });
});

describe("fitTier (the survey's proxy)", () => {
  it("is likely with 300+ comments, 8+ active reviewers, top share <= 35% and 30+ multi-reviewer pull requests", () => {
    expect(fitTier(fitMetrics(spread(400, 12, 80)))).toBe("likely");
  });
  it("is possible with 100+ comments, 3+ active reviewers, top share <= 60% and 10+ multi-reviewer pull requests", () => {
    expect(fitTier(fitMetrics(spread(150, 4, 30)))).toBe("possible");
  });
  it("is unlikely with little history, or one dominant reviewer", () => {
    expect(fitTier(fitMetrics(spread(40, 5, 10)))).toBe("unlikely");
    const dominated = [...spread(120, 1, 40), ...spread(20, 5, 20).map((c) => ({ ...c, id: c.id + 1000 }))];
    expect(fitTier(fitMetrics(dominated))).toBe("unlikely");
    expect(fitTier(fitMetrics([]))).toBe("unlikely");
  });
  it("names what is missing for the next tier and says the heuristic's limits", () => {
    const lines = describeFit("o/r", fitMetrics(spread(150, 4, 30)), "in the last 12 months").join("\n");
    expect(lines).toContain("150 inline review comments from 4 reviewers");
    expect(lines).toContain("Core rules are possible");
    expect(lines).toContain('For "likely": 150 comments, needs 300');
    expect(lines).toContain("8 of 11 repositories");
    expect(lines).toContain('"possible" often means few or none');
    expect(describeFit("o/r", fitMetrics([]), "x").join("\n")).toContain("No inline review comments");
  });
  it("marks a count at the cap as 1,000+", () => {
    const capped = describeFit("o/r", fitMetrics(spread(1000, 30, 200)), "x").join("\n");
    expect(capped).toContain("o/r: 1,000+ inline review comments");
    expect(capped).toContain("at least that many");
    expect(describeFit("o/r", fitMetrics(spread(999, 30, 200)), "x").join("\n")).toContain("o/r: 999 inline review comments");
  });
});

describe("cli check on a saved snapshot", () => {
  it("prints the verdict without contacting GitHub or a model", () => {
    const dir = mkdtempSync(join(tmpdir(), "precedent-"));
    const file = join(dir, "snap.json");
    writeFileSync(file, JSON.stringify({ version: 1, repo: "o/r", fetchedAt: "2026-10-20T00:00:00Z", comments: spread(400, 12, 80) }));
    const r = spawnSync("npx", ["tsx", "src/cli.ts", "check", "o/r", "--comments-file", file], { encoding: "utf8", env: { ...process.env, PRECEDENT_ANTHROPIC_API_KEY: "", ANTHROPIC_API_KEY: "" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("o/r: 400 inline review comments from 12 reviewers");
    expect(r.stdout).toContain("Core rules are likely");
  });
});
