# Contributing to Precedent

Thanks for helping. Precedent mines the rules a team already enforces in code review and cites the comments behind each one, so the bar for changes is **precision over recall**: a rule that is wrong or unsupported does more harm than a rule that is missing.

## Setup

Requires Node 22+ and pnpm 10.

```sh
pnpm install
pnpm typecheck
pnpm test
```

Tests never call the network or a model: they use fake clients (see `src/llmcache.ts` for the record/replay client). `pnpm dev -- mine owner/repo` runs the CLI against a real repository and needs `GITHUB_TOKEN` and `PRECEDENT_ANTHROPIC_API_KEY`; `mine --dry-run` prints the expected cost first and needs neither model nor key.

## Making a change

1. Branch from `main` and keep the change small and focused.
2. Add or update tests for new logic. `pnpm typecheck` and `pnpm test` must pass; CI runs both.
3. If behaviour or a flag changes, update `README.md` in the same pull request.
4. Open a pull request describing what changed and how you checked it.

## Claims about quality

Numbers about rule quality (precision, stability, cost) must come from a run you can point to. Say what was measured, on which repository, and what was not. Do not tune on a labelled set and then report the same set as validation.

## Code style

TypeScript in strict mode, Zod for schemas, Vitest for tests. Match the surrounding code: naming, comment density and error handling. Keep user-facing messages to one clear line.

## Privacy

Never commit secrets, tokens or customer data, and do not paste private repository content into issues or tests. `--redact` masks well-known secret formats before text reaches the model, but it is best effort.

## Language

Code, comments, documentation, commit messages, issues and pull requests are written in English.
