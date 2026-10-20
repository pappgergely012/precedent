import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const dir = resolve("examples/github-action");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const recipe: any = await import(pathToFileURL(join(dir, "scripts/review-pr.mjs")).href);
const fullText = readFileSync(join(dir, "precedent-review.yml"), "utf8");
// The explanatory comments mention the things the file avoids; only the code is checked.
const workflow = fullText.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");

describe("recipe script: sanitize, estimate and decision", () => {
  it("removes escape sequences, html, images, unsafe links and mentions from text that came from a pull request", () => {
    const ESC = String.fromCharCode(27);
    const out = recipe.sanitize(`path: a${ESC}[31mred${ESC}[0m <img src=x> ![p](https://x/y.png) [click](javascript:alert(1)) @everyone @org/team‮`);
    expect(out).not.toMatch(new RegExp(`${ESC}|<img|!\\[|javascript:|‮`));
    expect(out).toContain("`@everyone`");
    expect(out).toContain("`@org/team`");
    expect(out).toContain("&lt;img");
  });
  it("cuts very long output", () => {
    expect(recipe.sanitize("x".repeat(70_000)).length).toBeLessThan(60_100);
  });
  it("reads the model-call estimate and applies the cap", () => {
    expect(recipe.parseDryRun("Dry run: 3 of 4 files have an applicable rule; 3 model calls (cap --max-files 30), roughly 1 input")).toBe(3);
    expect(recipe.parseDryRun("something else")).toBeNull();
    expect(recipe.decide(0, 20).action).toBe("none");
    expect(recipe.decide(20, 20).action).toBe("run");
    expect(recipe.decide(21, 20)).toMatchObject({ action: "skip" });
    expect(recipe.decide(null, 20).action).toBe("skip");
  });
});

describe("recipe script: end to end with a stub CLI (no model, no network)", () => {
  const work = mkdtempSync(join(tmpdir(), "precedent-recipe-"));
  const stub = join(work, "cli.mjs");
  writeFileSync(stub, `
const args = process.argv.slice(2);
const mode = process.env.STUB_MODE;
if (mode === "crash") { console.error("Error: boom\\n at secret path"); process.exit(1); }
if (args.includes("--dry-run")) { console.log("Reviewing 2 changed files of pr.diff against 3 rules."); console.log("Dry run: 2 of 2 files have an applicable rule; " + (process.env.STUB_CALLS ?? "2") + " model calls (cap --max-files 30), roughly 10 input and 5 output tokens."); process.exit(0); }
if (mode === "clean") { console.log("Reviewing 2 changed files of pr.diff against 3 rules."); console.log("No rule violations found."); process.exit(0); }
console.log("[10:00:00] File 1/2 (src/a.ts): 1 findings so far");
console.log("Reviewing 2 changed files of pr.diff against 3 rules.");
console.log("\\n1. src/\\u001b[31ma.ts:3\\nUse gate() here. @everyone\\n\\n**Team rule:** Use gate() in tests.");
`);
  writeFileSync(join(work, "rules.json"), "{}");
  writeFileSync(join(work, "pr.diff"), "diff");
  const go = (over: Record<string, string | undefined> = {}) => {
    const summary = join(work, `summary-${Math.random()}.md`);
    const comment = join(work, `comment-${Math.random()}.md`);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m: string) => void logs.push(String(m));
    try {
      recipe.main({ PRECEDENT_CLI: stub, RULES_FILE: join(work, "rules.json"), DIFF_FILE: join(work, "pr.diff"), PRECEDENT_ANTHROPIC_API_KEY: "k", GITHUB_STEP_SUMMARY: summary, COMMENT_FILE: comment, PATH: process.env.PATH, ...over });
    } finally {
      console.log = orig;
    }
    const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
    return { summary: read(summary), comment: read(comment), logs: logs.join("\n") };
  };

  it("reports findings, sanitised, in the summary and the comment file, with the marker", () => {
    const r = go();
    expect(r.comment).toContain("<!-- precedent-review -->");
    expect(r.comment).toContain("Use gate() here.");
    expect(r.comment).toContain("`@everyone`");
    expect(r.comment).not.toContain(String.fromCharCode(27));
    expect(r.comment).not.toContain("[10:00:00]");
    expect(r.summary).toBe(`${r.comment}\n`);
  });
  it("says so when nothing is found", () => {
    expect(go({ STUB_MODE: "clean" }).comment).toContain("No violations of the approved rules were found");
  });
  it("skips, without calling the model, when the estimate is over the cap", () => {
    const r = go({ STUB_CALLS: "50", MAX_CALLS: "20" });
    expect(r.comment).toContain("Not reviewed:");
    expect(r.comment).toContain("over the cap of 20");
  });
  it("fails open: a crashing CLI, a missing key, a missing rules file all end in a note, never an exception", () => {
    expect(go({ STUB_MODE: "crash" }).comment).toContain("Not reviewed: the estimate failed: Error: boom");
    expect(go({ PRECEDENT_ANTHROPIC_API_KEY: "" }).comment).toContain("no API key is available");
    expect(go({ RULES_FILE: join(work, "missing.json") }).comment).toContain("no approved rules file");
    expect(go({ PRECEDENT_CLI: join(work, "none.mjs") }).comment).toContain("CLI was not found");
  });
  it("never writes the key into the output", () => {
    const r = go({ PRECEDENT_ANTHROPIC_API_KEY: "sk-test-never-print" });
    expect(r.comment + r.summary + r.logs).not.toContain("sk-test-never-print");
  });
});

describe("workflow file: safety properties", () => {
  const stepBlock = (name: string) => {
    const start = workflow.indexOf(`- name: ${name}`);
    expect(start).toBeGreaterThan(-1);
    const next = workflow.indexOf("\n      - ", start + 5);
    return workflow.slice(start, next === -1 ? undefined : next);
  };
  it("uses pull_request, never pull_request_target, and skips fork pull requests and drafts", () => {
    expect(workflow).toMatch(/^on:\n  pull_request:/m);
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });
  it("gives the token only what it needs and bounds the job", () => {
    expect(workflow).toMatch(/permissions:\n  contents: read\n  pull-requests: write/);
    expect(workflow).not.toMatch(/write-all|id-token|actions: write|contents: write/);
    expect(workflow).toContain("timeout-minutes:");
    expect(workflow).toContain("cancel-in-progress: true");
  });
  it("shows the API key to exactly one step, the one that calls the model", () => {
    expect(workflow.match(/secrets\./g)).toHaveLength(1);
    expect(stepBlock("Review against the approved rules")).toContain("secrets.PRECEDENT_ANTHROPIC_API_KEY");
  });
  it("checks out the base commit for rules and never the pull request head; checkouts keep no credentials", () => {
    expect(workflow).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(workflow).not.toMatch(/pull_request\.head\.(sha|ref)|github\.head_ref|github\.sha/);
    const checkouts = workflow.split("uses: actions/checkout@v4").length - 1;
    expect(checkouts).toBe(2);
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
  });
  it("does not put attacker-controlled text into a shell script", () => {
    expect(workflow).not.toMatch(/\$\{\{\s*github\.event\.(pull_request\.(title|body|head)|comment|review|issue)/);
    expect(workflow).not.toMatch(/github\.event\.pull_request\.head\.(ref|label|sha|user)/);
  });
  it("only uses first-party actions plus the pinned engine checkout", () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.every((u) => /^actions\/(checkout|setup-node)@v\d+$/.test(u))).toBe(true);
    expect(workflow).toContain("repository: pappgergely012/precedent");
  });
});
