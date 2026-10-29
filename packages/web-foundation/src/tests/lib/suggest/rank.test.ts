import { describe, expect, it } from 'vitest';

import { rankByScore } from '../../../lib/suggest/rank';

describe('ranking by score', () => {
  const identity = (option: string): string => option;

  it('puts scored options first, strongest first, and keeps the given order for the rest', () => {
    const scores = new Map([
      ['Done', 1],
      ['Review', 3],
    ]);
    expect(rankByScore(['Backlog', 'Doing', 'Review', 'Done'], scores, identity)).toEqual([
      'Review',
      'Done',
      'Backlog',
      'Doing',
    ]);
  });

  it('breaks ties by the given order', () => {
    const scores = new Map([
      ['b', 1],
      ['a', 1],
    ]);
    expect(rankByScore(['a', 'b', 'c'], scores, identity)).toEqual(['a', 'b', 'c']);
  });

  it('returns the very same list when nothing is scored', () => {
    const options = ['a', 'b'];
    expect(rankByScore(options, new Map(), identity)).toBe(options);
  });
});
