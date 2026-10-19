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

- `mine` reads up to `--max-pages` pages of review comments (default 30; paging stops early once enough top-level comments are collected), analyses the newest `--max-comments` (default 1000) and keeps rules backed by at least `--min-occurrences` comments (default 2) from at least 2 distinct pull requests. A rule's confidence is its number of distinct source pull requests divided by 5, capped at 1. Comments older than `--max-age-days` (default 730) are ignored, near-duplicate rules are merged in a final pass, and rules backed by a single reviewer get lower confidence and a "single reviewer" flag. The terminal lists the core rules (3+ comments from 2+ reviewers) and only counts the emerging candidates (thinner evidence); `--all` lists those too. The tier describes how much evidence a rule has; it is not a guarantee that a later run finds the same rule, since the model's judgements vary between runs (measured on repeated runs: most core rules were found again on 3 of 4 repositories, but not on all). The terminal shows at most 10 rules per list; `--out` saves all of them. Add `--verify` to re-fetch every cited comment from GitHub and drop rules whose citations do not resolve. Add `--dry-run` to fetch the comments (GitHub only) and print how many model calls and tokens the run is expected to use, without calling the model or needing an API key (an estimate from earlier runs, off by up to about 30%). Add `--pre-merge` (experimental) to group candidate principles that are worded almost identically before the model merges them, which makes those groups independent of one model sample (not yet measured on real repositories). Add `--cache FILE` (for example `.precedent/cache.json`) to remember what the model said about each comment: re-mining then only sends new or edited comments to the model, which makes repeated runs cheaper and more consistent (the cache is keyed on the exact comment text, the model and the prompt version).
- `mine --docs` (beta) also reads the repository's written guides: the root files (`CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, style guides, the pull request template) and up to 12 documents found by scanning the repository for contributing, coding-style, submitting-patches and review guides (for example `guides/source/contributing_to_ruby_on_rails.md` or `docs/internals/contributing/...`) and tags each mined rule: *enforced in reviews, not written in the guide*, *documented in the guide too* (with the quote), or *possible conflict* with the guide. Rules the guide states but the review comments never show are listed separately. A rule only counts as documented when a strict second pass confirms the quoted guide text itself asks for the same thing (a possible conflict must be confirmed twice); candidates for that pass come from the model and from the closest wording, and guide rules that merely restate a mined rule are not listed as documented-only. Some real matches will still be missed. Other documentation is not read.
- `export` turns a rules file into the context file your coding agents read, with a link to the review comments behind every rule: `precedent export --format claude --out CLAUDE.md` (also `agents` for `AGENTS.md` and `cursor` for `.cursorrules`; without `--out` it prints to the terminal). It needs no network and no model. The rules sit between `precedent:start` and `precedent:end` markers: re-exporting replaces only that block and leaves the rest of the file alone. By default it exports only core rules (3+ comments from 2+ reviewers, `--include-emerging` adds the rest) with confidence of at least 0.4 (`--min-confidence`), skips rules only one reviewer asked for (`--include-single-reviewer` keeps them) and caps the list at 30 (`--max-rules`).
- `stability` fetches the comments once, runs the whole extraction `--runs` times (default 3, no cache) and reports how much the runs agree at three cuts: the top `--top` rules (default 10, what a user reads), every rule, and the core rules only (3+ comments from 2+ reviewers, or confidence 0.6+). Two rules from different runs count as the same when they cite a comment in common; the wording-only overlap and the Jaccard of the matched rules' comment sets are printed as diagnostics. It also prints how many of a run's core rules every other run has too, and the strong rules that fewer than two runs reproduce. `--pin-extraction` reuses the model's per-comment answers from run 1, which separates the variance of extraction from that of merging and auditing. `--out FILE` saves every rule of every run, with all cited comments. Each run costs about as much as one `mine`.
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
