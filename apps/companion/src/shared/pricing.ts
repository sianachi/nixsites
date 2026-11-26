import { DEEP_MODELS } from './models.ts';
import type { ProviderUsage } from './types.ts';

/** USD per million tokens, from the claude-api skill's model table (26 November 2026). */
interface Price {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

// shortcut: Haiku's published price doubles-plus past 100K prompt tokens; this is the base rate,
// so a very long Haiku turn is under-estimated. Upgrade when long prompts are common.
export const ANTHROPIC_PRICES: Readonly<Record<string, Price>> = {
  'claude-haiku-5-5': { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
};

/** A model the owner picked that has no price falls back to the larger model's: never under-count. */
const FALLBACK = DEEP_MODELS.anthropic ?? 'claude-sonnet-5-5';

/** The estimated cost of one turn in USD; OpenRouter's own figure when it sent one, else unknown. */
export function estimateCostUsd(
  provider: string,
  model: string,
  usage: ProviderUsage,
): number | null {
  if (provider !== 'anthropic') return usage.cost_usd ?? null;
  const price = ANTHROPIC_PRICES[model] ?? ANTHROPIC_PRICES[FALLBACK];
  if (price === undefined) return null;
  return (
    (usage.input_tokens * price.input +
      usage.cache_read_input_tokens * price.cacheRead +
      usage.cache_creation_input_tokens * price.cacheWrite +
      usage.output_tokens * price.output) /
    1_000_000
  );
}
