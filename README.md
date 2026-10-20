# Precedent

**Code review that cites its sources.**

Every team has rules nobody wrote down: how errors are wrapped, which APIs are off limits, what a test must cover. They live in closed pull requests. Precedent mines your pull request review history, turns recurring patterns into explicit rules, and links each rule to the review comments where your team decided it.

> Status: early prototype. `precedent mine` and `precedent review` work end to end; rule quality is still being tuned.

```bash
precedent mine owner/repo
```

You get a ranked list of rules. Each rule has a one-sentence statement and links to the original review comments behind it, so you can check it, edit it, or throw it out.

## Why

- **Learned from your history.** No rule writing. Rules come from what your reviewers actually asked for, in at least two different pull requests.
- **Explainable.** A rule without a source is a guess. Every rule carries citations, and `--verify` re-fetches the cited comments from GitHub to confirm they exist.
- **Open and editable.** The engine is open source. You see every rule and decide which stay.

## What it is not (yet)

- Not a bug finder. It learns conventions your team already enforces; it does not replace a general reviewer.
- Rule quality is still being measured. Read the citations before trusting a rule.
- Rules are only as good as your review history: a repository whose review comments are mostly one-off remarks yields few or no recurring rules.

## Install

Precedent is not published to npm yet. From a clone (Node 22+, pnpm):

```bash
pnpm install && pnpm build
node dist/cli.js mine owner/repo          # the commands below call this `precedent`
npm pack                                  # makes precedent-0.0.0.tgz (only dist, README and LICENSE)
npm install ./precedent-0.0.0.tgz         # in another project: `npx precedent --help`
```

`precedent --help` prints the usage and `precedent --version` the version.

## Does it fit your repository?

```bash
precedent check owner/repo
```

A few seconds, no model and no API key: it counts the inline review comments of the last 12 months (at most 1,000), the reviewers, how many reviewers wrote 3 or more, how much of the review one person does, and prints whether core rules are `likely`, `possible` or `unlikely`, with what is missing. It uses the thresholds of our public-repository survey (about 300 comments and 8 active reviewers for "likely"). It is a heuristic on counts only: on the 11 repositories we mined, it agreed with the number of core rules actually found on 8, and it is lenient (`possible` often means few or none). Only inline review comments count; teams that review in the pull request conversation, and private repositories you have not pointed it at, are not seen. On rails/rails, ripgrep and prettier it printed `likely`, `unlikely` and `possible`, matching the survey.

## Usage

```bash
# 1. Mine the team's rules from past review comments and save them.
precedent mine owner/repo --out .precedent/rules.json

# 2. Check a pull request against those rules (dry run prints the comments).
precedent review owner/repo 123

# 3. Post the findings as one pull request review with inline comments.
precedent review owner/repo 123 --post

# Or review a local diff, for example in CI before a PR exists.
git diff origin/main... > pr.diff
precedent review --diff pr.diff
```

Needs `GITHUB_TOKEN` and `PRECEDENT_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`). Uses `claude-haiku-5-5` by default (override with `PRECEDENT_MODEL`).

