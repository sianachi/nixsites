import { describe, expect, it } from 'vitest';

import { DUPLICATE_THRESHOLD, similarTitles } from '../../../lib/suggest/duplicates';

describe('the duplicate title check', () => {
  const candidates = [
    { id: 'a', title: 'Pay electricity bill' },
    { id: 'b', title: 'Invoice March' },
    { id: 'c', title: 'Weekly review' },
  ];

  it('finds a near-identical title despite a plural and a case change', () => {
    const matches = similarTitles('pay electricity bills', candidates);
    expect(matches[0]?.id).toBe('a');
    expect(matches[0]?.similarity).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  it('keeps titles that merely share a theme apart', () => {
    // "Invoice April" shares a word with "Invoice March" and scores about 0.4.
    expect(similarTitles('Invoice April', candidates)).toEqual([]);
  });

  it('scores an exact match as one', () => {
    expect(similarTitles('Weekly review', candidates)[0]).toEqual({
      id: 'c',
      title: 'Weekly review',
      similarity: 1,
    });
  });

  it('checks nothing shorter than three characters', () => {
    expect(similarTitles('Pa', [{ id: 'x', title: 'Pa' }])).toEqual([]);
  });

  it('orders by similarity and honours the limit', () => {
    const many = [
      { id: '1', title: 'Weekly review notes' },
      { id: '2', title: 'Weekly review' },
      { id: '3', title: 'Weekly reviews' },
    ];
    const matches = similarTitles('Weekly review', many, 0.5, 2);
    expect(matches.map((match) => match.id)).toEqual(['2', '3']);
  });
});
