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

/**
 * The words of a guide passage without its markup. Guides are full of reStructuredText roles
 * (`:meth:` with a module path inside), literals, link targets and line wraps that the model
 * drops when it quotes: a role keeps its label or its last name, a link keeps its text, and
 * only letters and digits are compared.
 */
const squash = (text: string) =>
  text
    .replace(/:[a-zA-Z]+:`([^`]*)`/g, (_m, body: string) => {
      const label = /^(.*?)\s*<[^>]*>$/.exec(body)?.[1] ?? body;
      return label.replace(/^[~!]/, "").split(".").pop() ?? label;
    })
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/** The quote appears in the guide text, ignoring markup, case and whitespace. */
export function quoteInText(quote: string, text: string): boolean {
  const q = squash(quote);
  return q.length >= 12 && squash(text).includes(q);
}

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
    const { rules } = await llm.parse(docRulesPrompt(doc), DocRulesSchema);
    for (const r of rules) {
      const quote = r.quote.trim();
      if (quote && !isPointer(quote) && quoteInText(quote, doc.text)) out.push({ description: r.description.trim(), path: doc.path, quote });
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
  return `For each pair, judge ONLY from the guide text shown, read on its own. The mined rule comes from what reviewers asked for; the guide text is what the project wrote down.

- "same": the guide text asks contributors to do what the mined rule asks. The rule may be shorter or less detailed than the guide (or the other way round) and still be "same", as long as doing what the guide says is doing what the rule says in the common case. Sharing a topic is not enough.
- "conflict": following the guide text would mean breaking the mined rule, or the other way round: one requires something the other forbids, in the same kind of situation.
- "no": anything else: only the topic is shared, a different behaviour or situation, a pointer to another document, or no clear relation.

Examples (not from this project):
- Rule "Do not add tests for private helpers." / Guide "Every change must include tests." -> conflict (a requirement against a prohibition about the same changes).
- Rule "Keep functions short." / Guide "Functions longer than 50 lines must be split." -> same.
- Rule "Name test files after the module." / Guide "Run the linter before pushing." -> no (different behaviours).

When unsure between "same" and "no", answer "no". Answer "conflict" only when one text requires what the other forbids.

