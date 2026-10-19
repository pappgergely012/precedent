#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseDiff } from "./diff.js";
import { extractRules } from "./extract.js";
import { fetchPullDiff, fetchReviewComments, postPullReview } from "./github.js";
import { anthropicLlm } from "./llm.js";
import { formatComment, reviewDiff } from "./review.js";
import { readRulesFile, writeRulesFile } from "./rulesfile.js";

const USAGE = `Usage:
  precedent mine <owner/repo> [--out FILE] [--max-pages N] [--max-comments N] [--min-occurrences N]
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
    "max-pages": { type: "string" },
    "max-comments": { type: "string" },
    "min-occurrences": { type: "string" },
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

if (command === "mine" && repo) {
  requireAnthropicKey();
  const comments = await fetchReviewComments(repo, {
    token: process.env.GITHUB_TOKEN,
    maxPages: intFlag("max-pages", 30),
  });
  const prs = new Set(comments.map((c) => c.prNumber));
  console.log(`Fetched ${comments.length} review comments from ${prs.size} pull requests in ${repo}.`);

  const rules = await extractRules(comments, anthropicLlm(), {
    maxComments: intFlag("max-comments", 1000),
    minOccurrences: intFlag("min-occurrences", 2),
    onProgress: progress,
  });
  if (rules.length === 0) {
    console.log("No recurring rules found.");
  }
  rules.forEach((rule, i) => {
    const scope = rule.scope.length ? ` (${rule.scope.join(", ")})` : "";
    console.log(`\n${i + 1}. ${rule.description}${scope}`);
    console.log(`   confidence ${rule.confidence.toFixed(2)}, ${rule.sources.length} comments:`);
    for (const s of rule.sources.slice(0, 3)) console.log(`   - #${s.prNumber} @${s.reviewer} ${s.commentUrl}`);
  });
  if (values.out) {
    await writeRulesFile(values.out, repo, rules);
    console.log(`\nWrote ${rules.length} rules to ${values.out}`);
  }
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
