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
/** Cache read is 0.1x input and cache write 1.25x, except where the table lists its own read price. */
const price = (input: number, output: number, cacheRead = input / 10): Price => ({
  input,
  cacheRead,
  cacheWrite: input * 1.25,
  output,
});

export const ANTHROPIC_PRICES: Readonly<Record<string, Price>> = {
  'claude-haiku-5-5': price(0.1, 0.5, 0.01),
  'claude-haiku-4-5': price(1, 5),
  'claude-sonnet-5-5': price(2, 10),
  'claude-sonnet-5': price(2, 10),
  'claude-sonnet-4-6': price(3, 15),
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25),
  'claude-opus-4-8': price(5, 25),
  'claude-opus-4-7': price(5, 25),
  'claude-opus-4-6': price(5, 25),
  'claude-fable-5-2': price(8, 40, 0.2),
  'claude-fable-5-1': price(10, 50),
  'claude-fable-5': price(10, 50),
};

/** A model with no price is charged as the dearest one listed: an unknown model must never be under-counted. */
const FALLBACK = 'claude-fable-5-1';

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
