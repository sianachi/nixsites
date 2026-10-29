import { describe, expect, it } from 'vitest';

import type { Item } from '@nix/web-collections/core/container-model';
import {
  buildWindow,
  columnOf,
  placeSpan,
  readScale,
  stepAnchor,
} from '../../../views/timeline/timeline-scale';
import { readDayValue } from '@nix/web-collections/core/day-math';

/**
 * The arithmetic a timeline is built from, tested without rendering one.
 *
 * The cases below are the ones a rendered assertion would prove by accident and say nothing about
 * when they break: a month boundary, a year boundary, a leap February, a quarter that opens
 * mid-week, and every way a span can miss or straddle the window. A grid can only be interrogated
 * by counting columns on screen; this can be asked directly.
 *
 * **The suite runs in `Pacific/Honolulu`, ten hours west of UTC**, for the same reason the calendar
 * suites do: a timestamp placed without being converted lands on the day it looks right on from
 * wherever it was written, and on the wrong one everywhere else.
 */

process.env.TZ = 'Pacific/Honolulu';

/** A Tuesday in the middle of March 2026. March opens on a Sunday, so the weeks straddle. */
const MARCH_17 = { year: 2026, month: 2, day: 17 };

describe('reading a scale', () => {
  it('defaults to a month when nothing has said otherwise', () => {
    expect(readScale(null)).toBe('month');
  });

  it('takes the three grains a timeline actually has', () => {
    expect(readScale('week')).toBe('week');
    expect(readScale('month')).toBe('month');
    expect(readScale('quarter')).toBe('quarter');
  });

  it('falls back for a calendar grain a timeline has no meaning for', () => {
    // A view switched from a calendar keeps its `mode`, and a calendar's `day` is a grain this view
    // deliberately does not offer - a one-day gantt is a list with one column. Falling back is what
    // makes the switch lossless in the direction that matters: the field survives, and switching
    // back to a calendar still finds `day` in it.
    expect(readScale('day')).toBe('month');
    expect(readScale('fortnight')).toBe('month');
    expect(readScale('')).toBe('month');
  });
});

describe('the window', () => {
  it('draws a week as seven day columns, Monday first', () => {
    const window = buildWindow('week', MARCH_17);

    expect(window.columns).toHaveLength(7);
    expect(window.fromText).toBe('2026-03-16');
    expect(window.toText).toBe('2026-03-22');
    expect(window.columns[0]?.label).toBe('Mon 16');
    expect(window.columns[0]?.name).toBe('Monday 16 March 2026');
  });

  it('draws a month as one column per day, however many the month has', () => {
    expect(buildWindow('month', MARCH_17).columns).toHaveLength(31);
    expect(buildWindow('month', { year: 2026, month: 1, day: 3 }).columns).toHaveLength(28);

    // The leap day is a column rather than a gap, which is the whole of what the month length is
    // read from `daysInMonth` for.
    const leap = buildWindow('month', { year: 2028, month: 1, day: 3 });
    expect(leap.columns).toHaveLength(29);
    expect(leap.toText).toBe('2028-02-29');
  });

  it('labels a month column with the day alone and names it with the whole date', () => {
    // Compressed on screen, complete in the accessible tree. A column announced as "3" leaves
    // somebody using a screen reader with no idea which month they are in.
    const window = buildWindow('month', MARCH_17);

    expect(window.columns[2]?.label).toBe('3');
    expect(window.columns[2]?.name).toBe('Tuesday 3 March 2026');
  });

  it('opens a quarter on the Monday of the week its first day falls in', () => {
    // The first of January 2026 is a Thursday, so the quarter's first column starts in December.
    // Cutting the column to start on the 1st would make one column four days wide and every
    // comparison down the row a lie about width.
    const window = buildWindow('quarter', { year: 2026, month: 1, day: 10 });

    expect(window.fromText).toBe('2025-12-29');
    expect(window.label).toBe('January to March 2026');
  });

  it('gives a quarter as many week columns as it takes to cover it', () => {
    // Thirteen or fourteen depending on the weekday it opens on. A fixed thirteen leaves the last
    // few days of about a quarter of all quarters with nowhere to sit.
    const firstQuarter = buildWindow('quarter', { year: 2026, month: 1, day: 10 });
    expect(firstQuarter.columns).toHaveLength(14);
    expect(firstQuarter.toText).toBe('2026-04-05');

    // The rarer case, and the one a hard-coded thirteen would be right about: the 1st of April 2024
    // was itself a Monday, so the quarter's ninety-one days are exactly thirteen whole weeks with
    // nothing hanging off either end.
    const wholeWeeks = buildWindow('quarter', { year: 2024, month: 4, day: 10 });
    expect(wholeWeeks.columns).toHaveLength(13);
    expect(wholeWeeks.fromText).toBe('2024-04-01');
    expect(wholeWeeks.toText).toBe('2024-06-30');
    expect(wholeWeeks.label).toBe('April to June 2024');
  });
});

