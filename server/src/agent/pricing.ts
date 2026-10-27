import type Anthropic from "@anthropic-ai/sdk";
import type { UsageTotals } from "./events.js";

/** USD per million tokens. An estimate for the UI, not a billing source of truth. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function addUsage(total: UsageTotals, usage: Anthropic.Beta.BetaUsage): UsageTotals {
  return {
    inputTokens: total.inputTokens + usage.input_tokens,
    outputTokens: total.outputTokens + usage.output_tokens,
    cacheReadInputTokens: total.cacheReadInputTokens + (usage.cache_read_input_tokens ?? 0),
    cacheCreationInputTokens: total.cacheCreationInputTokens + (usage.cache_creation_input_tokens ?? 0),
  };
}

export function estimateCostUsd(model: string, usage: UsageTotals): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const cost =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadInputTokens * price.cacheRead +
    usage.cacheCreationInputTokens * price.cacheWrite;
  return cost / 1_000_000;
}
