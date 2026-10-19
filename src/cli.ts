#!/usr/bin/env node
import { extractRules } from "./extract.js";
import { fetchReviewComments } from "./github.js";
import { anthropicLlm } from "./llm.js";

const [command, repo] = process.argv.slice(2);

if (command === "mine" && repo) {
  if (!process.env.PRECEDENT_ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error("Set PRECEDENT_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY).");
    process.exit(1);
  }
  const comments = await fetchReviewComments(repo, { token: process.env.GITHUB_TOKEN });
  const prs = new Set(comments.map((c) => c.prNumber));
  console.log(`Fetched ${comments.length} review comments from ${prs.size} pull requests in ${repo}.`);

  const rules = await extractRules(comments, anthropicLlm());
  if (rules.length === 0) {
    console.log("No recurring rules found.");
  }
  const TOP = 10;
  if (rules.length > TOP) console.log(`Showing the top ${TOP} of ${rules.length} rules.`);
  rules.slice(0, TOP).forEach((rule, i) => {
    const scope = rule.scope.length ? ` (${rule.scope.join(", ")})` : "";
    console.log(`\n${i + 1}. ${rule.description}${scope}`);
    console.log(`   confidence ${rule.confidence.toFixed(2)}, ${rule.sources.length} comments:`);
    for (const s of rule.sources.slice(0, 3)) console.log(`   - #${s.prNumber} @${s.reviewer} ${s.commentUrl}`);
  });
} else {
  console.log("Usage: precedent mine <owner/repo>");
  process.exitCode = command ? 1 : 0;
}
