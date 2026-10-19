// Runs the strict pair verifier of `mine --docs` on the regression cases in
// fixtures/docs-regression.json against the real model. Usage: pnpm eval:docs
import { readFile } from "node:fs/promises";
import { judgeMajority } from "../src/docs.js";
import { anthropicLlm } from "../src/llm.js";

interface Case {
  id: string;
  repo: string;
  rule: string;
  quote: string;
  expected: "same" | "conflict" | "no";
  contested?: string;
}

const { cases } = JSON.parse(await readFile(new URL("../fixtures/docs-regression.json", import.meta.url), "utf8")) as { cases: Case[] };
const llm = anthropicLlm();
const runs = 3;
const results: string[][] = [];
for (let i = 0; i < runs; i++) results.push(await judgeMajority(cases.map((c) => ({ ruleText: c.rule, quote: c.quote })), llm));

let agreed = 0;
let contestedMisses = 0;
let misses = 0;
for (const [i, c] of cases.entries()) {
  const got = results.map((r) => r[i]!);
  const ok = got.every((g) => g === c.expected);
  if (ok) agreed++;
  else if (c.contested) contestedMisses++;
  else misses++;
  console.log(`${ok ? "ok  " : c.contested ? "disp" : "FAIL"} ${c.id.padEnd(36)} expected ${c.expected.padEnd(8)} got ${got.join(", ")}${c.contested && !ok ? "   (contested)" : ""}`);
}
console.log(`\n${agreed}/${cases.length} cases match in all ${runs} runs; ${contestedMisses} contested, ${misses} other misses.`);
process.exitCode = misses > 0 ? 1 : 0;
