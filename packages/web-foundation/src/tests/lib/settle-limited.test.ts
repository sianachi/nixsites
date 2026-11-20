import { describe, expect, it } from 'vitest';

import { settleLimited } from '../../lib/settle-limited';

describe('settleLimited', () => {
  it('never has more than the limit in flight and keeps every result in order', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await settleLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      if (n === 4) throw new Error('four');
      return n * 2;
    });

    expect(peak).toBe(3);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(results[6]).toEqual({ status: 'fulfilled', value: 14 });
  });

  it('handles an empty list', async () => {
    expect(await settleLimited([], 3, () => Promise.resolve(1))).toEqual([]);
  });
});
