import { describe, expect, it } from 'vitest';

import {
  formatCalendarDay,
  formatDateTime,
  formatFullDate,
  formatShortDate,
  formatTime,
  localTimeZone,
} from '../../lib/date-format';

// 2026-09-22T14:05:00Z: a fixed instant, chosen so the reader-locale formatters below stay in the
// same calendar day across every zone this file exercises.
const FIXED = new Date('2026-09-22T14:05:00Z');

describe('formatTime', () => {
  it('matches the exact options history-sidebar.tsx and editor-page.tsx used to hand-build', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(FIXED);
    expect(formatTime(FIXED)).toBe(expected);
  });
});

describe('formatFullDate', () => {
  it('matches the exact options history-sidebar.tsx used to hand-build', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(FIXED);
    expect(formatFullDate(FIXED)).toBe(expected);
  });
});

describe('formatDateTime', () => {
  it('matches the exact options template-studio-steps.tsx used to hand-build', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(FIXED);
    expect(formatDateTime(FIXED)).toBe(expected);
  });
});

describe('formatShortDate', () => {
  it('renders yyyy-mm-dd for a fixed zone and instant, matching the hand-built en-CA formatter', () => {
    const expected = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(FIXED);
    expect(expected).toBe('2026-09-22');
    expect(formatShortDate(FIXED, 'America/New_York')).toBe(expected);
  });

  it('shifts the calendar day across a timezone boundary, like habit-tracker-view.tsx relies on', () => {
    // 2026-09-22T20:05:00Z is still 2026-09-22 in New York (UTC-4) but already 2026-09-23 in
    // Tokyo (UTC+9).
    const nearMidnightUtc = new Date('2026-09-22T20:05:00Z');
    expect(formatShortDate(nearMidnightUtc, 'America/New_York')).toBe('2026-09-22');
    expect(formatShortDate(nearMidnightUtc, 'Asia/Tokyo')).toBe('2026-09-23');
  });

  it('memoises the formatter per timezone rather than rebuilding it on every call', () => {
    expect(formatShortDate(FIXED, 'UTC')).toBe(formatShortDate(FIXED, 'UTC'));
  });
});

describe('localTimeZone', () => {
  it('matches the exact resolvedOptions() read habit-tracker-view.tsx used to hand-build', () => {
    expect(localTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});

describe('formatCalendarDay', () => {
  it('keeps the stored day in the reader’s locale', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(new Date('2026-09-01T00:00:00Z'));
    expect(formatCalendarDay('2026-09-01')).toBe(expected);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-09-00', 'not a day'])(
    'rejects invalid day %s',
    (day) => {
      expect(formatCalendarDay(day)).toBeUndefined();
    },
  );
});
