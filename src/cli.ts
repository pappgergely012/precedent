#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseDiff } from "./diff.js";
import { cacheText, extractRules, isSingleReviewer, selectUsable } from "./extract.js";
import { fetchPullDiff, fetchReviewComments, GitHubApiError, postPullReview } from "./github.js";
import { DEFAULT_MODEL, anthropicLlm } from "./llm.js";
import { verifyRules } from "./verify.js";
import { chooseFiles, estimateReview, formatComment, reviewDiff, rulesForFile } from "./review.js";
import { fileCache, memoryCache } from "./cache.js";
import { describeFit, fitMetrics } from "./fit.js";
import { loadOrFetchComments } from "./snapshot.js";
import { cachedLlm, describeCache, fileStore } from "./llmcache.js";
import { extractDocRules, fetchGuideDocs, reconcileRules, type DocRule } from "./docs.js";
import { ExportError, renderBlock, selectRules, suspiciousRules, writeExport, type ExportFormat } from "./export.js";
import { describeEstimate, estimateUsage } from "./estimate.js";
import { renderMineOutput } from "./mineoutput.js";
import { helpFor } from "./help.js";
import { createRedactor } from "./redact.js";
import { stabilityCuts, summarizeStability } from "./stability.js";
import { readRulesFile, samePath, writeRulesFile } from "./rulesfile.js";
import { safeLine } from "./terminal.js";
import { ruleTier } from "./rule.js";
import { diffRules, renderRuleDiff } from "./rulediff.js";
import { approveRules, selectCandidates } from "./approve.js";
import { existsSync } from "node:fs";

const USAGE = helpFor();

const DEFAULT_RULES_FILE = ".precedent/rules.json";
const APPROVED_RULES_FILE = ".precedent/approved.json";
/** `export` and `review` use the team's approved rules when that file exists, and say so; otherwise the last run. */
function defaultRulesPath(): string {
  if (!existsSync(APPROVED_RULES_FILE)) return DEFAULT_RULES_FILE;
  console.error(`Using the approved rules in ${APPROVED_RULES_FILE} (pass --rules FILE to use another file).`);
  return APPROVED_RULES_FILE;
}

function parseCli() {
  try {
    return parseArgs({ allowPositionals: true, options: OPTIONS });
  } catch (error) {
    const first = (error as Error).message.split("\n")[0]!;
    const hint = /ambiguous/.test(first) ? " An option that takes a value (for example --cache FILE) cannot be followed by another option; give it a value, or write --option=VALUE." : "";
    console.error(`${first}${hint}\n\n${USAGE}`);
    process.exit(1);
  }
}
const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  out: { type: "string" },
  rules: { type: "string" },
  diff: { type: "string" },
  approved: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  id: { type: "string", multiple: true },
  list: { type: "boolean" },
  "all-core": { type: "boolean" },
  post: { type: "boolean" },
  verify: { type: "boolean" },
  cache: { type: "string" },
  "no-cache": { type: "boolean" },
  top: { type: "string" },
  "pin-extraction": { type: "boolean" },
  docs: { type: "boolean" },
  "max-pages": { type: "string" },
  runs: { type: "string" },
  format: { type: "string" },
  "min-confidence": { type: "string" },
  "max-rules": { type: "string" },
  "include-single-reviewer": { type: "boolean" },
  "include-emerging": { type: "boolean" },
  all: { type: "boolean" },
  redact: { type: "boolean" },
  "pre-merge": { type: "boolean" },
  "comments-file": { type: "string" },
  "extraction-votes": { type: "string" },
  "shared-merge": { type: "string" },
  "dry-run": { type: "boolean" },
  "max-files": { type: "string" },
  verbose: { type: "boolean" },
  "max-comments": { type: "string" },
  "min-occurrences": { type: "string" },
  "max-age-days": { type: "string" },
} as const;
const { positionals, values } = parseCli();
const [command, repo, prArg] = positionals;

