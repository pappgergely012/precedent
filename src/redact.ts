/**
 * Best-effort masking of obvious secrets and personal data before text is sent to the model.
 * It catches well-known token formats, private key blocks, credentials in URLs, emails and
 * assignments of long values to secret-looking names. It is NOT a guarantee: a secret in a
 * format it does not know, a name, or any confidential wording passes through unchanged.
 */
export type RedactionKind = "email" | "token" | "private-key" | "credentials" | "secret-assignment";

const RULES: { kind: RedactionKind; pattern: RegExp; replace: string | ((match: string, ...groups: string[]) => string) }[] = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: "[REDACTED:private-key]" },
  { kind: "token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, replace: "[REDACTED:token]" },
  { kind: "token", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replace: "[REDACTED:token]" },
  { kind: "token", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: "[REDACTED:token]" },
  { kind: "token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: "[REDACTED:token]" },
  { kind: "token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: "[REDACTED:token]" },
  { kind: "token", pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, replace: (_m, prefix) => `${prefix}[REDACTED:token]` },
  { kind: "credentials", pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, replace: (_m, scheme) => `${scheme}[REDACTED:credentials]@` },
  { kind: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, replace: "[REDACTED:email]" },
  {
    kind: "secret-assignment",
    // name = value, with a long value made of token characters only (no spaces, quotes or parentheses),
    // so prose and code that merely mention a password or a token are left alone
    pattern: /\b((?:api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?key)\w*\s*[:=]\s*)(["']?)[A-Za-z0-9_\-/+=.]{16,}\2/gi,
    replace: (_m, name, quote) => `${name}${quote}[REDACTED:secret]${quote}`,
  },
];

export type RedactionCounts = Partial<Record<RedactionKind, number>>;

export function redactText(text: string): { text: string; counts: RedactionCounts } {
  const counts: RedactionCounts = {};
  let out = text;
  for (const { kind, pattern, replace } of RULES) {
    out = out.replace(pattern, (...args: unknown[]) => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      const match = args[0] as string;
      return typeof replace === "string" ? replace : replace(match, ...(args.slice(1) as string[]));
    });
  }
  return { text: out, counts };
}

export function addCounts(into: RedactionCounts, from: RedactionCounts): RedactionCounts {
  for (const [k, n] of Object.entries(from) as [RedactionKind, number][]) into[k] = (into[k] ?? 0) + n;
  return into;
}

/** One line for the terminal; never contains the masked values. */
export function describeRedaction(counts: RedactionCounts): string {
  const parts = (Object.entries(counts) as [RedactionKind, number][]).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`);
  return parts.length > 0
    ? `Redaction masked ${parts.join(", ")} before sending text to the model (best effort, not a guarantee).`
    : "Redaction found nothing to mask (best effort: formats it does not know pass through unchanged).";
}

/**
 * A redactor for one boundary (comments, guide files or diff patches). When disabled it returns
 * text unchanged. `line()` is the report for the terminal, or undefined when disabled.
 */
export function createRedactor(enabled: boolean): { text: (s: string) => string; line: () => string | undefined } {
  const counts: RedactionCounts = {};
  return {
    text: (s) => {
      if (!enabled) return s;
      const r = redactText(s);
      addCounts(counts, r.counts);
      return r.text;
    },
    line: () => (enabled ? describeRedaction(counts) : undefined),
  };
}