- `review` makes one model call per changed file that some rule applies to. `--dry-run` shows that count and a rough token estimate without a model call or an API key; `--max-files N` (default 100) caps the files reviewed: the files with the most added lines are kept (ties by path) and a notice is printed when the cap applies; the dry run shows input and output token estimates (output is an assumed 120 tokens per call). Scope globs support `{a,b}` alternatives and ignore a leading `./`. Everything posted to a pull request is built from sanitised text: the model's sentence and the rule text lose links, images, HTML, control and bidirectional characters and are length-capped, `@mentions` are put in code spans so nobody is notified, and the "reviewers asked for this before" links are built from the stored citation URLs after a strict check. `--post` is still required to post anything.
- `mine` works like this:
  - It reads up to `--max-pages` pages of review comments (default 30; paging stops early once enough top-level comments are collected). `--max-pages` is a soft target: after that many pages the fetch keeps going (up to 30 pages in total) until it has collected 300 top-level comments, so `--max-pages 1` on a repository with many threaded replies can still read several hundred comments. Replies, very short comments, comments written by the pull request's own author and repeated identical text from one reviewer on one pull request are ignored.
  - It analyses the newest `--max-comments` (default 1000), preferring comments from the last `--max-age-days` (default 730). If that would leave fewer than 300 usable comments, the newest 300 are kept whatever their age, so quiet repositories keep their history.
  - A rule needs at least `--min-occurrences` comments (default 2) from at least 2 distinct pull requests. An audit pass then drops the comments that do not actually state the rule (one-off remarks, exceptions, other languages or scopes) and narrows rule text that claims more than its comments say, and near-duplicate rules are merged in a final pass.
  - A rule's confidence is its number of distinct source pull requests divided by 5, capped at 1, and halved when only one reviewer asked for it (such a rule also carries a "single reviewer" flag).
  - The terminal lists the core rules (3+ comments from 2+ reviewers) and only counts the emerging candidates (thinner evidence); `--all` lists those too, at most 10 rules per list. `--out` saves every rule. The tier describes how much evidence a rule has; it is not a guarantee that a later run finds the same rule, since the model's judgements vary between runs (measured on repeated runs: most core rules were found again on 3 of 4 repositories, but not on all).
  - `--verify` re-fetches every cited comment from GitHub and drops rules whose citations do not resolve. `--dry-run` fetches the comments (GitHub only) and prints how many model calls and tokens the run is expected to use, without calling the model or needing an API key (an estimate from earlier runs, off by up to about 30%). `--cache FILE` remembers what the model said about each comment, so re-mining only sends new or edited comments (the cache is keyed on the exact comment text, the model and the prompt version). The same flag also stores every other model answer (merge, audit, dedupe, `--docs`) in `FILE.responses.json`, keyed on the full request, so re-mining unchanged data sends nothing to the model and returns the same rules; the run prints `Cache hits: N`; a run with hits is not a fresh-mining measurement, and `stability` prints the same line (non-zero only with `--pin-extraction`). `--no-cache` ignores both files. Caching is off unless you pass `--cache`. `--redact` (also on `review` and `stability`) masks obvious secrets and personal data (well-known token formats including GitHub, Stripe, Google, npm, Slack, GitLab, SendGrid, DigitalOcean, Twilio and AWS keys, private key blocks, credentials in URLs, email addresses, long values assigned to names like `password` or `api_key`) in comments, guide files and diffs before they are sent to the model, and prints how many it masked; it is best effort, not a guarantee (short passwords, IP addresses, phone numbers, names, file paths and confidential wording are not masked; the model still sees each comment's file path), and also masks example email addresses in documentation. `--pre-merge` (experimental, not yet measured) groups candidate principles that are worded almost identically before the model merges them.
- `mine --docs` (beta) also reads the repository's written guides: the root files (`CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, style guides, the pull request template) and up to 12 documents found by scanning the repository for contributing, coding-style, submitting-patches and review guides (for example `guides/source/contributing_to_ruby_on_rails.md` or `docs/internals/contributing/...`) and tags each mined rule: *enforced in reviews, not written in the guide*, *documented in the guide too* (with the quote), or *possible conflict* with the guide. Rules the guide states but the review comments never show are listed separately. A rule only counts as documented when a strict second pass confirms the quoted guide text itself asks for the same thing (a possible conflict must be confirmed twice); candidates for that pass come from the model and from the closest wording, and guide rules that merely restate a mined rule are not listed as documented-only. Some real matches will still be missed. Other documentation is not read.
- `export` turns a rules file into the context file your coding agents read, with a link to the review comments behind every rule: `precedent export --format claude --out CLAUDE.md` (also `agents` for `AGENTS.md` and `cursor` for `.cursorrules`; without `--out` it prints to the terminal). It needs no network and no model. The rules sit between `precedent:start` and `precedent:end` markers: re-exporting replaces only that block and leaves the rest of the file alone. If the file does not contain exactly one start and one end marker (a stray marker line, two blocks) the command refuses with a message and writes nothing; the first change to an existing file keeps a copy as `<file>.bak`, and the file is replaced atomically. Rule text comes from review comments, so it is treated as untrusted: control and bidirectional characters are removed, `<` is escaped (no HTML or comment markers), code fences and image syntax are neutralised, text is capped at 500 characters, and the command warns about rules that contain links, shell commands or instruction-like wording. A symlinked target (`CLAUDE.md -> AGENTS.md`) is followed so the real file is updated, bytes outside the block are written back exactly even if the file is not valid UTF-8, and a read-only file is refused. Only the first change keeps a `.bak`; a later export does not overwrite it. Still read the block before committing it. By default it exports only core rules (3+ comments from 2+ reviewers, `--include-emerging` adds the rest) with confidence of at least 0.4 (`--min-confidence`), skips rules only one reviewer asked for (`--include-single-reviewer` keeps them) and caps the list at 30 (`--max-rules`).
- `compare` treats a new run as a diff against the rules your team already approved: `precedent compare --approved approved.json --rules new-run.json [--out new-candidates.json]`. Rules are matched by the review comments they cite (at least half of the smaller rule's comments in common), not by wording, because wording changes from run to run. It lists what is unchanged, reworded, new, and approved but not found again, and never changes the approved file; `--out` saves only the new candidates for a person to review. It does not decide anything: a rule missing from a run is not a reason to remove it. No network, no model.
- `stability` fetches the comments once, runs the whole extraction `--runs` times (default 3, no cache) and reports how much the runs agree at three cuts: the top `--top` rules (default 10, what a user reads), every rule, and the core rules only (3+ comments from 2+ reviewers). Two rules from different runs count as the same when they cite a comment in common; the wording-only overlap and the Jaccard of the matched rules' comment sets are printed as diagnostics. It also prints how many of a run's core rules every other run has too, and the strong rules that fewer than two runs reproduce. `--pin-extraction` reuses the model's per-comment answers from run 1, which separates the variance of extraction from that of merging and auditing. `--out FILE` saves every rule of every run, with all cited comments. Each run costs about as much as one `mine`.
- `review` only comments on lines the pull request added, reports each rule at most once per pull request, and cites the earlier pull requests where reviewers asked for the same thing.

## GitHub Action

Review every pull request against your team's rules.

1. Mine the rules once and commit them (`precedent mine owner/repo --out .precedent/rules.json`).
2. Add a repository secret `ANTHROPIC_API_KEY`.
3. Add this workflow:

```yaml
# .github/workflows/precedent.yml
name: Precedent
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pappgergely012/precedent@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Inputs: `mode` (`review` or `mine`, default `review`), `anthropic-api-key`, `github-token` (default `github.token`), `rules-file` (default `.precedent/rules.json`) and `post` (default `true`; set `false` for a dry run that only prints the findings to the job log).

Pull requests from forks do not get repository secrets, so the action skips them with a notice instead of failing.

To refresh the rules on a schedule, run the action in `mine` mode and open a pull request with the changed file:

```yaml
name: Precedent rules
on:
  schedule: [{ cron: "0 6 * * 1" }]
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  mine:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pappgergely012/precedent@main
        with:
          mode: mine
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
      - uses: peter-evans/create-pull-request@v7
        with:
          title: Update Precedent rules
          commit-message: Update Precedent rules
          branch: precedent/update-rules
          add-paths: .precedent/rules.json
```

## Planned

- Export of the rules to lint configs.

## Development

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm dev mine owner/repo
pnpm typecheck
pnpm test
```

Written in TypeScript (strict mode).

## License

Apache License 2.0. See [LICENSE](LICENSE).

## Using it as a library (unstable)

`src/index.ts` is the library entry point (`import { extractRules, anthropicLlm, ... } from "precedent"` once built with `pnpm build`). Importing it has no side effects; the CLI lives in `cli.ts`. The package is not published to npm and the surface may change before 1.0: a test pins the list of exports so changes are deliberate. Tests and callers can swap the model for a recorded one (`cachedLlm` / `replayLlm`) and run the whole pipeline without network or credit.
