import { describe, expect, it } from 'vitest';

import { median, staleMembers } from '../../../lib/suggest/staleness';

const DAY = 24 * 60 * 60 * 1000;

describe('stale members', () => {
  it('takes the median of odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('flags a member both three times the group median and at least a week old', () => {
    const group = [
      { id: 'a', ageMs: 1 * DAY },
      { id: 'b', ageMs: 2 * DAY },
      { id: 'c', ageMs: 3 * DAY },
      { id: 'd', ageMs: 30 * DAY },
    ];
    const stale = staleMembers([group]);
    expect([...stale.keys()]).toEqual(['d']);
    expect(stale.get('d')).toEqual({ ageMs: 30 * DAY, medianMs: 2.5 * DAY });
  });

  it('keeps a group where everything is old quiet', () => {
    const done = [40, 50, 60, 70].map((days, index) => ({ id: String(index), ageMs: days * DAY }));
    expect(staleMembers([done]).size).toBe(0);
  });

  it('does not call anything under a week stale, however fast the group moves', () => {
    const fast = [0.1, 0.1, 0.1, 5].map((days, index) => ({
      id: String(index),
      ageMs: days * DAY,
    }));
    expect(staleMembers([fast]).size).toBe(0);
  });

  it('says nothing about a group too small to have a usual', () => {
    const small = [1, 1, 30].map((days, index) => ({ id: String(index), ageMs: days * DAY }));
    expect(staleMembers([small]).size).toBe(0);
  });
});
