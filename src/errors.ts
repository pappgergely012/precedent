/** The one line the CLI prints for an unexpected error. A dropped connection gets a cause and a next step. */
export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = String((error as { cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code ?? "");
  const first = message.split("\n")[0]!;
  if (/^(terminated|fetch failed)$/i.test(message.trim()) || /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_.*)$/.test(code)) {
    return `Error: network problem (${first}${code ? `, ${code}` : ""}): the connection was dropped. Nothing from this attempt is saved; run the command again. A drop while fetching comments from GitHub costs nothing; model calls that already completed are billed.`;
  }
  return `Error: ${first}`;
}
