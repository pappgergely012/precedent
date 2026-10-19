# Precedent

Learn your team's unwritten code review rules from past pull requests.

Precedent mines review comments and the changes that resolved them, turns recurring patterns into explicit rules, and cites the original pull request for every rule it applies.

> Status: early prototype. Nothing is usable yet.

## Planned

- `precedent mine <owner/repo>`: print the top rules found in a repository's PR history.
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
