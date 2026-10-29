import { describe, expect, it } from 'vitest';

import {
  addDays,
  dayFromText,
  dayLabel,
  dayText,
  daysInMonth,
  isLeapYear,
  shiftMonth,
  startOfWeek,
  weekLabel,
  weekOf,
  weekdayIndex,
  withinRange,
} from '../../../collections/core/calendar-dates';

/**
 * The arithmetic a calendar is built from.
 *
 * Tested here directly rather than through the grid. The month view's leap-year behaviour is
 * currently asserted by clicking "next month" twenty-three times, which proves the same thing and
 * says nothing about where it broke when it breaks.
 *
 * Every case below is one a `Date` would have got wrong, or one where an off-by-one hides: a month
 * boundary, a year boundary, February in a leap year, February in a century that is not one.
 */

describe('leap years', () => {
  it('follows the whole rule, not the divisible-by-four half of it', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);

    // 1900 was not a leap year and 2000 was. A calendar that only checks the four gets one of these
    // wrong, and nobody notices for seventy-five years.
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it('gives February its extra day only when it has one', () => {
    expect(daysInMonth({ year: 2028, month: 1 })).toBe(29);
    expect(daysInMonth({ year: 2026, month: 1 })).toBe(28);
    expect(daysInMonth({ year: 1900, month: 1 })).toBe(28);
  });
});

describe('moving by days', () => {
  it('stays inside a month when it can', () => {
    expect(addDays({ year: 2026, month: 2, day: 17 }, 3)).toEqual({
      year: 2026,
      month: 2,
      day: 20,
    });
  });

  it('crosses into the next month', () => {
    // March has 31 days, so the 30th plus three is the 2nd of April.
    expect(addDays({ year: 2026, month: 2, day: 30 }, 3)).toEqual({
      year: 2026,
      month: 3,
      day: 2,
    });
  });

  it('crosses backwards into the previous month', () => {
    expect(addDays({ year: 2026, month: 2, day: 2 }, -3)).toEqual({
      year: 2026,
      month: 1,
      day: 27,
    });
  });

  it('crosses a year in both directions', () => {
    expect(addDays({ year: 2026, month: 11, day: 30 }, 3)).toEqual({
      year: 2027,
      month: 0,
      day: 2,
    });

    expect(addDays({ year: 2026, month: 0, day: 2 }, -3)).toEqual({
      year: 2025,
      month: 11,
      day: 30,
    });
  });

  it('walks through a leap February rather than over it', () => {
    // The 27th of February 2028 plus three days is the 1st of March, because the 29th exists.
    expect(addDays({ year: 2028, month: 1, day: 27 }, 3)).toEqual({
      year: 2028,
      month: 2,
      day: 1,
    });

    // The same sum in a year without one lands a day later in March.
    expect(addDays({ year: 2026, month: 1, day: 27 }, 3)).toEqual({
      year: 2026,
      month: 2,
      day: 2,
    });
  });

  it('crosses several months at once', () => {
    expect(addDays({ year: 2026, month: 0, day: 15 }, 100)).toEqual({
      year: 2026,
      month: 3,
      day: 25,
    });
  });

  it('moves nowhere when asked to move nothing', () => {
    const day = { year: 2026, month: 2, day: 17 };
    expect(addDays(day, 0)).toEqual(day);
  });

  it('undoes itself', () => {
    // The property that matters most, checked across the boundaries where it would fail.
    for (const start of [
      { year: 2026, month: 0, day: 1 },
      { year: 2028, month: 1, day: 29 },
      { year: 2026, month: 11, day: 31 },
    ]) {
      for (const delta of [1, 7, 31, 365]) {
        expect(addDays(addDays(start, delta), -delta)).toEqual(start);
      }
    }
  });
});

