/** The one line the CLI prints for an unexpected error. A dropped connection gets a cause and a next step. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = String((error as { cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code ?? "");
  const first = message.split("\n")[0]!;
  if (/^(terminated|fetch failed)$/i.test(message.trim()) || /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_.*)$/.test(code)) {
    return `Error: network problem (${first}${code ? `, ${code}` : ""}): the connection was dropped. Nothing from this attempt is saved; run the command again. A drop while fetching comments from GitHub costs nothing; model calls that already completed are billed.`;
  }
  // The model API answers with "<status> {json}": show the sentence in it, not the JSON.
  const api = /^(\d{3}) (\{[\s\S]*\})$/.exec(message.trim());
  if (api) {
    try {
      const body = JSON.parse(api[2]!) as { error?: { type?: string; message?: string } };
      const detail = (body.error?.message ?? "").split("\n")[0]!.slice(0, 200);
      if (api[1] === "404" && (body.error?.type === "not_found_error" || /^model\b/i.test(detail))) {
        return `Error: the model was not found (${detail || "unknown model"}). Check PRECEDENT_MODEL, or unset it to use the default.`;
      }
      if (api[1] === "401") return "Error: the Anthropic API rejected the key (401). Check PRECEDENT_ANTHROPIC_API_KEY.";
      return `Error: the Anthropic API answered ${api[1]}${detail ? `: ${detail}` : ""}.`;
    } catch {
      // not JSON after all: fall through
    }
  }
  return `Error: ${first}`;
}

/** What to tell the person when a run with a cache file is cut short: what was kept, and what was spent. */
export function describeResume(path: string, saved: boolean, usage?: { calls: number; inputTokens: number; outputTokens: number }): string {
  const spent = usage ? ` Model use so far: ${usage.calls} calls, ${usage.inputTokens.toLocaleString("en-US")} input and ${usage.outputTokens.toLocaleString("en-US")} output tokens.` : "";
  return saved
    ? `Progress so far is saved in ${path}; run the same command again to resume without paying again for the batches that finished.${spent}`
    : `Nothing from this run was saved in ${path} (no batch had finished).${spent}`;
}
