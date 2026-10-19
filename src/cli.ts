#!/usr/bin/env node
import { fetchReviewComments } from "./github.js";

const [command, repo] = process.argv.slice(2);

if (command === "mine" && repo) {
  const comments = await fetchReviewComments(repo, { token: process.env.GITHUB_TOKEN });
  const prs = new Set(comments.map((c) => c.prNumber));
  console.log(`Fetched ${comments.length} review comments from ${prs.size} pull requests in ${repo}.`);
  console.log("Rule extraction is not implemented yet.");
} else {
  console.log("Usage: precedent mine <owner/repo>");
  process.exitCode = command ? 1 : 0;
}
