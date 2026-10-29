import { dayFromText, dayLabel } from '@nix/web-collections/core/calendar-dates';
import type { Placed } from './timeline-model';
import { titleOf } from './timeline-model';

/** How a stored date reads in a sentence, or the raw value when it is not a date at all. */
export function spoken(date: string): string {
  const day = dayFromText(date);
  return day === null ? date : dayLabel(day);
}

/**
 * What this item's start is, mid-sentence.
 *
 * Three outcomes, not two: a date, nothing at all, and a value that is not a date. The third used
 * to be spoken as the second, which told somebody their item had no start when what it had was a
 * start nobody could read - and sent them looking for data that was sitting right there.
 */
function startPhrase(placed: Placed): string {
  if (placed.start !== null) {
    return `starts ${spoken(placed.start)}`;
  }

  return placed.startRaw.length === 0
    ? 'no start date'
    : `a start stored as "${placed.startRaw}", which is not a date`;
}

function endPhrase(placed: Placed): string {
  if (placed.end !== null) {
    return `ends ${spoken(placed.end)}`;
  }

  return placed.endRaw.length === 0
    ? 'no end date'
    : `an end stored as "${placed.endRaw}", which is not a date`;
}

/**
 * What an item's control is called: its title, then the dates it actually holds.
 *
 * One sentence for every placement, so an item announces the same facts whether it is drawn on the
 * axis, listed as reversed, listed as outside the window, or listed as unreadable.
 */
export function announce(placed: Placed): string {
  const title = titleOf(placed.item);

  // Both readable: the ordinary bar, and the contradiction.
  if (placed.start !== null && placed.end !== null) {
    return placed.end < placed.start
      ? `${title}, starts ${spoken(placed.start)} and ends ${spoken(placed.end)}, which is before it starts`
      : `${title}, ${spoken(placed.start)} to ${spoken(placed.end)}`;
  }

  // An item holding nothing in either property says so once rather than twice.
  if (placed.startRaw.length === 0 && placed.endRaw.length === 0) {
    return `${title}, no start date`;
  }

  return `${title}, ${startPhrase(placed)}, ${endPhrase(placed)}`;
}

/** The dates as a line of text under a title. */
export function describeDates(placed: Placed): string {
  if (placed.startRaw.length === 0 && placed.endRaw.length === 0) {
    return 'No start date and no end date.';
  }

  return `${sentence(startPhrase(placed))}. ${sentence(endPhrase(placed))}.`;
}

function sentence(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
