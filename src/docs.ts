import { z } from "zod";
import { fetchWithRetry } from "./github.js";
import type { Llm } from "./llm.js";
import type { Rule } from "./rule.js";

const API = "https://api.github.com";

/** Where a repository usually writes its conventions down. Root-level and docs/ only. */
export const GUIDE_PATHS = [
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "STYLE.md",
  "docs/STYLE.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
];

const MAX_DOC_CHARS = 30_000;

export interface GuideDoc {
  path: string;
  text: string;
}

export interface DocRule {
  description: string;
  path: string;
  /** Verbatim text from the guide that states the rule. */
  quote: string;
}

export interface DocsOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_GUIDE_FILES = 12;
const MAX_GUIDE_BYTES = 100_000;
const GUIDE_EXTENSIONS = /\.(md|mdx|rst|txt|adoc)$/i;
/** Files that are always worth reading when they exist at the root. */
const ROOT_GUIDES = /^(contributing[^/]*|agents\.md|claude\.md|\.cursorrules|style[^/]*|\.github\/(contributing[^/]*|pull_request_template[^/]*))$/i;
const NOISE = /(^|\/)(node_modules|vendor|third_party|tests?|__tests__|fixtures?|locale|locales|i18n|translations?|releases?|changelog[^/]*|history[^/]*)(\/|$)/i;
const TOPIC = /(contributing|coding[-_ ]?style|style[-_ ]?guide|conventions|guidelines|submitting|committing|code[-_ ]?review|pull[-_ ]?request|working[-_ ]with[-_ ]git|unit[-_ ]tests|writing[-_ ](code|documentation))/i;

export interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

/**
 * Pick the files of a repository tree that most likely state its conventions: the usual root
 * files, then documents whose path or name is about contributing, style, patches or review.
 * Deeper and bigger files rank lower; at most `max` are returned.
 */
export function selectGuidePaths(tree: TreeEntry[], max = MAX_GUIDE_FILES): string[] {
  const scored: { path: string; score: number }[] = [];
  for (const e of tree) {
    if (e.type !== "blob" || (e.size ?? 0) > MAX_GUIDE_BYTES || NOISE.test(e.path)) continue;
    if (ROOT_GUIDES.test(e.path)) {
      scored.push({ path: e.path, score: 1000 });
      continue;
    }
    if (!GUIDE_EXTENSIONS.test(e.path) || e.path.split("/").length > 6) continue;
    const name = e.path.split("/").pop()!;
    const nameHit = TOPIC.test(name);
    const dirHit = TOPIC.test(e.path.slice(0, e.path.length - name.length));
    if (!nameHit && !dirHit) continue;
    const depth = e.path.split("/").length;
    scored.push({ path: e.path, score: (nameHit ? 60 : 20) + (dirHit ? 20 : 0) - depth });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, max)
    .map((s) => s.path);
}

/** Paths to read: found by scanning the repository tree, or the fixed list when the tree is unavailable. */
async function guidePaths(repo: string, doFetch: typeof fetch, headers: Record<string, string>, sleep?: (ms: number) => Promise<void>): Promise<string[]> {
  try {
    const res = await fetchWithRetry(doFetch, `${API}/repos/${repo}/git/trees/HEAD?recursive=1`, { headers: { ...headers, Accept: "application/vnd.github+json" } }, { sleep });
    if (res.ok) {
      const body = z.object({ tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().optional() })) }).parse(await res.json());
      const found = selectGuidePaths(body.tree);
      if (found.length > 0) return found;
    }
  } catch {
    // fall through to the fixed list
  }
  return GUIDE_PATHS;
}

/** Fetch the guide files that exist (missing files are skipped), each capped in size. */
export async function fetchGuideDocs(repo: string, opts: DocsOptions = {}): Promise<GuideDoc[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const docs: GuideDoc[] = [];
  for (const path of await guidePaths(repo, doFetch, headers, opts.sleep)) {
    const res = await fetchWithRetry(doFetch, `${API}/repos/${repo}/contents/${path}`, { headers }, { sleep: opts.sleep });
    if (!res.ok) continue; // missing, or a guide we cannot read: not worth failing the run for
    const text = (await res.text()).slice(0, MAX_DOC_CHARS);
    if (text.trim()) docs.push({ path, text });
  }
  return docs;
}

/**
 * A quote that only points elsewhere ("Please read the contributing guide", a bare link) states
 * no rule of its own, however much the linked page might.
 */
export function isPointer(quote: string): boolean {
  const withoutLinks = quote.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "").trim();
  if (withoutLinks.split(/\s+/).filter(Boolean).length < 4) return true;
  return /^(please\s+)?(read|see|refer to|check out|check|visit|have a look at)\b/i.test(withoutLinks);
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

const DocRulesSchema = z.object({
  rules: z.array(z.object({ description: z.string(), quote: z.string() })),
});

function docRulesPrompt(doc: GuideDoc): string {
  return `Below is a project's contributor guide (${doc.path}). Extract the concrete, checkable rules it states for code changes: things a reviewer could ask a contributor to do or stop doing (naming, tests, changelog or commit format, dependencies, formatting, process).

For each rule return:
- description: one imperative sentence
- quote: the exact text from the guide that states it, copied verbatim (a sentence or bullet, not a paraphrase)

Skip vague advice ("write clean code"), project history, setup instructions, pointers to other documents ("please read X", "see Y") and anything that is not an expectation of contributors. The quote itself must contain the expectation.

${doc.text}`;
}

