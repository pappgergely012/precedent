// Runs `precedent review` on a pull request diff for the recipe in examples/github-action/precedent-review.yml.
// Plain Node, no dependencies. Fail-open: whatever happens, it exits 0 and says what it did in the job summary, so a
// problem with the review never blocks a merge. It never prints or stores the API key.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MARKER = "<!-- precedent-review -->";
const MAX_SUMMARY_CHARS = 60_000; // a PR comment holds 65,536

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

const PRIVATE_OPEN = String.fromCharCode(0xe000);
const PRIVATE_CLOSE = String.fromCharCode(0xe001);

/**
 * The only links allowed through: the evidence links the engine builds itself, `[#12](https://github.com/OWNER/REPO/pull/12#discussion_r34)`,
 * and only for this repository when GITHUB_REPOSITORY is set. Everything else that looks like a link is removed.
 */
function evidenceLink(repo) {
  const where = repo ? repo.split("/").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/") : "[\\w.-]+/[\\w.-]+";
  return new RegExp(`\\[#(\\d+)\\]\\((https://github\\.com/${where}/pull/\\d+#discussion_r\\d+)\\)`, "g");
}

/** Text from the CLI (which includes file paths chosen by the PR author) made safe to put in a job summary or comment. */
export function sanitize(text, max = MAX_SUMMARY_CHARS, repo = process.env.GITHUB_REPOSITORY) {
  let out = "";
  for (const ch of text.replace(ANSI, "")) {
    const c = ch.codePointAt(0);
    const bad = (c < 32 && c !== 10) || (c >= 127 && c <= 159) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x2028 || c === 0x2029 || c === 0xfeff || c === 0xe000 || c === 0xe001;
    out += bad ? " " : ch;
  }
  const kept = [];
  out = out.replace(evidenceLink(repo), (m) => `${PRIVATE_OPEN}${kept.push(m) - 1}${PRIVATE_CLOSE}`);
  out = out
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<([a-z][^>]*)>/gi, "&lt;$1>")
    .replace(/</g, "&lt;")
    .replace(/!\[/g, "[")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1") // any other markdown link keeps its label only
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1") // reference-style links
    .replace(/^\s{0,3}\[[^\]]+\]:\s*\S+.*$/gm, "") // link reference definitions
    .replace(/\b(?:https?|ftp|javascript|vbscript|data|file):[^\s)>\]]*/gi, "[link removed]")
    .replace(/\bwww\.[^\s)>\]]+/gi, "[link removed]")
    .replace(/(^|[^\w`])@(?=[A-Za-z0-9_])([A-Za-z0-9_/-]+)/g, (_m, before, name) => `${before}\`@${name}\``);
  out = out.replace(new RegExp(`${PRIVATE_OPEN}(\\d+)${PRIVATE_CLOSE}`, "g"), (_m, i) => kept[Number(i)]);
  return out.length > max ? `${out.slice(0, max)}\n\n... (output cut)` : out;
}

/** The number of model calls in `precedent review --dry-run` output, or null if the line is not there. */
export function parseDryRun(output) {
  const m = /;\s*(\d+) model calls/.exec(output);
  return m ? Number(m[1]) : null;
}

/** What to do after the estimate: "none" (nothing applies), "skip" (over the cap) or "run". */
export function decide(calls, maxCalls) {
  if (calls === null) return { action: "skip", reason: "could not read the estimate from the dry run" };
  if (calls === 0) return { action: "none", reason: "no changed file has an applicable approved rule" };
  if (calls > maxCalls) return { action: "skip", reason: `the review would need about ${calls} model calls, over the cap of ${maxCalls} (raise MAX_CALLS to allow it)` };
  return { action: "run", reason: `about ${calls} model call${calls === 1 ? "" : "s"}` };
}

export function buildReport({ status, detail, body }) {
  const head = `${MARKER}\n### Precedent review\n`;
  if (status === "findings") return `${head}\nRules your team approved were found broken in this pull request. These are suggestions from a model, checked against your approved rules; read the cited comments before acting.\n\n${sanitize(body)}\n`;
  if (status === "clean") return `${head}\nNo violations of the approved rules were found in this pull request.\n`;
  return `${head}\nNot reviewed: ${sanitize(detail, 500)}. This never blocks the merge.\n`;
}

const firstLine = (text) => (text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 300);

function run(cli, args, env) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, maxBuffer: 20 * 1024 * 1024, timeout: 8 * 60 * 1000 });
}

export function main(env = process.env) {
  const cli = env.PRECEDENT_CLI;
  const rules = env.RULES_FILE || ".precedent/approved.json";
  const diff = env.DIFF_FILE || "pr.diff";
  const maxCalls = Number(env.MAX_CALLS || 20);
  const maxFiles = String(env.MAX_FILES || 30);
  const report = (r) => {
    const text = buildReport(r);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
    if (env.COMMENT_FILE) writeFileSync(env.COMMENT_FILE, text);
    console.log(text);
  };
  try {
    if (!cli || !existsSync(cli)) return report({ status: "skipped", detail: "the Precedent CLI was not found" });
    if (!existsSync(rules)) return report({ status: "skipped", detail: `no approved rules file at ${rules}` });
    if (!existsSync(diff)) return report({ status: "skipped", detail: "the pull request diff was not downloaded" });
    if (!env.PRECEDENT_ANTHROPIC_API_KEY) return report({ status: "skipped", detail: "no API key is available (secrets are not passed to pull requests from forks)" });

    const childEnv = { ...env, GITHUB_TOKEN: "" }; // the CLI does not need the token for a local diff
    const base = ["review", "--diff", diff, "--rules", rules, "--max-files", maxFiles, "--redact"];
    const estimate = run(cli, [...base, "--dry-run"], childEnv);
    if (estimate.status !== 0) return report({ status: "skipped", detail: `the estimate failed: ${firstLine(estimate.stderr || estimate.stdout)}` });
    const plan = decide(parseDryRun(estimate.stdout), maxCalls);
    if (plan.action !== "run") return report({ status: "skipped", detail: plan.reason });

    const result = run(cli, base, childEnv);
    if (result.status !== 0) return report({ status: "skipped", detail: `the review failed: ${firstLine(result.stderr || result.stdout)}` });
    const findings = result.stdout
      .split("\n")
      .filter((l) => !/^\[\d\d:\d\d:\d\d\]/.test(l) && !/^(Reviewing |Notice: |Redacted )/.test(l))
      .join("\n")
      .trim();
    if (/No rule violations found\./.test(findings) || findings === "") return report({ status: "clean" });
    return report({ status: "findings", body: findings });
  } catch (error) {
    return report({ status: "skipped", detail: `unexpected error: ${firstLine(String(error?.message ?? error))}` });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
  process.exit(0);
}
