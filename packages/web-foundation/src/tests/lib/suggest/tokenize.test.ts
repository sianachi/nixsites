import { describe, expect, it } from 'vitest';

import { titleSimilarity, tokens, words } from '../../../lib/suggest/tokenize';

describe('tokenize', () => {
  it('splits on non-letters in any script and drops function words', () => {
    expect(words('Pay the Électricité bill, 2026!')).toEqual([
      'pay',
      'the',
      'électricité',
      'bill',
      '2026',
    ]);
    expect(tokens('Pay the electricity bill')).toEqual(['pay', 'electricity', 'bill']);
  });

  it('scores near-duplicate titles above unrelated ones', () => {
    const near = titleSimilarity('Electricity invoice September', 'Electricity invoice (Sept)');
    const far = titleSimilarity('Electricity invoice September', 'Plan the garden');
    expect(near).toBeGreaterThan(0.4);
    expect(far).toBeLessThan(0.15);
    expect(titleSimilarity('', 'x')).toBe(0);
  });
});
