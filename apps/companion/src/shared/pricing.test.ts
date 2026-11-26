import { describe, expect, it } from 'vitest';

import { ANTHROPIC_MODELS } from '../server/wire.ts';
import { ANTHROPIC_CHAT_MODEL, DEEP_MODELS, THINKING } from './models.ts';
import { ANTHROPIC_PRICES, claudeModelId, estimateCostUsd } from './pricing.ts';

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
      ...Object.keys(THINKING),
      ...ANTHROPIC_MODELS.map((m) => m.id),
    ];
    for (const model of chosen) expect(ANTHROPIC_PRICES[model], model).toBeDefined();
  });

  it('adds the four token kinds at their own rates', () => {
    expect(estimateCostUsd('anthropic', 'claude-haiku-5-5', usage)).toBeCloseTo(
      0.1 + 0.01 + 0.125 + 0.5,
    );
  });

  it('prices an unlisted Claude model as the dearest one, never below any listed model', () => {
    const unlisted = estimateCostUsd('anthropic', 'claude-future', usage) ?? 0;
    expect(unlisted).toBeCloseTo(10 + 1 + 12.5 + 50);
    for (const model of Object.keys(ANTHROPIC_PRICES))
      expect(unlisted, model).toBeGreaterThanOrEqual(
        estimateCostUsd('anthropic', model, usage) ?? 0,
      );
  });

  it('charges Opus 5.5 at its own rate, not Sonnet 5.5', () => {
    expect(estimateCostUsd('anthropic', 'claude-opus-5-5', usage)).toBeCloseTo(4 + 0.2 + 5 + 20);
  });

  it('maps an OpenRouter Claude id to its own price and leaves other ids to the dearest fallback', () => {
    expect(claudeModelId('anthropic/claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
    expect(claudeModelId('anthropic/claude-haiku-5.5:thinking')).toBe('claude-haiku-5-5');
    expect(claudeModelId('openai/gpt-x')).toBe('openai/gpt-x');
    expect(
      estimateCostUsd('anthropic', claudeModelId('anthropic/claude-sonnet-4.6'), usage),
    ).toBeCloseTo(3 + 0.3 + 3.75 + 15);
  });

  it('takes the cost OpenRouter reports, or none', () => {
    expect(estimateCostUsd('openrouter', 'x/y', { ...usage, cost_usd: 0.42 })).toBe(0.42);
    expect(estimateCostUsd('openrouter', 'x/y', usage)).toBeNull();
  });
});
