/** Usage text. `precedent <command> --help` prints only that command's part. */
const SECTIONS: Record<string, { usage: string[]; about: string; flags: [string, string][] }> = {
  check: {
    usage: ["precedent check <owner/repo> [--comments-file FILE]"],
    about: "Count the inline review comments of the last 12 months and say whether core rules are likely, possible or unlikely. No model, no API key.",
    flags: [["--comments-file FILE", "read the comments from a saved snapshot instead of GitHub (saved there when it does not exist; .gz allowed)"]],
  },
  mine: {
    usage: [
      "precedent mine <owner/repo> [--out FILE] [--max-pages N] [--max-comments N] [--min-occurrences N] [--max-age-days N] [--cache FILE] [--no-cache] [--reuse-extractions FILE] [--redact] [--pre-merge] [--comments-file FILE] [--extraction-votes N] [--shared-merge X] [--dry-run] [--verify] [--docs] [--all] [--verbose]",
    ],
    about: "Mine the rules a team enforces in review from past pull request comments. Needs GITHUB_TOKEN and PRECEDENT_ANTHROPIC_API_KEY.",
    flags: [
      ["--out FILE", "save every rule to a rules file"],
      ["--max-pages N / --max-comments N / --max-age-days N / --min-occurrences N", "how much history to read and how much evidence a rule needs"],
      ["--cache FILE / --no-cache", "keep and re-use the model's answers (FILE and FILE.responses.json); --no-cache ignores them"],
      ["--reuse-extractions FILE", "reuse only the per-comment judgements saved in FILE (same format as --cache); merge, audit and dedupe still call the model; not combinable with --cache/--no-cache"],
      ["--redact", "mask obvious secrets and emails before text is sent to the model (best effort)"],
      ["--dry-run", "print the expected model calls and tokens without calling the model"],
      ["--verify", "re-fetch every cited comment and drop rules whose citations do not resolve"],
      ["--docs", "(beta) compare the rules with the repository's written guides"],
      ["--all", "list the emerging candidates too"],
      ["--pre-merge / --extraction-votes N / --shared-merge X", "experimental variants, off by default"],
      ["--comments-file FILE", "use a saved snapshot of the comments"],
    ],
  },
  approve: {
    usage: ["precedent approve [--from FILE] [--to FILE] [--list | --id ID ... | --all-core] [--note TEXT] [--force-related]"],
    about: "Pin the rules your team has read and accepted into a team-owned file (default .precedent/approved.json). Without a selection it lists the candidates and their ids. Approved rules are never changed or replaced by a later run; `export` and `review` use that file when it exists. No model, no API key.",
    flags: [
      ["--from FILE", "the candidates (default .precedent/rules.json)"],
      ["--to FILE", "the approved file (default .precedent/approved.json)"],
      ["--id ID / --all-core", "approve these rules / every core rule (read them first)"],
      ["--list", "list the candidates and ids"],
      ["--force-related", "with --all-core, also approve candidates that cite the same comments as an approved rule (skipped by default as near-duplicates)"],
      ["--note TEXT", "a note stored with the rules approved by this command (shown by approve and compare; never exported, never sent to a model)"],
    ],
  },
  compare: {
    usage: ["precedent compare --approved FILE [--rules FILE] [--out FILE]"],
    about: "Treat a new run as a diff against the rules your team already approved. Rules are matched by the review comments they cite, not by wording. The approved file is never changed; --out saves the new candidates for a person to review. No model, no API key.",
    flags: [
      ["--approved FILE", "the rules file your team approved (default .precedent/approved.json if it exists)"],
      ["--rules FILE", "the new run (default .precedent/rules.json)"],
      ["--out FILE", "save only the new candidates to a rules file"],
    ],
  },
  export: {
    usage: ["precedent export --format claude|agents|cursor [--rules FILE] [--out FILE] [--min-confidence N] [--max-rules N] [--include-single-reviewer] [--include-emerging] [--all]"],
    about: "Write the core rules into CLAUDE.md, AGENTS.md or .cursorrules between markers. No network, no model. Read the result before committing it.",
    flags: [
      ["--format claude|agents|cursor", "target file style"],
      ["--out FILE", "update FILE (a .bak of the original is kept once); without it the block is printed"],
      ["--min-confidence N / --max-rules N", "leave out weak rules; cap the list (default 30)"],
      ["--include-single-reviewer / --include-emerging", "also export rules with one reviewer or thinner evidence"],
      ["--all", "export every rule in the file (the default for a file written by `approve`)"],
    ],
  },
  stability: {
    usage: [
      "precedent stability <owner/repo> [--runs N] [--redact] [--comments-file FILE] [--extraction-votes N] [--shared-merge X] [--pre-merge] [--top N] [--verbose] [--pin-extraction] [--out FILE] [--max-comments N]",
    ],
    about: "Mine the same history several times and measure how much the rules agree between runs. Costs about as much as that many `mine` runs.",
    flags: [
      ["--runs N", "how many runs (default 3)"],
      ["--pin-extraction", "re-use the first run's per-comment answers (a diagnostic, not a fresh-run measurement)"],
      ["--verbose / --top N / --out FILE", "stage details, size of the top cut, save the full result"],
    ],
  },
  review: {
    usage: [
      "precedent review <owner/repo> <pr-number> [--rules FILE] [--post] [--redact] [--dry-run] [--max-files N]",
      "precedent review --diff FILE [--rules FILE] [--redact] [--dry-run] [--max-files N]",
    ],
    about: "Check a pull request (or a local diff) against the mined rules. Prints the findings; only --post posts them.",
    flags: [
      ["--rules FILE", "rules file (default .precedent/approved.json if it exists, else .precedent/rules.json)"],
      ["--post", "post the findings as one pull request review (needs GITHUB_TOKEN with write access)"],
      ["--dry-run", "print the files, model calls and rough tokens without calling the model"],
      ["--max-files N", "review at most N files (default 100; the ones with the most added lines)"],
    ],
  },
};

export const COMMANDS = Object.keys(SECTIONS);

/** The whole usage, or one command's usage with a short description and its main flags. */
export function helpFor(command?: string): string {
  const one = command ? SECTIONS[command] : undefined;
  if (!one) {
    return `Usage:\n${COMMANDS.flatMap((c) => SECTIONS[c]!.usage.map((u) => `  ${u}`)).join("\n")}\n\nRun "precedent <command> --help" for what a command does and its flags. Also: --help, --version.`;
  }
  const flags = one.flags.map(([f, d]) => `  ${f}\n      ${d}`).join("\n");
  return `Usage:\n${one.usage.map((u) => `  ${u}`).join("\n")}\n\n${one.about}\n\nFlags:\n${flags}`;
}
