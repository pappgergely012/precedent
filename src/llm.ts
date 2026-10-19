import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

/** Cheapest current model; rule mining runs many small calls. */
export const DEFAULT_MODEL = "claude-haiku-5-5";

/** Minimal LLM interface so the extraction logic can be tested without the network. */
export interface Llm {
  parse<S extends z.ZodTypeAny>(prompt: string, schema: S): Promise<z.infer<S>>;
}

export function anthropicLlm(opts: { model?: string; apiKey?: string } = {}): Llm {
  // Pin the base URL: ANTHROPIC_BASE_URL may point at an unrelated proxy
  // (for example inside a managed sandbox) that does not accept our key.
  const client = new Anthropic({
    // PRECEDENT_ANTHROPIC_API_KEY lets the key reach sandboxes that reserve ANTHROPIC_API_KEY.
    apiKey: opts.apiKey ?? process.env.PRECEDENT_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.PRECEDENT_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
  });
  const model = opts.model ?? process.env.PRECEDENT_MODEL ?? DEFAULT_MODEL;

  return {
    async parse(prompt, schema) {
      const response = await client.messages.parse({
        model,
        max_tokens: 8000,
        messages: [{ role: "user", content: prompt }],
        output_config: { effort: "low", format: zodOutputFormat(schema) },
      });
      if (response.stop_reason === "refusal") {
        throw new Error("The model declined to process this request");
      }
      if (response.parsed_output == null) {
        throw new Error(`Model output did not match the schema (stop_reason: ${response.stop_reason})`);
      }
      return response.parsed_output;
    },
  };
}
