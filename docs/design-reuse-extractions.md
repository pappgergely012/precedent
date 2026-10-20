# Design note: reusing per-comment extractions (`--reuse-extractions`)

Status: proposal, 2026-10-20. Default behaviour is unchanged. No claim is made that this improves stability or accuracy; that has not been measured.

## What already exists

`mine --cache FILE` already stores what the model said about each comment (the one-sentence principle, or "no rule") in `FILE`, and every later model answer (merge, audit, dedupe, `--docs`) in `FILE.responses.json`.

- A comment's entry is keyed by its GitHub comment id and a hash of `PROMPT_VERSION`, the model name and the exact text the model sees (`file: <path>` and the first 600 characters of the body; with `--extraction-votes N` the vote count is part of the text). A changed comment, model, prompt version or vote count is a miss and is asked again; a comment that no answer covered is never stored.
- The responses file is keyed on the full request, so any change in the input (one new comment changes the merge input) produces fresh calls for the later stages, and an identical re-run replays everything and returns the same rules.

So "reuse earlier extractions for unchanged comments and only extract new ones" is already possible with `--cache`.

## What is missing

`--cache` ties the two together. If you want the per-comment judgements frozen but the merge, audit and dedupe stages run live each time (for example to see how much those stages vary on identical extractions, or to pick up a changed merge prompt without paying for extraction again), you cannot ask for it. `stability --pin-extraction` does this inside one process only (in memory), not across runs.

## Proposal

A flag `mine --reuse-extractions FILE`, default off:

- Reads and writes the same per-comment cache file format as `--cache` (so a file made by `--cache` can be reused, and the reverse).
- Does **not** read or write `FILE.responses.json`: merge, audit, dedupe and `--docs` always call the model.
- Cannot be combined with `--cache` or `--no-cache` (one-line error before any fetch).
- `--dry-run` takes the cache into account as it already does for `--cache`.
- The run prints the existing `Cache hits: N` line; a run with hits is not a fresh-mining measurement and must not be reported as one.

No change to the default path: without the flag the code takes exactly the same branches as today (the golden test covers this).

## Privacy

- The file is local, next to the user's other `.precedent/` files, and is never uploaded by Precedent. It holds model-written sentences derived from review comments (customer text for a private repository), keys are hashes plus comment ids, and the comment text itself is not stored. The README already says to add `.precedent/` to `.gitignore`.
- With `--redact` the text that is hashed and sent is the redacted text, so a principle in the cache was produced from redacted input. Switching `--redact` on or off changes the text and therefore misses the cache; it never reuses an answer made from the other form.
- Deleting the file is the whole deletion story; there is no copy elsewhere.

## Invalidation

Automatic on: comment text change (including the 600-character cut), model change (`PRECEDENT_MODEL`), `PROMPT_VERSION` bump, `--extraction-votes` change. An unreadable or outdated file is treated as empty. Not automatic: a changed redaction pattern list (the redacted text changes, so it is a miss anyway); GitHub deleting a comment (the entry is simply unused).

## Tests (model-free)

Fixtures with a fake model: second run asks only for new comments; edited comment is re-asked; model or prompt-version change misses; stage calls (merge, audit) are made again on a second identical run; the flag together with `--cache`/`--no-cache` is refused; the default path makes the same calls as before; a file written by `--cache` is read by the flag.

## Open question

Is a separate flag worth carrying, given that `--cache` covers re-runs? The only user-visible difference is that later stages stay live. If that has no use beyond a measurement, a documented `--cache` plus `stability --pin-extraction` may be enough and the flag can be dropped.