${blocks}`;
}

export interface Reconciled {
  rules: Rule[];
  /** Documented rules no mined rule corresponds to: written down, but no review evidence. */
  documentedOnly: DocRule[];
}

const STOP = new Set(["a", "an", "the", "to", "of", "in", "on", "for", "and", "or", "when", "with", "that", "is", "are", "be", "not", "do", "does", "it", "its", "as", "at", "by", "from", "this", "than", "instead", "rather", "should", "must", "always", "never", "use", "add", "each", "every", "new"]);

/**
 * Lower-cased content words with a crude plural/-ing stem, so "tests" and "test" meet. Identifiers
 * are split at camelCase boundaries and runs of one letter are shortened ("XXXX" and "XX" are the
 * same placeholder), so RemovedInDjangoXXWarning and RemovedInDjangoXXXXWarning share their words.
 */
const words = (text: string): Set<string> =>
  new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map((t) => t.replace(/(.)\1{2,}/g, "$1$1"))
      .filter((t) => t.length > 1 && !STOP.has(t))
      .map((t) => (t.length > 3 ? t.replace(/(ing|es|s)$/, "") : t)),
  );

/** Shared content words as a share of the shorter text, and how many there are. */
export function wordOverlap(a: string, b: string): { share: number; shared: number } {
  const wa = words(a);
  const wb = words(b);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return { share: shared / Math.max(1, Math.min(wa.size, wb.size)), shared };
}

const CANDIDATES_PER_SIDE = 3;
const VERIFY_BATCH = 40;
/** A documented rule this close in wording to a mined rule is the same rule, whatever the second look said. */
const NEAR_IDENTICAL = { share: 0.7, shared: 3 };
/** The weakest lexical similarity worth sending to the strict second look. */
const MIN_PROPOSAL_SCORE = 0.15;
/** Pairs sent to the second look in one run: bounds the verification calls whatever the number of guide files. */
const MAX_PROPOSALS = 150;

/** Inverse document frequency over a set of texts: words that few texts use say more about a pair. */
function idfOf(texts: string[]): (word: string) => number {
  const df = new Map<string, number>();
  for (const t of texts) for (const w of words(t)) df.set(w, (df.get(w) ?? 0) + 1);
  return (w) => Math.log(1 + texts.length / (df.get(w) ?? 1));
}

/** Weight of the words two texts share, as a share of the lighter text's total weight. */
function weightedOverlap(a: Set<string>, b: Set<string>, idf: (w: string) => number): number {
  let shared = 0;
  let wa = 0;
  let wb = 0;
  for (const w of a) wa += idf(w);
  for (const w of b) wb += idf(w);
  for (const w of a) if (b.has(w)) shared += idf(w);
  const base = Math.min(wa, wb);
  return base === 0 ? 0 : shared / base;
}

/**
 * Pairs worth a strict second look, a pure function of the texts: for every mined rule its closest
 * guide rules and for every guide rule its closest mined rules (lexical, weighted towards
 * distinctive words), so the proposals do not depend on what the model happens to suggest.
 */
export function proposePairs(rules: Rule[], docRules: DocRule[]): { ruleIndex: number; docIndex: number }[] {
  const ruleTexts = rules.map((r) => r.description);
  const docTexts = docRules.map((d) => `${d.description} ${d.quote}`);
  const idf = idfOf([...ruleTexts, ...docTexts]);
  const ruleWords = ruleTexts.map(words);
  const docWords = docTexts.map(words);
  const score = (i: number, j: number) => weightedOverlap(ruleWords[i]!, docWords[j]!, idf);

  const out = new Map<string, { ruleIndex: number; docIndex: number; s: number }>();
  const add = (ruleIndex: number, docIndex: number, s: number) => out.set(`${ruleIndex}:${docIndex}`, { ruleIndex, docIndex, s });
  rules.forEach((_, i) => {
    docRules
      .map((_d, j) => ({ j, s: score(i, j) }))
      .filter((c) => c.s >= MIN_PROPOSAL_SCORE)
      .sort((x, y) => y.s - x.s || x.j - y.j)
      .slice(0, CANDIDATES_PER_SIDE)
      .forEach((c) => add(i, c.j, c.s));
  });
  docRules.forEach((_, j) => {
    rules
      .map((_r, i) => ({ i, s: score(i, j) }))
      .filter((c) => c.s >= MIN_PROPOSAL_SCORE)
      .sort((x, y) => y.s - x.s || x.i - y.i)
      .slice(0, CANDIDATES_PER_SIDE)
      .forEach((c) => add(c.i, j, c.s));
  });
  return [...out.values()]
    .sort((a, b) => b.s - a.s || a.ruleIndex - b.ruleIndex || a.docIndex - b.docIndex)
    .slice(0, MAX_PROPOSALS)
    .map(({ ruleIndex, docIndex }) => ({ ruleIndex, docIndex }))
    .sort((a, b) => a.ruleIndex - b.ruleIndex || a.docIndex - b.docIndex);
}

type Verdict = "same" | "conflict" | "no";

export async function judgePairs(pairs: { ruleText: string; quote: string }[], llm: Llm): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (let i = 0; i < pairs.length; i += VERIFY_BATCH) {
    const chunk = pairs.slice(i, i + VERIFY_BATCH);
    const { verdicts } = await llm.parse(verifyPrompt(chunk), VerifySchema);
    const byPair = new Map(verdicts.map((v) => [v.pair, v.verdict]));
    chunk.forEach((_, j) => out.push(byPair.get(j) ?? "no"));
  }
  return out;
}

/**
 * `judgePairs` asked `votes` times, majority wins (a tie is "no"). One sample of the model is
 * noisy on borderline pairs; the verdict a pair keeps is the one most samples agree on.
 */
export async function judgeMajority(pairs: { ruleText: string; quote: string }[], llm: Llm, votes = 3): Promise<Verdict[]> {
  const rounds = await Promise.all(Array.from({ length: votes }, () => judgePairs(pairs, llm)));
  return pairs.map((_, i) => {
    const counts = new Map<Verdict, number>();
    for (const round of rounds) counts.set(round[i]!, (counts.get(round[i]!) ?? 0) + 1);
    const [verdict, n] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
    return n > votes / 2 ? verdict : "no";
  });
}

/** Tag every mined rule as documented too ("both"), a possible conflict, or enforced only. */
export async function reconcileRules(rules: Rule[], docRules: DocRule[], llm: Llm): Promise<Reconciled> {
  if (docRules.length === 0 || rules.length === 0) {
    return { rules: rules.map((r) => ({ ...r, origin: "enforced" as const })), documentedOnly: docRules };
  }
  const { matches } = await llm.parse(reconcilePrompt(rules, docRules), ReconcileSchema);

  // Proposals: what the first pass matched, plus the closest documented rules by wording, so a
  // match the first pass missed still gets the strict second look.
  const proposals = new Map<string, { ruleIndex: number; docIndex: number }>();
  const propose = (ruleIndex: number, docIndex: number) => {
    if (rules[ruleIndex] && docRules[docIndex]) proposals.set(`${ruleIndex}:${docIndex}`, { ruleIndex, docIndex });
  };
  for (const m of matches) propose(m.ruleIndex, m.docIndex);
  for (const p of proposePairs(rules, docRules)) propose(p.ruleIndex, p.docIndex);

  // Second look at every proposed pair with only the two texts in view. Anything not confirmed
  // is treated as enforced. A conflict is a serious claim, so it must be confirmed twice.
  const list = [...proposals.values()];
  const first = await judgeMajority(list.map((p) => ({ ruleText: rules[p.ruleIndex]!.description, quote: docRules[p.docIndex]!.quote })), llm);
  const conflicts = list.map((_, i) => i).filter((i) => first[i] === "conflict");
  if (conflicts.length > 0) {
    const again = await judgeMajority(conflicts.map((i) => ({ ruleText: rules[list[i]!.ruleIndex]!.description, quote: docRules[list[i]!.docIndex]!.quote })), llm);
    conflicts.forEach((i, j) => {
      if (again[j] !== "conflict") first[i] = "no";
    });
  }

  // One tag per mined rule: a confirmed conflict wins, otherwise the closest confirmed match.
  const byRule = new Map<number, { docIndex: number; relation: "same" | "conflict"; share: number }>();
  list.forEach((p, i) => {
    const verdict = first[i];
    if (verdict !== "same" && verdict !== "conflict") return;
    const d = docRules[p.docIndex]!;
    const { share } = wordOverlap(rules[p.ruleIndex]!.description, `${d.description} ${d.quote}`);
    const have = byRule.get(p.ruleIndex);
    if (!have || (verdict === "conflict" && have.relation !== "conflict") || (verdict === have.relation && share > have.share)) {
      byRule.set(p.ruleIndex, { docIndex: p.docIndex, relation: verdict, share });
    }
  });

  const matchedDocs = new Set([...proposals.values()].filter((p, i) => first[i] === "same" || first[i] === "conflict").map((p) => p.docIndex));
  const tagged = rules.map((rule, i): Rule => {
    const m = byRule.get(i);
    if (!m) return { ...rule, origin: "enforced" };
    const d = docRules[m.docIndex]!;
    return { ...rule, origin: m.relation === "conflict" ? "conflict" : "both", docRefs: [{ path: d.path, quote: d.quote }] };
  });
  // "Written in the guide but not seen in review" must not list a rule that reviews do show,
  // however the second look judged it: drop documented rules that restate a mined rule.
  const restated = (d: DocRule) =>
    rules.some((r) => {
      const o = wordOverlap(r.description, d.description);
      return o.share >= NEAR_IDENTICAL.share && o.shared >= NEAR_IDENTICAL.shared;
    });
  return { rules: tagged, documentedOnly: docRules.filter((d, i) => !matchedDocs.has(i) && !restated(d)) };
}
