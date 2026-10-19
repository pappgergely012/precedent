#!/usr/bin/env node
import { extractRules } from "./extract.js";
import { fetchReviewComments } from "./github.js";
import { anthropicLlm } from "./llm.js";

const [command, repo, ...flags] = process.argv.slice(2);

/** Read `--name <positive integer>` from the CLI flags. */
function intFlag(name: string, fallback: number): number {
  const i = flags.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = Number(flags[i + 1]);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--${name} needs a positive integer.`);
    process.exit(1);
  }
  return value;
}

if (command === "mine" && repo) {
  if (!process.env.PRECEDENT_ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error("Set PRECEDENT_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY).");
    process.exit(1);
  }
  const comments = await fetchReviewComments(repo, {
    token: process.env.GITHUB_TOKEN,
    maxPages: intFlag("max-pages", 30),
  });
  const prs = new Set(comments.map((c) => c.prNumber));
  console.log(`Fetched ${comments.length} review comments from ${prs.size} pull requests in ${repo}.`);

  const rules = await extractRules(comments, anthropicLlm(), {
    maxComments: intFlag("max-comments", 1000),
    minOccurrences: intFlag("min-occurrences", 2),
    onProgress: (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`),
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
} else {
  console.log("Usage: precedent mine <owner/repo> [--max-pages N] [--max-comments N] [--min-occurrences N]");
  process.exitCode = command ? 1 : 0;
}
