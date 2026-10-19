# Precedent

Learn your team's unwritten code review rules from past pull requests.

Precedent mines review comments and the changes that resolved them, turns recurring patterns into explicit rules, and cites the original pull request for every rule it applies.

> Status: early prototype. `precedent mine` works end to end; rule quality is still being tuned.

## Planned

- `precedent mine <owner/repo>`: print the top 10 rules found in a repository's PR history. Needs `GITHUB_TOKEN` and `PRECEDENT_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`). Uses `claude-haiku-5-5` by default (override with `PRECEDENT_MODEL`); roughly two small LLM calls per 40 comments, capped at the newest 200 comments.
- A rule format (see `src/rule.ts`) that can be exported to `CLAUDE.md`, `.cursorrules` and lint configs.

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