describe('weeks', () => {
  it('starts on the Monday', () => {
    // 17 March 2026 is a Tuesday, so its week starts on the 16th.
    expect(weekdayIndex(2026, 2, 17)).toBe(1);
    expect(startOfWeek({ year: 2026, month: 2, day: 17 })).toEqual({
      year: 2026,
      month: 2,
      day: 16,
    });
  });

  it('leaves a Monday where it is', () => {
    const monday = { year: 2026, month: 2, day: 16 };
    expect(startOfWeek(monday)).toEqual(monday);
  });

  it('runs seven consecutive days', () => {
    const week = weekOf({ year: 2026, month: 2, day: 17 });

    expect(week).toHaveLength(7);
    expect(week.map(dayText)).toEqual([
      '2026-03-16',
      '2026-03-17',
      '2026-03-18',
      '2026-03-19',
      '2026-03-20',
      '2026-03-21',
      '2026-03-22',
    ]);
  });

  it('spans a month boundary without a gap', () => {
    // The month grid pads these days with nulls, because they belong to another month. A week has
    // to show them as the real days they are.
    const week = weekOf({ year: 2026, month: 2, day: 31 });

    expect(week.map(dayText)).toEqual([
      '2026-03-30',
      '2026-03-31',
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
      '2026-04-04',
      '2026-04-05',
    ]);
  });

  it('spans a year boundary without a gap', () => {
    const week = weekOf({ year: 2026, month: 11, day: 31 });

    expect(week.map(dayText)).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
  });
});

describe('what a heading says', () => {
  it('names one month when the week is inside one', () => {
    expect(weekLabel({ year: 2026, month: 2, day: 17 })).toBe('16 to 22 March 2026');
  });

  it('names both months when the week straddles them', () => {
    // A week labelled only by its Monday is a week whose other end is a guess.
    expect(weekLabel({ year: 2026, month: 2, day: 31 })).toBe('30 March to 5 April 2026');
  });

  it('names both years when the week straddles them', () => {
    expect(weekLabel({ year: 2026, month: 11, day: 31 })).toBe(
      '28 December 2026 to 3 January 2027',
    );
  });

  it('names the weekday on a day heading', () => {
    expect(dayLabel({ year: 2026, month: 2, day: 17 })).toBe('Tuesday 17 March 2026');
  });
});

describe('whether a date is on screen', () => {
  it('includes both ends', () => {
    const from = { year: 2026, month: 2, day: 16 };
    const to = { year: 2026, month: 2, day: 22 };

    expect(withinRange('2026-03-16', from, to)).toBe(true);
    expect(withinRange('2026-03-22', from, to)).toBe(true);
    expect(withinRange('2026-03-15', from, to)).toBe(false);
    expect(withinRange('2026-03-23', from, to)).toBe(false);
  });

  it('works across a month boundary, which a prefix cannot', () => {
    // The month grid asks whether a date starts with `2026-03-`. A week spanning two months has no
    // single prefix to ask about, which is why the range test exists.
    const from = { year: 2026, month: 2, day: 30 };
    const to = { year: 2026, month: 3, day: 5 };

    expect(withinRange('2026-03-31', from, to)).toBe(true);
    expect(withinRange('2026-04-01', from, to)).toBe(true);
    expect(withinRange('2026-04-06', from, to)).toBe(false);
  });
});

describe('moving by months', () => {
  it('crosses a year in both directions', () => {
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
  });
});

describe('reading a stored date back', () => {
  it('is the exact inverse of writing one', () => {
    const day = { year: 2026, month: 2, day: 17 };

    expect(dayFromText(dayText(day))).toEqual(day);

    // The stored month is 1-12 and every month here is 0-11, which is the off-by-one this function
    // exists to keep in one place.
    expect(dayFromText('2026-01-01')).toEqual({ year: 2026, month: 0, day: 1 });
    expect(dayFromText('2026-12-31')).toEqual({ year: 2026, month: 11, day: 31 });
  });

  it('refuses a day the calendar does not have', () => {
    // Well-formed and impossible. Left to `monthEntry` it would throw several frames away, with a
    // message about a table index rather than about a value somebody stored.
    expect(dayFromText('2026-02-29')).toBeNull();
    expect(dayFromText('2026-13-01')).toBeNull();
    expect(dayFromText('2026-00-10')).toBeNull();

    // And the leap day that does exist.
    expect(dayFromText('2028-02-29')).toEqual({ year: 2028, month: 1, day: 29 });
  });

  it('refuses anything that is not a complete date', () => {
    expect(dayFromText('next Tuesday')).toBeNull();
    expect(dayFromText('2026-03')).toBeNull();
    expect(dayFromText('2026-03-17T09:00:00Z')).toBeNull();
    expect(dayFromText('')).toBeNull();
  });
});
