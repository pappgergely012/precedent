import type { Rule } from "./rule.js";

type Candidate = Pick<Rule, "description" | "scope">;

const ENGLISH_WORDS = new Set(
  "the a an to in on of for and or with when instead not do use add keep put make from by is are be that this it as at if unless than rather only must should every each all any no new into over under without before after".split(" "),
);

/** Rule titles must be English (rubric): reject text in other scripts, or long text with no English function word. */
export function isEnglishText(text: string): boolean {
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length === 0) return true;
  const nonLatin = letters.filter((ch) => !/\p{Script=Latin}/u.test(ch)).length;
  if (nonLatin / letters.length > 0.2) return false;
  const words = text.toLowerCase().match(/[a-zÀ-ɏ]+/g) ?? [];
  if (words.length >= 6 && !words.some((w) => ENGLISH_WORDS.has(w))) return false;
  return true;
}

const TOOL_ARTEFACT = /(^|[\s/`'"*(])\.claude(\/|\b)|\.local\.(json|md|ya?ml|toml)\b|\*\.local\./i;

/** Rules about files that coding agents or local tooling generate are not team conventions. */
export function isToolArtefact(rule: Candidate): boolean {
  return TOOL_ARTEFACT.test(rule.description) || rule.scope.some((s) => TOOL_ARTEFACT.test(s));
}

export function dropReason(rule: Candidate): "non-english" | "tool-artefact" | undefined {
  if (!isEnglishText(rule.description)) return "non-english";
  if (isToolArtefact(rule)) return "tool-artefact";
  return undefined;
}
