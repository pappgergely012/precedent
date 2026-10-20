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
    expect(out).not.toContain("<");
  });
  it("removes links that came from a file name or rule text, but keeps the evidence links the engine builds for this repository", () => {
    const text = [
      "1. `docs/[click here](https://evil.example/x).md:3`",
      "Reviewers asked for this before in [#12](https://github.com/o/r/pull/12#discussion_r34), [#13](https://github.com/other/repo/pull/13#discussion_r35) and [#14](https://evil.example/pull/14#discussion_r1).",
      "See [ref][1] and www.evil.example and https://evil.example/y and <https://evil.example/z>",
      "[1]: https://evil.example/ref",
    ].join("\n");
    const out = recipe.sanitize(text, 60_000, "o/r");
    expect(out).toContain("docs/click here.md:3");
    expect(out).toContain("[#12](https://github.com/o/r/pull/12#discussion_r34)");
    expect(out).not.toMatch(/evil\.example|other\/repo/);
    expect(out.match(/\]\(/g)).toHaveLength(1); // only the evidence link of this repository
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
  const stepBlocks = workflow.split(/\n      - (?=name:)/).slice(1);
  const jobBlock = (name: string) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    expect(start).toBeGreaterThan(-1);
    const rest = workflow.slice(start + 1);
    const next = rest.search(/\n  [a-z]+:\n/);
    return next === -1 ? rest : rest.slice(0, next);
  };
  it("uses pull_request, never pull_request_target, and skips fork pull requests and drafts", () => {
    expect(workflow).toMatch(/^on:\n  pull_request:/m);
    expect(workflow).not.toContain("pull_request_target");
    expect(jobBlock("review")).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(jobBlock("comment")).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });
  it("is read-only by default; only the comment job, which holds no key, has a write token", () => {
    expect(workflow).toMatch(/\npermissions:\n  contents: read\n/);
    expect(workflow.match(/pull-requests: write/g)).toHaveLength(1);
    expect(jobBlock("comment")).toContain("pull-requests: write");
    expect(jobBlock("comment")).not.toContain("secrets.");
    expect(jobBlock("review")).not.toMatch(/write/);
    expect(workflow).not.toMatch(/write-all|id-token|actions: write|contents: write/);
  });
  it("bounds the jobs", () => {
    expect(workflow.match(/timeout-minutes:/g)).toHaveLength(2);
    expect(workflow).toContain("cancel-in-progress: true");
  });
  it("is fail-open: both jobs and every step after the configuration check may fail without failing the run", () => {
    expect(jobBlock("review")).toMatch(/\n    continue-on-error: true/);
    expect(jobBlock("comment")).toMatch(/\n    continue-on-error: true/);
    const others = stepBlocks.filter((b) => !b.startsWith("name: Check the configuration"));
    expect(others.length).toBeGreaterThanOrEqual(8);
    for (const block of others) expect(block, block.split("\n")[0]).toContain("continue-on-error: true");
  });
  it("ends green with a note while the engine pin is still the placeholder", () => {
    const config = stepBlocks.find((b) => b.startsWith("name: Check the configuration"))!;
    expect(config).toContain("REPLACE_WITH_A_FULL_COMMIT_SHA");
    expect(config).toContain("Not reviewed: set PRECEDENT_ENGINE_REF");
    expect(config).not.toMatch(/exit 1/);
    for (const block of stepBlocks.filter((b) => !b.startsWith("name: Check the configuration") && !b.startsWith("name: Get the comment text") && !b.startsWith("name: Post or update"))) {
      expect(block, block.split("\n")[0]).toContain("steps.config.outputs.ready == 'true'");
    }
  });
  it("shows the API key to exactly one step, the one that calls the model", () => {
    expect(workflow.match(/secrets\./g)).toHaveLength(1);
    expect(stepBlocks.find((b) => b.startsWith("name: Review against"))).toContain("secrets.PRECEDENT_ANTHROPIC_API_KEY");
  });
  it("checks out the base commit for rules and never the pull request head; checkouts keep no credentials", () => {
    expect(workflow).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(workflow).not.toMatch(/pull_request\.head\.(sha|ref)|github\.head_ref|github\.sha/);
    expect(workflow.match(/uses: actions\/checkout@/g)).toHaveLength(2);
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
  });
  it("does not put attacker-controlled text into a shell script", () => {
    expect(workflow).not.toMatch(/\$\{\{\s*github\.event\.(pull_request\.(title|body|head)|comment|review|issue)/);
    expect(workflow).not.toMatch(/github\.event\.pull_request\.head\.(ref|label|sha|user)/);
  });
  it("uses only first-party actions, each pinned to a full commit SHA, and pins and hardens the package manager", () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThanOrEqual(5);
    expect(uses.every((u) => /^actions\/(checkout|setup-node|upload-artifact|download-artifact)@[0-9a-f]{40}$/.test(u))).toBe(true);
    expect(workflow).toContain("repository: pappgergely012/precedent");
    expect(workflow).toMatch(/pnpm@\d+\.\d+\.\d+/);
    expect(workflow).toContain("--ignore-scripts");
  });
  it("finds its own earlier comment by the bot login and marker, not by a lookalike", () => {
    expect(workflow).toContain('.user.login == "github-actions[bot]"');
    expect(workflow).toContain("<!-- precedent-review -->");
  });
});

describe("file names in the review output", () => {
  it("codeSpan keeps a file name from ending its code span, becoming a link or adding lines", async () => {
    const { codeSpan } = await import("./terminal.js");
    const out = codeSpan("docs/[click here](https://evil.example/x)`\n+ forged.md:3");
    expect(out.startsWith("`") && out.endsWith("`")).toBe(true);
    expect(out.slice(1, -1)).not.toMatch(/[`\[\]()<>\n]/);
  });
});

describe("recipe script: bounded work and fail-open writes", () => {
  it("handles very long runs of unmatched < and [ in linear time", () => {
    for (const filler of ["<", "[", "<a ", "[x](", "<img "]) {
      const start = Date.now();
      const out = recipe.sanitize(filler.repeat(Math.ceil(160_000 / filler.length)));
      expect(typeof out).toBe("string");
      expect(Date.now() - start, `filler ${JSON.stringify(filler)}`).toBeLessThan(1500);
    }
  });
  it("defuses e-mail addresses so GitHub does not turn them into mailto links", () => {
    const out = recipe.sanitize("contact dana.smith+x@example.co.uk or ops@corp.example for details");
    expect(out).not.toMatch(/[\w.]@[\w.]/);
    expect(out).toContain("dana.smith+x`@`example.co.uk");
  });
  it("still exits normally when the summary or comment file cannot be written", () => {
    const work = mkdtempSync(join(tmpdir(), "precedent-unwritable-"));
    const warns: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (m: string) => void warns.push(String(m));
    console.log = () => {};
    try {
      expect(() => recipe.main({ GITHUB_STEP_SUMMARY: work, COMMENT_FILE: join(work, "no", "such", "dir", "c.md"), PATH: process.env.PATH })).not.toThrow();
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }
    expect(warns.join("\n")).toContain("could not write the job summary");
    expect(warns.join("\n")).toContain("could not write the comment file");
  });
});
