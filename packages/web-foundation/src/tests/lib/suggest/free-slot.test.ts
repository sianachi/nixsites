import { describe, expect, it } from 'vitest';

import { nextFreeSlot } from '../../../lib/suggest/free-slot';

const HOUR = 60 * 60 * 1000;

describe('the next free slot', () => {
  const day = [{ start: 9 * HOUR, end: 17 * HOUR }];

  it('takes the start of the window when nothing is busy', () => {
    expect(nextFreeSlot(day, [], HOUR, 0)).toEqual({ start: 9 * HOUR, end: 10 * HOUR });
  });

  it('starts exactly when a busy span ends, and fits exactly before the next', () => {
    const busy = [
      { start: 9 * HOUR, end: 10 * HOUR },
      { start: 11 * HOUR, end: 12 * HOUR },
    ];
    expect(nextFreeSlot(day, busy, HOUR, 0)).toEqual({ start: 10 * HOUR, end: 11 * HOUR });
  });

  it('skips a gap too short and handles overlapping busy spans', () => {
    const busy = [
      { start: 9 * HOUR, end: 12 * HOUR },
      { start: 10 * HOUR, end: 10.5 * HOUR },
      { start: 12.5 * HOUR, end: 14 * HOUR },
    ];
    expect(nextFreeSlot(day, busy, HOUR, 0)).toEqual({ start: 14 * HOUR, end: 15 * HOUR });
  });

  it('respects the earliest start and moves to a later window when the first is full', () => {
    const windows = [day[0] ?? { start: 0, end: 0 }, { start: 33 * HOUR, end: 41 * HOUR }];
    expect(nextFreeSlot(windows, [], 2 * HOUR, 16 * HOUR)).toEqual({
      start: 33 * HOUR,
      end: 35 * HOUR,
    });
  });

  it('answers null when nothing fits or the duration is not positive', () => {
    expect(nextFreeSlot(day, [{ start: 0, end: 24 * HOUR }], HOUR, 0)).toBeNull();
    expect(nextFreeSlot(day, [], 0, 0)).toBeNull();
  });
});