describe('stepping the window', () => {
  it('moves a week by seven days, across a month boundary', () => {
    expect(stepAnchor('week', { year: 2026, month: 2, day: 30 }, 1)).toEqual({
      year: 2026,
      month: 3,
      day: 6,
    });
  });

  it('moves a month by a month and a quarter by three', () => {
    expect(stepAnchor('month', MARCH_17, 1)).toEqual({ year: 2026, month: 3, day: 17 });
    expect(stepAnchor('quarter', MARCH_17, 1)).toEqual({ year: 2026, month: 5, day: 17 });
    expect(stepAnchor('quarter', MARCH_17, -1)).toEqual({ year: 2025, month: 11, day: 17 });
  });

  it('clamps a day that the month it lands in does not have', () => {
    // The 31st of January stepped forward is not the 31st of February. Left unclamped it would roll
    // into March and the window would skip a month without anybody touching a control.
    expect(stepAnchor('month', { year: 2026, month: 0, day: 31 }, 1)).toEqual({
      year: 2026,
      month: 1,
      day: 28,
    });
  });
});

describe('placing a span', () => {
  const month = buildWindow('month', MARCH_17);

  it('says an item with no start is undated rather than placing it somewhere', () => {
    expect(placeSpan(month, null, null).kind).toBe('undated');

    // Even with an end. An item with only an end date has no position, because the start is what
    // puts a bar on the axis - the whole reason the start is the view's one requirement.
    expect(placeSpan(month, null, '2026-03-20').kind).toBe('undated');
  });

  it('places a start with no end as a milestone on its own day', () => {
    expect(placeSpan(month, '2026-03-03', null)).toEqual({ kind: 'milestone', column: 2 });
  });

  it('reports an end before its start rather than swapping the two', () => {
    // Swapping would silently correct a data error somebody may need to see, and clamping would
    // draw a bar whose dates are not the item's.
    expect(placeSpan(month, '2026-03-20', '2026-03-04').kind).toBe('reversed');

    // Reported as reversed wherever it falls, including entirely off the window - otherwise
    // somebody goes paging through months looking for an item whose dates are the actual problem.
    expect(placeSpan(month, '2025-09-20', '2025-09-04').kind).toBe('reversed');
  });

  it('treats a start and an end on the same day as a one-column bar rather than as reversed', () => {
    expect(placeSpan(month, '2026-03-03', '2026-03-03')).toEqual({
      kind: 'span',
      first: 2,
      last: 2,
      continuesBefore: false,
      continuesAfter: false,
    });
  });

  it('spans the columns between its two ends', () => {
    expect(placeSpan(month, '2026-03-03', '2026-03-06')).toEqual({
      kind: 'span',
      first: 2,
      last: 5,
      continuesBefore: false,
      continuesAfter: false,
    });
  });

  it('clips a bar that runs past either edge and says which edge it ran past', () => {
    expect(placeSpan(month, '2026-02-20', '2026-03-06')).toEqual({
      kind: 'span',
      first: 0,
      last: 5,
      continuesBefore: true,
      continuesAfter: false,
    });

    expect(placeSpan(month, '2026-03-28', '2026-04-14')).toEqual({
      kind: 'span',
      first: 27,
      last: 30,
      continuesBefore: false,
      continuesAfter: true,
    });

    // Straddling the whole window: every column is covered and neither drawn end is a date.
    expect(placeSpan(month, '2025-12-01', '2026-06-01')).toEqual({
      kind: 'span',
      first: 0,
      last: 30,
      continuesBefore: true,
      continuesAfter: true,
    });
  });

  it('reports a span that misses the window entirely rather than clamping it to an edge', () => {
    expect(placeSpan(month, '2026-01-03', '2026-01-06').kind).toBe('outside');
    expect(placeSpan(month, '2026-04-03', '2026-04-06').kind).toBe('outside');
    expect(placeSpan(month, '2026-04-03', null).kind).toBe('outside');
  });

  it('puts a day into the week column that contains it', () => {
    const quarter = buildWindow('quarter', { year: 2026, month: 1, day: 10 });

    // The first column is the week of the 29th of December, so the 5th of January is in the second.
    expect(columnOf(quarter, '2025-12-31')).toBe(0);
    expect(columnOf(quarter, '2026-01-05')).toBe(1);
    expect(columnOf(quarter, '2025-12-28')).toBeNull();
  });
});

describe('reading the day an item names', () => {
  function itemOf(properties: Record<string, unknown>): Item {
    return {
      id: 'i1',
      workspaceId: 'a1000000-0000-4000-8000-000000000001',
      parentId: 'c1000000-0000-4000-8000-000000000001',
      type: 'note',
      title: 'Rollout',
      hasChildren: false,
      seq: 1000,
      lifecycleState: 'active',
      properties,
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
    };
  }

  it('uses a date exactly as it is stored', () => {
    expect(readDayValue(itemOf({ starts: '2026-03-17' }), 'starts', 'Pacific/Honolulu')).toBe(
      '2026-03-17',
    );
  });

  it('converts a timestamp to the day it falls on for the reader', () => {
    // 09:00 in London on Tuesday the 17th is 23:00 on Monday the 16th in Honolulu. A bar placed
    // without converting starts a day late for this reader and looks right from London.
    const standup = itemOf({ starts: '2026-03-17T09:00:00+00:00[Europe/London]' });

    expect(readDayValue(standup, 'starts', 'Pacific/Honolulu')).toBe('2026-03-16');
    expect(readDayValue(standup, 'starts', 'Europe/London')).toBe('2026-03-17');
  });

  it('reads nothing at all from a value that is neither', () => {
    expect(readDayValue(itemOf({ starts: 'next Tuesday' }), 'starts', 'UTC')).toBeNull();
    expect(readDayValue(itemOf({}), 'starts', 'UTC')).toBeNull();
  });
});
