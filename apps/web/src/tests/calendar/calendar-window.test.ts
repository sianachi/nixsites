import { describe, expect, it } from 'vitest';

import { anchorOf, anchorText, grainOf, windowFor } from '../../calendar/calendar-window';
import type { CalendarDay } from '../../collections/core/calendar-dates';

/**
 * The window is arithmetic with edges, so it is tested as arithmetic - no DOM, no render.
 *
 * The edges are the whole point. A window of exactly the month leaves the grid's lead and trail
 * cells empty, and an empty cell reads as "nothing is scheduled" rather than "not fetched".
 */

const TODAY: CalendarDay = { year: 2026, month: 2, day: 17 };

describe('reading the grain from the address', () => {
  it('takes a grain the address names', () => {
    expect(grainOf('week')).toBe('week');
    expect(grainOf('day')).toBe('day');
    expect(grainOf('month')).toBe('month');
  });

  it('falls back to a month when the address says nothing', () => {
    expect(grainOf(null)).toBe('month');
  });

  /**
   * Fails soft rather than throwing, matching the container calendar's own `readMode`: a token from
   * a newer build should draw a month, not refuse to draw anything.
   */
  it('falls back to a month for a grain this build does not know', () => {
    expect(grainOf('fortnight')).toBe('month');
  });
});

describe('reading the anchor from the address', () => {
  it('takes a date the address names', () => {
    expect(anchorOf('2026-07-04', TODAY)).toEqual({ year: 2026, month: 6, day: 4 });
  });

  it('falls back to today when the address says nothing', () => {
    expect(anchorOf(null, TODAY)).toEqual(TODAY);
  });

  it('falls back to today rather than throwing on a date that does not exist', () => {
    expect(anchorOf('2026-02-31', TODAY)).toEqual(TODAY);
    expect(anchorOf('not-a-date', TODAY)).toEqual(TODAY);
  });

  it('round-trips through the address', () => {
    expect(anchorOf(anchorText(TODAY), { year: 2000, month: 0, day: 1 })).toEqual(TODAY);
  });
});

describe('choosing the window a grain needs', () => {
  /**
   * The reason the month window is padded. A month grid draws the days either end that belong to
   * the neighbouring months, and those cells are real - an item on the 30th of the previous month
   * is visible in this month's first row.
   */
  it('fetches past both ends of a month, because the grid draws past both ends', () => {
    const window = windowFor('month', { year: 2026, month: 2, day: 17 });

    expect(window.from < '2026-03-01').toBe(true);
    expect(window.to > '2026-03-31').toBe(true);
  });

  it('covers every day a month grid can show', () => {
    // February 2026 starts on a Sunday, which is the worst case for lead cells in a Monday-first
    // grid: six of them.
    const window = windowFor('month', { year: 2026, month: 1, day: 1 });

    expect(window.from <= '2026-01-26').toBe(true);
  });

  it('fetches a day either side of a week', () => {
    const window = windowFor('week', { year: 2026, month: 2, day: 17 });

    // The week of Tuesday 17 March 2026 is Monday the 16th to Sunday the 22nd.
    expect(window.from).toBe('2026-03-15');
    expect(window.to).toBe('2026-03-23');
  });

  /**
   * A moment stored in a distant zone can belong to the reader's day while being written with the
   * neighbouring one, and the server windows on the written day - so a day grain that fetched
   * exactly its day would lose such an entry at the edge.
   */
  it('fetches a day either side of a day', () => {
    const window = windowFor('day', { year: 2026, month: 2, day: 17 });

    expect(window.from).toBe('2026-03-16');
    expect(window.to).toBe('2026-03-18');
  });

  it('crosses a year boundary without going backwards', () => {
    const window = windowFor('month', { year: 2026, month: 0, day: 1 });

    expect(window.from).toBe('2025-12-25');
    expect(window.from < window.to).toBe(true);
  });

  it('never asks for a window that ends before it begins', () => {
    for (const grain of ['month', 'week', 'day'] as const) {
      for (const day of [1, 15, 28]) {
        const window = windowFor(grain, { year: 2026, month: 1, day });
        expect(window.from < window.to).toBe(true);
      }
    }
  });

  /**
   * The server refuses a window wider than 400 days. Nothing here should come close, but a padded
   * month is the widest this builds and it is worth pinning that it stays inside the bound.
   */
  it('stays well inside the width the server will accept', () => {
    const window = windowFor('month', { year: 2026, month: 0, day: 1 });

    const from = Date.parse(`${window.from}T00:00:00Z`);
    const to = Date.parse(`${window.to}T00:00:00Z`);
    const days = (to - from) / 86_400_000;

    expect(days).toBeLessThan(60);
  });
});
