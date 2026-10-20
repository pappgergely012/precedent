# Recipe: review pull requests against your approved rules in GitHub Actions

Status: draft for a first design partner. The first security review (internal, 2026-10-20) found two blocking problems that this version fixes; it needs a re-check before any partner is pointed at it. Nothing here is a hosted service: the workflow runs in your own repository with your own API key.

## What it does

On each pull request from a branch of the same repository, it downloads the diff, estimates the model calls, and if the estimate is within your cap runs `precedent review` against `.precedent/approved.json` from the **base** branch. The result goes to the job summary and, if you switch it on, into one pull request comment that is updated on each push. Findings are suggestions from a model that are checked in code (the rule must be one of your approved rules, the line must be an added line) and worded from your approved rule text and the comments it cites; they are not a verdict.

## Before you start

1. Mine and approve rules (`precedent mine`, then `precedent approve`), read the cited comments, and **commit** `.precedent/approved.json` to your default branch. It holds text derived from your review comments, so keep it in a private repository if the source repository is private.
2. Add the repository secret `PRECEDENT_ANTHROPIC_API_KEY` (Settings, Secrets and variables, Actions). Use a key with a spend limit.
3. Copy `examples/github-action/precedent-review.yml` to `.github/workflows/precedent-review.yml` and set `PRECEDENT_ENGINE_REF` to a full commit SHA of the `precedent` repository that you have read. Nothing else needs copying: the helper script is run from that pinned checkout.
4. Optional: create the repository variable `PRECEDENT_POST_COMMENT` with the value `true` to also post one comment (updated on each push). Without it the result is only in the job summary and the second job does not run.
5. **Do not make this check "required"** in branch protection. It is advisory and fail-open; if you require it, an outage or a skipped run could still show as a problem.

After the package is published to npm, the three engine steps can be replaced by `npx precedent-review@<version> review ...`; until then the pinned checkout is the supported path.

## Safety choices

| Concern | What the recipe does |
|---|---|
| Fork pull requests | Trigger is `pull_request`, never `pull_request_target`; forks get no secrets and a read-only token, and both jobs also skip them (`head.repo.full_name == github.repository`). Drafts are skipped. Dependabot pull requests get no secrets from GitHub, so they end with a "no API key" note. |
| A pull request changing its own rules | Rules come from the base commit. The pull request head is never checked out and none of its code is run; the diff is downloaded as text. |
| Who can read the key | The key is only in the environment of the one step that calls the model, and nothing prints it. But anyone who can push a branch to this repository can edit this workflow in their branch (the `pull_request` event uses the workflow file from the pull request) and read the secret. Treat write access as access to the key, and use a key with a spend limit. |
| Tokens | The job that holds the key and runs the engine has a read-only token. A separate job, with no key and no engine or pull request code, has `pull-requests: write` and only posts the text. Checkouts do not persist the token. |
| Script injection | No pull request title, body, branch name or other attacker-controlled field is used in a `run:` script. |
| Supply chain | Only first-party actions (`checkout`, `setup-node`, `upload-artifact`, `download-artifact`), each pinned to a full commit SHA, plus the engine at a commit you pin. The package manager is pinned to an exact version and installs run with `--ignore-scripts`. |
| Prompt injection from the diff | The diff is fenced with a per-call random delimiter and declared to be data; the model may only answer with a rule id, a path and a line, which code validates; the posted text is composed from your approved rule text. This reduces the risk; it does not remove it, which is why the output is a suggestion and never blocks a merge. |
| Output hygiene | File names are printed as inline code with backticks, brackets and line breaks removed. All output is stripped of control characters and HTML, `@mentions` are defused, every markdown link, image, bare URL and `www.` address is removed except the evidence links the engine builds for this repository (`[#12](https://github.com/OWNER/REPO/pull/12#discussion_r34)`), and the text is cut to 60,000 characters. |
| Cost | `MAX_CALLS` (default 20) skips the review when the estimate is higher, so one push spends at most about `MAX_CALLS` calls; one pull request spends at most `MAX_CALLS` times its number of pushes (one run per pull request at a time; a new push cancels the old run). `MAX_FILES` limits files; 10-minute timeout; `--redact` masks obvious secrets in the diff before it is sent to the model (best effort). |
| Failure | Fail-open at every step: the placeholder engine pin, a failed checkout, build or diff download (the API refuses very large diffs), a missing key or rules file, a crashing CLI all end in a "Not reviewed: ..." note and a green job. Both jobs are `continue-on-error`. |

## What a team still decides

- Whether sending diffs of your repository to the model provider is acceptable (it is, for the files that have an applicable rule). Read the data-handling notes in the README first.
- Who may change `.precedent/approved.json` (protect the default branch; it is the policy).
- The cap values. The estimate is rough (off by up to about 30%) and a skipped run says so.

## Tested without a model

`src/ghrecipe.test.ts` runs the helper script against a stub CLI: findings, a clean result, an over-cap skip, a crashing CLI, a missing key or rules file (all fail-open), output sanitising, and that the key never appears in output. It also checks the workflow text for the properties in the table above (trigger, read-only default permissions with a single write job that has no secret, fail-open on every step, the placeholder pin, one step with the secret, base-commit checkout, no attacker-controlled interpolation, first-party actions pinned to SHAs, the bot-login check for the comment). Link removal is tested on a file named `docs/[click here](https://evil.example/x).md`. It does not run the workflow on GitHub; do that on a throwaway pull request first.
