# Recipe: review pull requests against your approved rules in GitHub Actions

Status: draft for a first design partner. Not yet security-reviewed by someone other than its author; do not point a partner at it before that. Nothing here is a hosted service: the workflow runs in your own repository with your own API key.

## What it does

On each pull request from a branch of the same repository, it downloads the diff, estimates the model calls, and if the estimate is within your cap runs `precedent review` against `.precedent/approved.json` from the **base** branch. The result goes to the job summary and, if you switch it on, into one pull request comment that is updated on each push. Findings are suggestions from a model that are checked in code (the rule must be one of your approved rules, the line must be an added line) and worded from your approved rule text and the comments it cites; they are not a verdict.

## Before you start

1. Mine and approve rules (`precedent mine`, then `precedent approve`), read the cited comments, and **commit** `.precedent/approved.json` to your default branch. It holds text derived from your review comments, so keep it in a private repository if the source repository is private.
2. Add the repository secret `PRECEDENT_ANTHROPIC_API_KEY` (Settings, Secrets and variables, Actions). Use a key with a spend limit.
3. Copy `examples/github-action/precedent-review.yml` to `.github/workflows/precedent-review.yml` and set `PRECEDENT_ENGINE_REF` to a full commit SHA of the `precedent` repository that you have read. Nothing else needs copying: the helper script is run from that pinned checkout.
4. Optional: set `POST_COMMENT: "true"` to also post a comment. Leave it `"false"` for a job summary only (then you can remove the `pull-requests: write` permission and the comment step).

After the package is published to npm, the three engine steps can be replaced by `npx precedent-review@<version> review ...`; until then the pinned checkout is the supported path.

## Safety choices

| Concern | What the recipe does |
|---|---|
| Fork pull requests | Trigger is `pull_request`, never `pull_request_target`; forks get no secrets and a read-only token, and the job also skips them (`head.repo.full_name == github.repository`). Drafts are skipped. |
| A pull request changing its own rules | Rules come from the base commit. The pull request head is never checked out and none of its code is run; the diff is downloaded as text. |
| Secrets | The API key is only in the environment of the one step that calls the model. Nothing prints it. Checkouts do not persist the token. |
| Script injection | No pull request title, body, branch name or other attacker-controlled field is used in a `run:` script. |
| Supply chain | Only `actions/checkout` and `actions/setup-node` plus the pinned engine commit. Pin the actions to SHAs too if your policy requires it. |
| Prompt injection from the diff | The diff is fenced with a per-call random delimiter and declared to be data; the model may only answer with a rule id, a path and a line, which code validates; the posted text is composed from your approved rule text. This reduces the risk; it does not remove it, which is why the output is a suggestion and never blocks a merge. |
| Output hygiene | Output is stripped of control characters and HTML, `@mentions` are defused, links with unsafe schemes and images are removed, and the text is cut to 60,000 characters. |
| Cost | `MAX_CALLS` (default 20) skips the review when the estimate is higher; `MAX_FILES` (default 30) limits files; one run per pull request at a time (`concurrency`); 10-minute job timeout; `--redact` masks obvious secrets in the diff before it is sent to the model (best effort, see the README). |
| Failure | Fail-open: any error ends in a "Not reviewed: ..." note and a green job. It never blocks a merge. |

## What a team still decides

- Whether sending diffs of your repository to the model provider is acceptable (it is, for the files that have an applicable rule). Read the data-handling notes in the README first.
- Who may change `.precedent/approved.json` (protect the default branch; it is the policy).
- The cap values. The estimate is rough (off by up to about 30%) and a skipped run says so.

## Tested without a model

`src/ghrecipe.test.ts` runs the helper script against a stub CLI: findings, a clean result, an over-cap skip, a crashing CLI, a missing key or rules file (all fail-open), output sanitising, and that the key never appears in output. It also checks the workflow text for the properties in the table above (trigger, permissions, one step with the secret, base-commit checkout, no attacker-controlled interpolation, first-party actions only). It does not run the workflow on GitHub; do that on a throwaway pull request first.
