/**
 * Expected model usage of one `mine` run, from the number of comments alone, so it can be shown
 * before anything is spent. The constants are averages of measured runs (assumption: other
 * repositories differ by up to about 30%):
 *
 *   run            comments analysed   calls   input tokens   output tokens
 *   ripgrep        300                 13      41,000         11,000
 *   kubernetes     1000                33      160,000        34,000
 *   django         1000                33      143,000        37,000
 *
 * An extraction call (40 comments) costs about 4,000 input and 900 output tokens; the merge,
 * audit and dedupe steps together cost about 8 calls, 55,000 input and 12,000 output tokens for
 * 1000 comments and scale down with fewer.
 */
export const EXTRACTION_BATCH = { input: 4_000, output: 900 };
export const FOLLOW_UP = { calls: 8, input: 55_000, output: 12_000, forComments: 1_000 };

export interface UsageEstimate {
  /** Comments that would be sent to the model (not answered from the cache). */
  pending: number;
  extractionCalls: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export function estimateUsage(opts: { usable: number; pending?: number; batchSize?: number; votes?: number }): UsageEstimate {
  const { usable, batchSize = 40, votes = 1 } = opts;
  const pending = opts.pending ?? usable;
  const extractionCalls = Math.ceil(pending / batchSize) * Math.max(1, votes);
  const scale = Math.min(1, usable / FOLLOW_UP.forComments);
  const followCalls = usable === 0 ? 0 : Math.max(4, Math.round(FOLLOW_UP.calls * scale));
  const followInput = usable === 0 ? 0 : Math.round(FOLLOW_UP.input * scale);
  const followOutput = usable === 0 ? 0 : Math.round(FOLLOW_UP.output * scale);
  return {
    pending,
    extractionCalls,
    calls: extractionCalls + followCalls,
    inputTokens: extractionCalls * EXTRACTION_BATCH.input + followInput,
    outputTokens: extractionCalls * EXTRACTION_BATCH.output + followOutput,
  };
}

export function describeEstimate(e: UsageEstimate, usable: number, votes: number): string[] {
  const n = (x: number) => x.toLocaleString("en-US");
  return [
    `Dry run: ${n(usable)} comments would be analysed${e.pending < usable ? ` (${n(usable - e.pending)} already in the cache)` : ""}${votes > 1 ? `, each asked ${votes} times` : ""}.`,
    `Expected model usage: about ${e.calls} calls, ${n(e.inputTokens)} input and ${n(e.outputTokens)} output tokens (an estimate from earlier runs, off by up to about 30%). No model call was made.`,
  ];
}
