import { describe, expect, it } from 'vitest';

import { ANTHROPIC_CHAT_MODEL, DEEP_MODELS, THINKING_OFF } from './models.ts';
import { ANTHROPIC_PRICES, estimateCostUsd } from './pricing.ts';

const usage = {
  input_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000,
  cache_creation_input_tokens: 1_000_000,
  output_tokens: 1_000_000,
};

describe('pricing', () => {
  it('prices every model the code can choose', () => {
    const chosen = [
      ANTHROPIC_CHAT_MODEL,
      ...Object.values(DEEP_MODELS),
      ...Object.keys(THINKING_OFF),
    ];
    for (const model of chosen) expect(ANTHROPIC_PRICES[model], model).toBeDefined();
  });

  it('adds the four token kinds at their own rates', () => {
    expect(estimateCostUsd('anthropic', 'claude-haiku-5-5', usage)).toBeCloseTo(
      0.1 + 0.01 + 0.125 + 0.5,
    );
  });

  it('prices an unlisted Claude model as the larger one', () => {
    expect(estimateCostUsd('anthropic', 'claude-future', usage)).toBeCloseTo(2 + 0.1 + 2.5 + 10);
  });

  it('takes the cost OpenRouter reports, or none', () => {
    expect(estimateCostUsd('openrouter', 'x/y', { ...usage, cost_usd: 0.42 })).toBe(0.42);
    expect(estimateCostUsd('openrouter', 'x/y', usage)).toBeNull();
  });
});
