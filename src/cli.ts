#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseDiff } from "./diff.js";
import { extractRules, isSingleReviewer } from "./extract.js";
import { fetchPullDiff, fetchReviewComments, postPullReview } from "./github.js";
import { anthropicLlm } from "./llm.js";
import { verifyRules } from "./verify.js";
import { formatComment, reviewDiff } from "./review.js";
import { summarizeStability } from "./stability.js";
import { readRulesFile, writeRulesFile } from "./rulesfile.js";

const USAGE = `Usage:
  precedent mine <owner/repo> [--out FILE] [--max-pages N] [--max-comments N] [--min-occurrences N] [--max-age-days N] [--verify]
  precedent stability <owner/repo> [--runs N] [--max-comments N]
  precedent review <owner/repo> <pr-number> [--rules FILE] [--post]
  precedent review --diff FILE [--rules FILE]`;

const DEFAULT_RULES_FILE = ".precedent/rules.json";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    rules: { type: "string" },
    diff: { type: "string" },
    post: { type: "boolean" },
    verify: { type: "boolean" },
    "max-pages": { type: "string" },
    runs: { type: "string" },
    "max-comments": { type: "string" },
    "min-occurrences": { type: "string" },
    "max-age-days": { type: "string" },
  },
});
const [command, repo, prArg] = positionals;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Read `--name <positive integer>`, or use the fallback when the flag is absent. */
function intFlag(name: keyof typeof values, fallback: number): number {
  const raw = values[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) fail(`--${name} needs a positive integer.`);
  return value;
}

function requireAnthropicKey(): void {
  if (!process.env.PRECEDENT_ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    fail("Set PRECEDENT_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY).");
  }
}

const progress = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

async function main(): Promise<void> {
  if (command === "mine" && repo) {
    requireAnthropicKey();
    if (!process.env.GITHUB_TOKEN) {
      console.warn("Warning: GITHUB_TOKEN is not set. Unauthenticated requests are limited to 60 per hour and mining a large repository will hit the limit.");
    }
    const comments = await fetchReviewComments(repo, {
      token: process.env.GITHUB_TOKEN,
      maxPages: intFlag("max-pages", 30),
    });
    const prs = new Set(comments.map((c) => c.prNumber));
    console.log(`Fetched ${comments.length} review comments from ${prs.size} pull requests in ${repo}.`);

    let rules = await extractRules(comments, anthropicLlm(), {
      maxComments: intFlag("max-comments", 1000),
      minOccurrences: intFlag("min-occurrences", 2),
      maxAgeDays: intFlag("max-age-days", 730),
      onProgress: progress,
    });
    if (values.verify) {
      const before = rules.length;
      rules = await verifyRules(repo, rules, { token: process.env.GITHUB_TOKEN, minOccurrences: intFlag("min-occurrences", 2) });
      console.log(`Verified citations: kept ${rules.length} of ${before} rules.`);
    }
    if (rules.length === 0) {
      console.log("No recurring rules found.");
    }
    const TOP = 10;
    if (rules.length > TOP) console.log(`Showing the top ${TOP} of ${rules.length} rules.`);
    rules.slice(0, TOP).forEach((rule, i) => {
      const scope = rule.scope.length ? ` (${rule.scope.join(", ")})` : "";
      console.log(`\n${i + 1}. ${rule.description}${scope}`);
      const flag = isSingleReviewer(rule) ? ", single reviewer" : "";
      console.log(`   confidence ${rule.confidence.toFixed(2)}, ${rule.sources.length} comments${flag}:`);
      for (const s of rule.sources.slice(0, 3)) console.log(`   - #${s.prNumber} @${s.reviewer} ${s.commentUrl}`);
    });
    if (values.out) {
      await writeRulesFile(values.out, repo, rules);
      console.log(`\nWrote ${rules.length} rules to ${values.out}`);
    }
  } else if (command === "stability" && repo) {
    requireAnthropicKey();
    const runs = intFlag("runs", 3);
    const comments = await fetchReviewComments(repo, { token: process.env.GITHUB_TOKEN, maxPages: intFlag("max-pages", 30) });
    console.log(`Fetched ${comments.length} review comments once; mining ${runs} times (each run costs about as much as one \`mine\`).`);
    const results = [];
    for (let i = 1; i <= runs; i++) {
      results.push(await extractRules(comments, anthropicLlm(), { maxComments: intFlag("max-comments", 1000) }));
      console.log(`Run ${i}/${runs}: ${results[i - 1]!.length} rules`);
    }
    const s = summarizeStability(results);
    console.log(`\nRule counts per run: ${s.ruleCounts.join(", ")}`);
    console.log(`Mean pairwise overlap (Jaccard): ${s.meanOverlap.toFixed(2)}, worst pair: ${s.minOverlap.toFixed(2)}`);
    console.log(`Rules of run 1 found in every other run: ${s.inAllRuns}/${s.ruleCounts[0]}, in at least half: ${s.inMajority}/${s.ruleCounts[0]}`);
  } else if (command === "review" && (values.diff || (repo && prArg))) {
    requireAnthropicKey();
    const token = process.env.GITHUB_TOKEN;
    let prNumber = 0;
    if (!values.diff) {
      prNumber = Number(prArg);
      if (!Number.isInteger(prNumber) || prNumber < 1) fail(`Invalid pull request number "${prArg}".`);
    }
    if (values.post && (values.diff || !token)) {
      fail("--post needs a pull request and GITHUB_TOKEN with permission to write pull request reviews.");
    }

    const { rules } = await readRulesFile(values.rules ?? DEFAULT_RULES_FILE);
    const diffText = values.diff ? await readFile(values.diff, "utf8") : await fetchPullDiff(repo!, prNumber, { token });
    const files = parseDiff(diffText);
    const target = values.diff ? values.diff : `${repo}#${prNumber}`;
    console.log(`Reviewing ${files.length} changed files of ${target} against ${rules.length} rules.`);

    const violations = await reviewDiff(files, rules, anthropicLlm(), { onProgress: progress });
    const byId = new Map(rules.map((r) => [r.id, r]));
    const comments = violations.map((v) => ({ path: v.path, line: v.line, body: formatComment(v, byId.get(v.ruleId)!) }));

    if (comments.length === 0) {
      console.log("No rule violations found.");
    }
    comments.forEach((c, i) => console.log(`\n${i + 1}. ${c.path}:${c.line}\n${c.body}`));

    if (values.post && comments.length > 0) {
      const url = await postPullReview(
        repo!,
        prNumber,
        `Precedent found ${comments.length} place${comments.length === 1 ? "" : "s"} that break rules this team has asked for before.`,
        comments,
        { token },
      );
      console.log(`\nPosted review: ${url}`);
    } else if (comments.length > 0 && !values.diff) {
      console.log("\nDry run. Pass --post to post these as a pull request review.");
    }
  } else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
}

/** One-line message for the user; the stack trace is only shown when debugging. */
function reportError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message.split("\n")[0]}`);
  if (process.env.PRECEDENT_DEBUG && error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
}

await main().catch(reportError);
