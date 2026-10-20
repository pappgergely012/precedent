import { access, chmod, constants, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ruleTier, type Rule } from "./rule.js";
import type { RulesFile } from "./rulesfile.js";

export type ExportFormat = "claude" | "agents" | "cursor";

export interface ExportOptions {
  format: ExportFormat;
  /** Rules below this confidence are left out: agent files should stay short and trustworthy. */
  minConfidence?: number;
  maxRules?: number;
  /** Rules asked for by one reviewer only are left out unless this is set. */
  includeSingleReviewer?: boolean;
  /** Only core rules (3+ comments from 2+ reviewers) are exported unless this is set. */
  includeEmerging?: boolean;
  /** Export every rule in the file (only the cap applies): for a file your team approved, which is its own selection. */
  all?: boolean;
  /** The rules file the block was made from, named in the header so the reader edits the right file. */
  rulesPath?: string;
}

export const START_MARKER = "<!-- precedent:start";
export const END_MARKER = "<!-- precedent:end -->";
const SOURCES_PER_RULE = 3;

const distinctPrs = (r: Rule) => new Set(r.sources.map((s) => s.prNumber)).size;
const reviewers = (r: Rule) => new Set(r.sources.map((s) => s.reviewer)).size;

/** Rules worth handing to an agent, best first. */
export function selectRules(rules: Rule[], opts: ExportOptions): Rule[] {
  const { minConfidence = 0.4, maxRules = 30, includeSingleReviewer = false, includeEmerging = false } = opts;
  return rules
    .filter((r) => opts.all || r.confidence >= minConfidence && (opts.all || ((includeSingleReviewer || reviewers(r) >= 2) && (includeEmerging || ruleTier(r) === "core"))))
    .sort((a, b) => b.confidence - a.confidence || distinctPrs(b) - distinctPrs(a) || a.description.localeCompare(b.description))
    .slice(0, maxRules);
}

/** Longest rule text exported; agent files should stay short. */
export const MAX_RULE_CHARS = 500;

const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2028-\u202f\u205f-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/gu;

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Cut on a grapheme boundary so an emoji or a combined character is never split. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let out = "";
  for (const { segment } of graphemes.segment(text)) {
    if (out.length + segment.length > maxChars - 1) break;
    out += segment;
  }
  return `${out.trimEnd()}…`;
}

/**
 * Rule text comes from review comments and rules files, so it is untrusted input to files that
 * agents and editors read. Strip control and bidi characters, make `<` inert (no comment markers,
 * HTML tags or images), turn code fences into plain quotes, drop markdown image syntax, collapse
 * to one line and cap the length.
 */
export function cleanText(text: string, maxChars = MAX_RULE_CHARS): string {
  let out = text
    .replace(/[\r\n\t]+/g, " ")
    .replace(INVISIBLE, "")
    .replace(/</g, "&lt;")
    .replace(/`{3,}/g, "'")
    .replace(/!\[/g, "[")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(out, maxChars);
}

/** A glob is rendered inside backticks, so it must not contain one. */
const cleanGlob = (glob: string) => cleanText(glob, 200).replace(/`/g, "'");

export const SAFE_URL = /^https:\/\/[^\s<>()"'`\\]+$/;

/** One source per pull request, so three links mean three different discussions. Unsafe URLs are skipped. */
function citations(rule: Rule): { prNumber: number; url: string }[] {
  const seen = new Set<number>();
  const out: { prNumber: number; url: string }[] = [];
  for (const s of rule.sources) {
    if (seen.has(s.prNumber) || !SAFE_URL.test(s.commentUrl)) continue;
    seen.add(s.prNumber);
    out.push({ prNumber: s.prNumber, url: s.commentUrl });
    if (out.length === SOURCES_PER_RULE) break;
  }
  return out;
}

function renderRule(rule: Rule, format: ExportFormat): string | undefined {
  const description = cleanText(rule.description);
  if (description === "") return undefined;
  const globs = rule.scope.map(cleanGlob).filter((g) => g !== "");
  const scope = globs.length ? ` (${globs.map((g) => (format === "cursor" ? g : `\`${g}\``)).join(", ")})` : "";
  const cites = citations(rule);
  if (cites.length === 0) return `- ${description}${scope}`;
  if (format === "cursor") {
    return `- ${description}${scope}\n  Source: ${cites.map((c) => c.url).join(" ")}`;
  }
  const links = cites.map((c) => `[#${c.prNumber}](${c.url})`).join(", ");
  return `- ${description}${scope}\n  Why: reviewers asked for this in ${links}`;
}

/** Inside the start marker comment: no way to close the comment early. */
const commentSafe = (text: string) => cleanText(text, 120).replace(/-->/g, "--&gt;").replace(/--/g, "- -");