if (values.version) {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  console.log(pkg.version);
  process.exit(0);
}
if (values.help || command === "help") {
  console.log(helpFor(command === "help" ? repo : command));
  process.exit(0);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** `--shared-merge X`: a share between 0 (exclusive) and 1, or the default. */
function sharedMergeFlag(): number | undefined {
  const raw = values["shared-merge"];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!(value > 0 && value <= 1)) fail("--shared-merge needs a number above 0 and up to 1.");
  return value;
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

/** Stage summaries of one stability run: which step changes from run to run. */
const stageLog = (run: number) => (message: string) => {
  if (/^(\d+ candidate rules|Merged into|Kept \d+|Dropped|Merged \d+ near|Merge level)/.test(message)) console.log(`  run ${run}: ${message}`);
};

/** With --redact, mask obvious secrets and emails in text before it can reach a prompt. Applied once, at the boundary. */
function redactor(): { text: (s: string) => string; report: () => void } {
  const r = createRedactor(!!values.redact);
  return {
    text: r.text,
    report: () => {
      const line = r.line();
      if (line) console.log(line);
    },
  };
}

const progress = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

async function main(): Promise<void> {
  if (command === "mine" && repo) {
    if (values.cache && values["no-cache"]) fail("--cache and --no-cache cannot be used together.");
    if (!values["dry-run"]) requireAnthropicKey();
    if (!process.env.GITHUB_TOKEN) {
      console.warn("Warning: GITHUB_TOKEN is not set. Unauthenticated requests are limited to 60 per hour and mining a large repository will hit the limit.");
    }
    const comments = await loadOrFetchComments(
      values["comments-file"],
      repo,
      () => fetchReviewComments(repo, { token: process.env.GITHUB_TOKEN, maxPages: intFlag("max-pages", 30) }),
      progress,
    );
    const prs = new Set(comments.map((c) => c.prNumber));
    console.log(`Fetched ${comments.length} review comments from ${prs.size} pull requests in ${repo}.`);
    const mask = redactor();
    const sendable = values.redact ? comments.map((c) => ({ ...c, body: mask.text(c.body) })) : comments;
    mask.report();
    if (values["dry-run"]) {
      const usable = selectUsable(comments, { maxComments: intFlag("max-comments", 1000), maxAgeDays: intFlag("max-age-days", 730) });
      const cache = values.cache ? await fileCache(values.cache, process.env.PRECEDENT_MODEL ?? DEFAULT_MODEL) : undefined;
      const votes = intFlag("extraction-votes", 1);
      const pending = cache ? usable.filter((c) => cache.get(c.id, cacheText(c, votes)) === undefined).length : usable.length;
      for (const line of describeEstimate(estimateUsage({ usable: usable.length, pending, votes }), usable.length, votes)) console.log(line);
      return;
    }

    if (values.cache && values["no-cache"]) fail("--cache and --no-cache cannot be used together.");
    const cachePath = values["no-cache"] ? undefined : values.cache;
    const model = process.env.PRECEDENT_MODEL ?? DEFAULT_MODEL;
    // With --cache, every model answer (extraction, merge, audit, dedupe, --docs) is kept next to the principle cache.
    const llm = cachePath ? cachedLlm(anthropicLlm(), await fileStore(`${cachePath}.responses.json`), model) : anthropicLlm();
    const mineCache = cachePath ? await fileCache(cachePath, model) : undefined;
    let rules = await extractRules(sendable, llm, {
      maxComments: intFlag("max-comments", 1000),
      minOccurrences: intFlag("min-occurrences", 2),
      maxAgeDays: intFlag("max-age-days", 730),
      preMerge: values["pre-merge"],
      extractionVotes: intFlag("extraction-votes", 1),
      sharedMergeThreshold: sharedMergeFlag(),
      cache: mineCache,
      onProgress: progress,
      onDetail: values.verbose ? progress : undefined,
    });
    if (values.verify) {
      const before = rules.length;
      rules = await verifyRules(repo, rules, { token: process.env.GITHUB_TOKEN, minOccurrences: intFlag("min-occurrences", 2) });
      console.log(`Verified citations: kept ${rules.length} of ${before} rules.`);
    }
    let documentedOnly: DocRule[] | undefined;
    if (values.docs && rules.length > 0) {
      const docMask = redactor();
      const docs = (await fetchGuideDocs(repo, { token: process.env.GITHUB_TOKEN })).map((d) => ({ ...d, text: docMask.text(d.text) }));
      docMask.report();
      if (docs.length === 0) {
        console.log("No contributor guide found (CONTRIBUTING.md, AGENTS.md, ...); skipping the documented-vs-enforced check.");
      } else {
        progress(`Reading ${docs.length} guide file(s): ${docs.map((d) => d.path).join(", ")}`);
        const docRules = await extractDocRules(docs, llm);
        ({ rules, documentedOnly } = await reconcileRules(rules, docRules, llm));
        progress("--docs is in beta: the tags below are model judgements that vary between runs and miss some real matches; read the quoted guide text before relying on one.");
        progress(`${docRules.length} documented rules; ${rules.filter((r) => r.origin === "both").length} also enforced, ${rules.filter((r) => r.origin === "conflict").length} possible conflicts`);
      }
    }
    for (const line of renderMineOutput(rules, { all: values.all, top: 10 })) console.log(line);
    if (documentedOnly && documentedOnly.length > 0) {
      console.log(`\nWritten in the guide but not seen in review comments (${documentedOnly.length}):`);
      for (const d of documentedOnly.slice(0, 5)) console.log(`   - ${d.description} (${d.path})`);
    }
    const principleCache = cachePath ? mineCache : undefined;
    const stageStats = "cacheStats" in llm ? (llm as ReturnType<typeof cachedLlm>).cacheStats() : undefined;
    if ("cacheStats" in llm) await (llm as ReturnType<typeof cachedLlm>).save();
    // Stability and gate runs must be fresh: this line lets a harness void a run that was answered from a cache.
    console.log(`\nCache hits: ${(principleCache?.hits() ?? 0) + (stageStats?.hits ?? 0)}${stageStats ? ` (${describeCache(stageStats)})` : " (no cache in use)"}`);
    const usage = llm.usage?.();
    if (usage) {
      console.log(`Model usage: ${usage.calls} calls, ${usage.inputTokens.toLocaleString("en-US")} input and ${usage.outputTokens.toLocaleString("en-US")} output tokens (excluding --verify).`);
    }
    if (values.out) {
      await writeRulesFile(values.out, repo, rules, documentedOnly);
      console.log(`\nWrote ${rules.length} rules to ${values.out}`);
    }
  } else if (command === "check" && repo) {
    if (!process.env.GITHUB_TOKEN) {
      console.warn("Warning: GITHUB_TOKEN is not set. Unauthenticated requests are limited to 60 per hour.");
    }
    // The last 12 months, at most 1,000 comments: the same window the market survey used.
    const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
    let window = "in the last 12 months";
    const comments = await loadOrFetchComments(
      values["comments-file"],
      repo,
      async () => {
        try {
          return await fetchReviewComments(repo, { token: process.env.GITHUB_TOKEN, maxPages: 10, minTopLevel: 0, since });
        } catch (error) {
          // GitHub answers the dated query with a server error for some very large repositories.
          if (!(error instanceof GitHubApiError) || error.status < 500) throw error;
          window = "(the newest 1,000 comments, whatever their age)";
          return fetchReviewComments(repo, { token: process.env.GITHUB_TOKEN, maxPages: 10, minTopLevel: 0 });
        }
      },
      progress,
    );
    if (values["comments-file"]) window = "in the saved snapshot";
    for (const line of describeFit(repo, fitMetrics(comments), window)) console.log(line);
  } else if (command === "approve") {
    const fromPath = values.from ?? DEFAULT_RULES_FILE;
    const toPath = values.to ?? APPROVED_RULES_FILE;
    const missing = (path: string) => (error: NodeJS.ErrnoException) => fail(error.code === "ENOENT" ? `Rules file ${path} not found. Run "precedent mine owner/repo --out ${path}" first.` : error.message.split("\n")[0]!);
    const candidates = await readRulesFile(fromPath).catch(missing(fromPath));
    if (values.list || (!values.id?.length && !values["all-core"])) {
      for (const r of candidates.rules) console.log(`${safeLine(r.id, 40)}  [${ruleTier(r)}] ${safeLine(r.description, 140)} (${r.sources.length} comments)`);
      console.log(`\n${candidates.rules.length} candidates in ${fromPath}. Pick with --id ID (repeat for several) or --all-core; they are pinned into ${toPath}, which is yours to edit and commit.`);
    } else {
      const { chosen, unknown } = selectCandidates(candidates.rules, { ids: values.id, allCore: values["all-core"] });
      if (unknown.length > 0) fail(`No rule with id ${unknown.join(", ")} in ${fromPath}. Run "precedent approve --list" to see the ids.`);
      if (samePath(fromPath, toPath)) fail(`--from and --to are the same file (${toPath}); refusing to overwrite the candidates with the approved rules.`);
      const existing = existsSync(toPath) ? await readRulesFile(toPath).catch(missing(toPath)) : undefined;
      if (existing && existing.repo !== candidates.repo) fail(`${toPath} is for ${existing.repo} but ${fromPath} is for ${candidates.repo}; refusing to mix them.`);
      const { rules, added, skipped } = approveRules(existing?.rules ?? [], chosen);
      for (const s of skipped) console.log(`skipped: ${safeLine(s.rule.description, 100)} (${safeLine(s.reason, 120)})`);
      if (added.length > 0) await writeRulesFile(toPath, candidates.repo, rules);
      console.log(`${added.length} rule(s) approved into ${toPath} (${rules.length} in total)${added.length === 0 ? "; nothing written" : ""}. Existing approved rules are never changed.`);
    }
  } else if (command === "compare") {
    const approvedPath = values.approved ?? (existsSync(APPROVED_RULES_FILE) ? APPROVED_RULES_FILE : undefined);
    if (!approvedPath) fail("compare needs --approved FILE (the rules your team approved) and --rules FILE (the new run).");
    const readFile_ = (path: string) =>
      readRulesFile(path).catch((error: NodeJS.ErrnoException) => fail(error.code === "ENOENT" ? `Rules file ${path} not found.` : error.message.split("\n")[0]!));
    const approvedFile = await readFile_(approvedPath);
    const freshFile = await readFile_(values.rules ?? DEFAULT_RULES_FILE);
    if (values.out && [approvedPath, values.rules ?? DEFAULT_RULES_FILE].some((input) => samePath(input, values.out!))) {
      fail(`--out ${values.out} is one of the input files; refusing to overwrite it. Choose another file.`);
    }
    if (approvedFile.repo !== freshFile.repo) console.error(`Warning: the approved rules are for ${safeLine(approvedFile.repo, 80)} but the new run is for ${safeLine(freshFile.repo, 80)}; the comparison is probably not meaningful.`);
    const diff = diffRules(approvedFile.rules, freshFile.rules);
    console.log(renderRuleDiff(diff));
    if (values.out) {
      await writeRulesFile(values.out, freshFile.repo, diff.added);
      console.log(`\nWrote ${diff.added.length} new candidates to ${values.out}. The approved file is not changed.`);
    }
  } else if (command === "export") {
    const format = values.format;
    if (format !== "claude" && format !== "agents" && format !== "cursor") fail("--format must be one of: claude, agents, cursor.");
    const rulesPath = values.rules ?? defaultRulesPath();
    const file = await readRulesFile(rulesPath).catch((error: NodeJS.ErrnoException) =>
      fail(error.code === "ENOENT" ? `Rules file ${rulesPath} not found. Run "precedent mine owner/repo --out ${rulesPath}" first.` : error.message.split("\n")[0]!),
    );
    const minConfidence = values["min-confidence"] === undefined ? undefined : Number(values["min-confidence"]);
    if (minConfidence !== undefined && !(minConfidence >= 0 && minConfidence <= 1)) fail("--min-confidence needs a number between 0 and 1.");
    const exportOptions = {
      format: format as ExportFormat,
      minConfidence,
      maxRules: values["max-rules"] === undefined ? undefined : intFlag("max-rules", 30),
      includeSingleReviewer: values["include-single-reviewer"],
      includeEmerging: values["include-emerging"],
    };
    const block = renderBlock(file, exportOptions);
    const chosen = selectRules(file.rules, exportOptions);
    const skipped = file.rules.length - chosen.length;
    if (skipped > 0) {
      console.error(`${skipped} of ${file.rules.length} rules not exported: only core rules with confidence ${minConfidence ?? 0.4}+ from 2+ reviewers are exported (up to ${exportOptions.maxRules ?? 30}); see --include-emerging, --include-single-reviewer, --min-confidence, --max-rules.`);
    }
    const odd = suspiciousRules(chosen);
    if (odd.length > 0) {
      console.error(`Warning: ${odd.length} exported rule(s) contain links, shell commands or instruction-like text. Rule text comes from review comments; read it before committing:`);
      for (const r of odd) console.error(`   - ${r.description.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    if (!values.out) {
      console.log(block);
    } else {
      try {
        const { backedUp } = await writeExport(values.out, block);
        console.log(`Wrote the rules block to ${values.out}${backedUp ? ` (original kept as ${values.out}.bak)` : ""}`);
      } catch (error) {
        if (error instanceof ExportError) fail(error.message);
        throw error;
      }
    }
  } else if (command === "stability" && repo) {
    requireAnthropicKey();
    const runs = intFlag("runs", 3);
    const top = intFlag("top", 10);
    const comments = await loadOrFetchComments(values["comments-file"], repo, () => fetchReviewComments(repo, { token: process.env.GITHUB_TOKEN, maxPages: intFlag("max-pages", 30) }), progress);
    console.log(`Fetched ${comments.length} review comments once; mining ${runs} times (each run costs about as much as one \`mine\`).`);
    const stabilityMask = redactor();
    const sendableComments = values.redact ? comments.map((c) => ({ ...c, body: stabilityMask.text(c.body) })) : comments;
    stabilityMask.report();
    // With --pin-extraction the per-comment judgements of run 1 are reused, which isolates the
    // variance of the merge and audit steps from the variance of the extraction step.
    const pinned = values["pin-extraction"] ? memoryCache() : undefined;
    const llm = anthropicLlm();
    const results = [];
    for (let i = 1; i <= runs; i++) {
      results.push(await extractRules(sendableComments, llm, { maxComments: intFlag("max-comments", 1000), preMerge: values["pre-merge"], extractionVotes: intFlag("extraction-votes", 1), sharedMergeThreshold: sharedMergeFlag(), cache: pinned, onProgress: values.verbose ? stageLog(i) : undefined }));
      console.log(`Run ${i}/${runs}: ${results[i - 1]!.length} rules`);
    }
    const cuts = stabilityCuts(results, top);
    const s = summarizeStability(results, top);
    const f = (n: number) => n.toFixed(2);
    const row = (label: string, c: (typeof cuts)["top"]) =>
      console.log(`  ${label.padEnd(10)} rules per run ${c.ruleCounts.join("/").padEnd(10)} overlap ${f(c.commentOverlap)}   (wording only ${f(c.wordingOverlap)}, evidence Jaccard of matched rules ${f(c.evidenceJaccard)})`);
    console.log(`\n${runs} runs, ${values["pin-extraction"] ? "extraction pinned after run 1" : "nothing pinned"}.`);
    console.log(`Cache hits: ${pinned?.hits() ?? 0}${pinned ? " (extraction answers re-used from run 1; this is not a fresh-mining measurement)" : " (no cache in use)"}`);
    console.log("Mean pairwise overlap; rules match when they share a cited comment:");
    row(`top ${top}`, cuts.top);
    row("all rules", cuts.all);
    row("core rules", cuts.core);
    console.log(`Core rules (3+ comments from 2+ reviewers): ${cuts.coreRetention.coreRules.join("/")} per run; the share of a run's core rules that every other run also has: mean ${f(cuts.coreRetention.mean)}, worst ${f(cuts.coreRetention.worst)}`);
    console.log(`Top ${top}: rules of run 1 found in every other run ${s.inAllRuns}/${s.ruleCounts[0]}, in at least half ${s.inMajority}/${s.ruleCounts[0]}`);
    if (s.unstableStrong.length > 0) {
      console.log(`Rules with 3+ comments that appear in fewer than 2 runs (${s.unstableStrong.length}):`);
      for (const u of s.unstableStrong) console.log(`  - ${u.description} (${u.comments} comments, in ${u.runsPresent} run${u.runsPresent === 1 ? "" : "s"})`);
    }
    const usage = llm.usage?.();
    if (usage) console.log(`Model usage: ${usage.calls} calls, ${usage.inputTokens.toLocaleString("en-US")} input and ${usage.outputTokens.toLocaleString("en-US")} output tokens.`);
    if (values.out) {
      await writeFile(values.out, `${JSON.stringify({ repo, top, pinnedExtraction: !!pinned, cacheHits: pinned?.hits() ?? 0, runs: results }, null, 2)}\n`);
      console.log(`Wrote every rule of the ${runs} runs to ${values.out}`);
    }
  } else if (command === "review" && (values.diff || (repo && prArg))) {
    if (!values["dry-run"]) requireAnthropicKey();
    const token = process.env.GITHUB_TOKEN;
    let prNumber = 0;
    if (!values.diff) {
      prNumber = Number(prArg);
      if (!Number.isInteger(prNumber) || prNumber < 1) fail(`Invalid pull request number "${prArg}".`);
    }
    if (values.post && (values.diff || !token)) {
      fail("--post needs a pull request and GITHUB_TOKEN with permission to write pull request reviews.");
    }

    const reviewRulesPath = values.rules ?? defaultRulesPath();
    const { rules } = await readRulesFile(reviewRulesPath).catch((error: NodeJS.ErrnoException) =>
      fail(error.code === "ENOENT" ? `Rules file ${reviewRulesPath} not found. Run "precedent mine owner/repo --out ${reviewRulesPath}" first.` : error.message.split("\n")[0]!),
    );
    const diffText = values.diff
      ? await readFile(values.diff, "utf8").catch((error: NodeJS.ErrnoException) => fail(error.code === "ENOENT" ? `Diff file ${values.diff} not found.` : `Cannot read ${values.diff}: ${error.message.split("\n")[0]}`))
      : await fetchPullDiff(repo!, prNumber, { token });
    const diffMask = redactor();
    const files = parseDiff(diffText).map((f) => ({ ...f, patch: diffMask.text(f.patch) }));
    diffMask.report();
    const target = values.diff ? values.diff : `${repo}#${prNumber}`;
    console.log(`Reviewing ${files.length} changed files of ${target} against ${rules.length} rules.`);

    // One model call per file that some rule applies to; a very large PR is capped so it cannot run up an unbounded bill.
    const maxFiles = intFlag("max-files", 100);
    const reviewable = files.filter((f) => rulesForFile(rules, f.path).length > 0);
    const chosen = chooseFiles(reviewable, maxFiles);
    if (values["dry-run"]) {
      const e = estimateReview(chosen, rules);
      console.log(`Dry run: ${reviewable.length} of ${files.length} files have an applicable rule; ${e.calls} model calls (cap --max-files ${maxFiles}), roughly ${e.inputTokens.toLocaleString("en-US")} input and ${e.outputTokens.toLocaleString("en-US")} output tokens (a rough estimate from text length). No model call was made.`);
      return;
    }
    if (chosen.length < reviewable.length) {
      console.log(`Notice: ${reviewable.length} files have an applicable rule; only the ${maxFiles} with the most added lines are reviewed (ties by path; raise --max-files to review more).`);
    }

    const violations = await reviewDiff(chosen, rules, anthropicLlm(), { onProgress: progress });
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