/**
 * Rules the guides state, each with a verbatim quote. A rule whose quote cannot be found in
 * the guide text is dropped: the model must not invent documentation.
 */
export async function extractDocRules(docs: GuideDoc[], llm: Llm): Promise<DocRule[]> {
  const out: DocRule[] = [];
  for (const doc of docs) {
    const haystack = normalize(doc.text);
    const { rules } = await llm.parse(docRulesPrompt(doc), DocRulesSchema);
    for (const r of rules) {
      const quote = r.quote.trim();
      if (quote && !isPointer(quote) && haystack.includes(normalize(quote))) out.push({ description: r.description.trim(), path: doc.path, quote });
    }
  }
  return out;
}

const ReconcileSchema = z.object({
  matches: z.array(
    z.object({
      ruleIndex: z.number(),
      docIndex: z.number(),
      relation: z.enum(["same", "conflict"]),
    }),
  ),
});

function reconcilePrompt(rules: Rule[], docRules: DocRule[]): string {
  const mined = rules.map((r, i) => `[${i}] ${r.description}`).join("\n");
  const documented = docRules.map((d, i) => `[${i}] ${d.description} (guide says: "${d.quote.slice(0, 200)}")`).join("\n");
  return `Two lists of coding rules for one project. "Mined" rules come from what reviewers actually asked for in pull requests. "Documented" rules come from the project's written contributor guide.

For each mined rule that corresponds to a documented rule, return a match:
- relation "same": both ask for the same thing
- relation "conflict": following the mined rule would break the documented rule (they ask for opposite things about the same situation). Use this ONLY for a clear contradiction, not for rules that are merely different or about different situations.

Skip mined rules with no counterpart. Each mined rule appears at most once.

Mined rules:
${mined}

Documented rules:
${documented}`;
}

const VerifySchema = z.object({
  verdicts: z.array(z.object({ pair: z.number(), verdict: z.enum(["same", "conflict", "no"]) })),
});

function verifyPrompt(pairs: { ruleText: string; quote: string }[]): string {
  const blocks = pairs.map((p, i) => `Pair ${i}\nMined rule: ${p.ruleText}\nGuide text: "${p.quote}"`).join("\n\n");
  return `For each pair, judge ONLY from the guide text shown, read on its own.

- "same": the guide text, by itself, asks contributors to do what the mined rule says (not merely the same topic or area).
- "conflict": the guide text, by itself, clearly asks for the opposite of the mined rule in the same situation.
- "no": anything else, including text that only mentions the topic, only points to another document, covers a different situation, or is more general or more specific in a way that changes what is asked.

When unsure, answer "no".

${blocks}`;
}

export interface Reconciled {
  rules: Rule[];
  /** Documented rules no mined rule corresponds to: written down, but no review evidence. */
  documentedOnly: DocRule[];
}

/** Tag every mined rule as documented too ("both"), a possible conflict, or enforced only. */
export async function reconcileRules(rules: Rule[], docRules: DocRule[], llm: Llm): Promise<Reconciled> {
  if (docRules.length === 0 || rules.length === 0) {
    return { rules: rules.map((r) => ({ ...r, origin: "enforced" as const })), documentedOnly: docRules };
  }
  const { matches } = await llm.parse(reconcilePrompt(rules, docRules), ReconcileSchema);
  const byRule = new Map<number, { docIndex: number; relation: "same" | "conflict" }>();
  for (const m of matches) {
    if (rules[m.ruleIndex] && docRules[m.docIndex] && !byRule.has(m.ruleIndex)) byRule.set(m.ruleIndex, m);
  }

  // Second look at every proposed pair, with only the two texts in view: the first pass sees
  // many rules at once and over-matches on topic. Anything not confirmed is treated as enforced.
  const proposed = [...byRule.entries()];
  if (proposed.length > 0) {
    const verdicts = await llm.parse(
      verifyPrompt(proposed.map(([ruleIndex, m]) => ({ ruleText: rules[ruleIndex]!.description, quote: docRules[m.docIndex]!.quote }))),
      VerifySchema,
    );
    const verdictOf = new Map(verdicts.verdicts.map((v) => [v.pair, v.verdict]));
    proposed.forEach(([ruleIndex, m], pair) => {
      const verdict = verdictOf.get(pair);
      if (verdict === "same" || verdict === "conflict") byRule.set(ruleIndex, { docIndex: m.docIndex, relation: verdict });
      else byRule.delete(ruleIndex);
    });
  }
  const matchedDocs = new Set([...byRule.values()].map((m) => m.docIndex));
  const tagged = rules.map((rule, i): Rule => {
    const m = byRule.get(i);
    if (!m) return { ...rule, origin: "enforced" };
    const d = docRules[m.docIndex]!;
    return { ...rule, origin: m.relation === "conflict" ? "conflict" : "both", docRefs: [{ path: d.path, quote: d.quote }] };
  });
  return { rules: tagged, documentedOnly: docRules.filter((_, i) => !matchedDocs.has(i)) };
}
