import {
  addDays,
  dayFromText,
  dayText,
  daysInMonth,
  startOfWeek,
  weekOf,
  type CalendarDay,
} from '../collections/core/calendar-dates';

/**
 * Which days a grain needs fetched, and how the address names where the reader is.
 *
 * Its own module because it is arithmetic with edges, and arithmetic with edges is where off-by-one
 * lives. Keeping it out of the component means the window can be tested without rendering a grid,
 * and the component holds a day and a grain.
 *
 * Nothing here reads a clock. The anchor is given.
 */

/** The three grains a calendar is read at. */
export type CalendarGrain = 'month' | 'week' | 'day';

const GRAINS: readonly CalendarGrain[] = ['month', 'week', 'day'];

/**
 * The grain the address names, or the default.
 *
 * Fails soft, matching `calendar-view.tsx`'s own `readMode`: a token from a newer build reads as a
 * month rather than as an error, because an unfamiliar grain is not a reason to refuse to draw
 * anything.
 */
export function grainOf(raw: string | null): CalendarGrain {
  return GRAINS.find((grain) => grain === raw) ?? 'month';
}

/**
 * Where in time the address puts the reader, or today.
 *
 * The anchor is in the URL here, unlike the container calendar, where the month on screen is
 * deliberately left out as "a scroll position through time". A destination is different: it has no
 * item to return to, so a link to it with no anchor is a link to whenever the recipient opens it -
 * and "look at this week" is exactly the thing somebody would want to send.
 */
export function anchorOf(raw: string | null, today: CalendarDay): CalendarDay {
  return raw === null ? today : (dayFromText(raw) ?? today);
}

/** How the anchor is written into the address. */
export function anchorText(anchor: CalendarDay): string {
  return dayText(anchor);
}

/**
 * The window a grain needs.
 *
 * **Wider than what is drawn, on purpose, in the month case.** A month grid shows the days either
 * end that belong to the neighbouring months, and a window of exactly the month would leave those
 * cells empty - which reads as "nothing is scheduled" rather than "not fetched". A week of padding
 * on each side covers every lead and trail the grid can produce.
 *
 * The day grain still fetches a day either side. A moment stored in a distant zone can belong to
 * the reader's day while being written with the neighbouring one, and the server windows on the
 * written day - so the extra day is what stops such an entry vanishing at the edge.
 */
export function windowFor(
  grain: CalendarGrain,
  anchor: CalendarDay,
): { readonly from: string; readonly to: string } {
  if (grain === 'month') {
    const first: CalendarDay = { year: anchor.year, month: anchor.month, day: 1 };
    const last: CalendarDay = {
      year: anchor.year,
      month: anchor.month,
      day: daysInMonth({ year: anchor.year, month: anchor.month }),
    };

    return { from: dayText(addDays(first, -7)), to: dayText(addDays(last, 7)) };
  }

  if (grain === 'week') {
    const week = weekOf(anchor);
    const first = week[0] ?? startOfWeek(anchor);
    const last = week[week.length - 1] ?? anchor;

    return { from: dayText(addDays(first, -1)), to: dayText(addDays(last, 1)) };
  }

  return { from: dayText(addDays(anchor, -1)), to: dayText(addDays(anchor, 1)) };
}
