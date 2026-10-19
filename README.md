# Precedent

Learn your team's unwritten code review rules from past pull requests.

Precedent mines review comments and the changes that resolved them, turns recurring patterns into explicit rules, and cites the original pull request for every rule it applies.

> Status: early prototype. `precedent mine` and `precedent review` work end to end; rule quality is still being tuned.

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

- `mine` reads up to `--max-pages` pages of review comments (default 30; paging stops early once enough top-level comments are collected), analyses the newest `--max-comments` (default 1000) and keeps rules backed by at least `--min-occurrences` comments (default 2) from at least 2 distinct pull requests. A rule's confidence is its number of distinct source pull requests divided by 5, capped at 1. The terminal shows the top 10 rules; `--out` saves all of them.
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

- Export of the rules to `CLAUDE.md`, `.cursorrules` and lint configs.

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