/** The generated block, markers included. Deterministic for a given rules file and options. */
export function renderBlock(file: RulesFile, opts: ExportOptions): string {
  const rules = selectRules(file.rules, opts);
  const rendered = rules.filter((r) => cleanText(r.description) !== "").length;
  const day = commentSafe(file.minedAt.slice(0, 10));
  const lines = [
    `${START_MARKER} (generated by precedent from ${commentSafe(file.repo)}, mined ${day}; edit ${commentSafe(opts.rulesPath ?? ".precedent/rules.json")} and re-run \`precedent export\`, not this block) -->`,
    "## Team review rules",
    "",
    rendered > 0
      ? "Conventions this team's reviewers enforce. Each rule links to the review comments behind it."
      : "No rule met the export thresholds yet.",
    "",
    ...rules.flatMap((r) => renderRule(r, opts.format) ?? []),
    END_MARKER,
  ];
  return lines.join("\n");
}

/** Thrown when the target file cannot be updated without risking text we did not write. */
export class ExportError extends Error {}

/** ASCII whitespace only: the file may be read as bytes, where 0xA0 is part of a multi-byte character. */
const isBlank = (text: string) => /^[ \t\r\n]*$/.test(text);

const countOf = (text: string, needle: string) => text.split(needle).length - 1;

/**
 * Insert the block into existing file content: replace the previous generated block, or append
 * when there is none. Content outside the markers and the file's line endings are kept. When the
 * markers are not exactly one balanced pair (a stale start marker, two blocks, an end marker
 * alone) it refuses instead of guessing, because any guess could delete the user's text.
 */
export function applyBlock(existing: string | undefined, block: string): string {
  if (countOf(block, START_MARKER) !== 1 || countOf(block, END_MARKER) !== 1) {
    throw new ExportError("Internal error: the generated block does not contain exactly one start and one end marker; nothing was written.");
  }
  if (existing === undefined || isBlank(existing)) return `${block}\n`;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const body = eol === "\r\n" ? block.replace(/\n/g, "\r\n") : block;
  const starts = countOf(existing, START_MARKER);
  const ends = countOf(existing, END_MARKER);
  if (starts === 0 && ends === 0) return `${existing.replace(/[ \t\r\n]+$/, "")}${eol}${eol}${body}${eol}`;
  const start = existing.indexOf(START_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (starts !== 1 || ends !== 1 || end < start) {
    throw new ExportError(
      `Found ${starts} precedent start marker(s) and ${ends} end marker(s) in the target file; expected exactly one pair (start first). Fix or remove the stray marker line(s) and run the export again. Nothing was written.`,
    );
  }
  return existing.slice(0, start) + body + existing.slice(end + END_MARKER.length);
}

/**
 * Update `path` with the block: refuse on unbalanced markers, keep the original once as
 * `<path>.bak` before the first change, and replace the file atomically (temp file in the same
 * directory, then rename) so a crash cannot leave a half-written agent file.
 *
 * A symlink is followed and the real file is updated, so `CLAUDE.md -> AGENTS.md` stays a link.
 * The file is handled as bytes: everything outside the block is written back exactly, even when
 * it is not valid UTF-8. A read-only target is refused rather than replaced.
 */
export async function writeExport(path: string, block: string): Promise<{ backedUp: boolean }> {
  const target = await realpath(path).catch(() => path);
  const bytes = await readFile(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (bytes !== undefined && !(await access(target, constants.W_OK).then(() => true, () => false))) {
    throw new ExportError(`${target} is read-only; nothing was written.`);
  }
  // latin1 maps every byte to one character, so splicing text into it cannot damage other bytes.
  const existing = bytes?.toString("latin1");
  const next = applyBlock(existing, Buffer.from(block, "utf8").toString("latin1"));
  if (next === existing) return { backedUp: false };
  await mkdir(dirname(target), { recursive: true });
  let backedUp = false;
  if (bytes !== undefined && !isBlank(existing!)) {
    const backup = `${target}.bak`;
    if (!(await stat(backup).then(() => true, () => false))) {
      await copyFile(target, backup);
      backedUp = true;
    }
  }
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temp, Buffer.from(next, "latin1"));
    if (bytes !== undefined) await chmod(temp, (await stat(target)).mode & 0o777);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { backedUp };
}

/** Rule texts that look like instructions aimed at an agent rather than a convention: worth a look before export. */
export function suspiciousRules(rules: Rule[]): Rule[] {
  return rules.filter((r) => /https?:\/\/|\$\(|\|\s*(?:ba)?sh\b|\b(?:curl|wget|eval|sudo|chmod|chown|powershell|iex|npx)\b|\brm\s+-[a-z]*[rf]|\bbase64\s+(?:-d|--decode)\b|\b(?:pip3?|npm|pnpm|yarn|brew|apt(?:-get)?|gem)\s+(?:i|install|add)\b|ignore (?:all |any )?(?:previous|prior|above)|<\|[a-z_]+\|>|\b(?:system|assistant) prompt\b/i.test(r.description));
}
