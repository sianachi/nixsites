import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { todayInTimezone, weekWindow } from '../../../habit-tracker/habit-tracker-view';

describe('habit tracker calendar controls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 18, 23, 0, 0)));
  });

  afterEach(() => vi.useRealTimers());

  it('anchors the current week on Monday and supports backfill navigation', () => {
    expect(weekWindow().days).toEqual([
      '2026-03-16',
      '2026-03-17',
      '2026-03-18',
      '2026-03-19',
      '2026-03-20',
      '2026-03-21',
      '2026-03-22',
    ]);
    expect(weekWindow(-1).from).toBe('2026-03-09');
    expect(weekWindow(1).to).toBe('2026-03-29');
  });

  it('answers today in the habit timezone', () => {
    expect(todayInTimezone('Pacific/Honolulu')).toBe('2026-03-18');
    expect(todayInTimezone('Asia/Tokyo')).toBe('2026-03-19');
  });
});
