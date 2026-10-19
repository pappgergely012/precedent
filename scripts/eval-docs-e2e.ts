// End-to-end check of `mine --docs`: a fixed mined-rules file plus the repository's real guide files,
// run through guide extraction, pairing proposals and verification, scored against hand labels.
// Usage: pnpm eval:docs:e2e [fixtures/docs-e2e-django.json] [runs]
import { readFile } from "node:fs/promises";
import { extractDocRules, fetchGuideDocs, proposePairs, reconcileRules } from "../src/docs.js";
import { anthropicLlm } from "../src/llm.js";
import type { Rule } from "../src/rule.js";

interface Fixture {
  repo: string;
  rules: Rule[];
  expected: Record<string, "both" | "conflict" | "enforced">;
  unscored: string[];
  implicit: string[];
}

const path = process.argv[2] ?? "fixtures/docs-e2e-django.json";
const runs = Number(process.argv[3] ?? 3);
const fx = JSON.parse(await readFile(path, "utf8")) as Fixture;
const docs = await fetchGuideDocs(fx.repo, { token: process.env.GITHUB_TOKEN });
console.log(`${fx.repo}: ${fx.rules.length} fixed mined rules, ${docs.length} guide files read.`);
const llm = anthropicLlm();

const scored = Object.keys(fx.expected);
const explicit = scored.filter((id) => !fx.implicit.includes(id));
const perRun: { all: number; explicit: number; wrong: string[] }[] = [];
for (let run = 1; run <= runs; run++) {
  const docRules = await extractDocRules(docs, llm);
  const proposals = proposePairs(fx.rules, docRules).length;
  const { rules, documentedOnly } = await reconcileRules(fx.rules, docRules, llm);
  const tag = new Map(rules.map((r) => [r.id, r.origin]));
  const ok = (id: string) => tag.get(id) === fx.expected[id];
  const wrong = scored.filter((id) => !ok(id)).map((id) => `${id} (expected ${fx.expected[id]}, got ${tag.get(id)})`);
  perRun.push({ all: scored.filter(ok).length / scored.length, explicit: explicit.filter(ok).length / explicit.length, wrong });
  console.log(`run ${run}: ${docRules.length} guide rules, ${proposals} proposed pairs, tag correctness ${perRun[run - 1]!.all.toFixed(2)} on ${scored.length} scored rules (${perRun[run - 1]!.explicit.toFixed(2)} on the ${explicit.length} explicitly labelled), ${documentedOnly.length} documented-only`);
  for (const w of perRun[run - 1]!.wrong) console.log(`   miss: ${w}`);
}
const u = llm.usage?.();
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`\ntag correctness over ${runs} runs: mean ${mean(perRun.map((r) => r.all)).toFixed(2)}, worst ${Math.min(...perRun.map((r) => r.all)).toFixed(2)}, best ${Math.max(...perRun.map((r) => r.all)).toFixed(2)}; explicit labels only: mean ${mean(perRun.map((r) => r.explicit)).toFixed(2)}`);
if (u) console.log(`model usage: ${u.calls} calls, ${u.inputTokens.toLocaleString("en-US")} input and ${u.outputTokens.toLocaleString("en-US")} output tokens`);
