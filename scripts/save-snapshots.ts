// Save one frozen comment snapshot per repository (GitHub only, no model, no API key needed), so that every
// variant of an experiment reads exactly the same input. Fetch settings are the `mine` defaults.
// Usage: pnpm snapshots <dir> [owner/repo ...]   (default repos: the seven gate repositories)
// Needs GITHUB_TOKEN. Then run: precedent mine owner/repo --comments-file <dir>/owner-repo.json.gz ...
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fetchReviewComments } from "../src/github.js";
import { loadOrFetchComments } from "../src/snapshot.js";

const GATE_REPOS = ["django/django", "rust-lang/rust", "kubernetes/kubernetes", "facebook/react", "prettier/prettier", "fastapi/fastapi", "home-assistant/core"];
const [dir, ...rest] = process.argv.slice(2);
if (!dir) throw new Error("Usage: pnpm snapshots <dir> [owner/repo ...]");
if (!process.env.GITHUB_TOKEN) console.warn("Warning: GITHUB_TOKEN is not set; unauthenticated requests will hit the rate limit.");
await mkdir(dir, { recursive: true });
for (const repo of rest.length > 0 ? rest : GATE_REPOS) {
  const path = join(dir, `${repo.replace("/", "-")}.json.gz`);
  const comments = await loadOrFetchComments(path, repo, () => fetchReviewComments(repo, { token: process.env.GITHUB_TOKEN, maxPages: 30 }), (m) => console.log(`${repo}: ${m}`));
  console.log(`${repo}: ${comments.length} comments in ${path}`);
}
