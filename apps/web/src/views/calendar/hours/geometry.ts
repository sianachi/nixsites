import type { Item } from '../../../collections/core/container-model';

/**
 * The height of one hour, in pixels, and **the one place in the app that still sets `style`**.
 *
 * The grid is a coordinate space rather than a rhythm, which is what makes it the exception to the
 * ban in `app.css`. An item at 09:30 sits at `9.5 * ROW_HEIGHT` down the column - a number that
 * exists only once its timestamp has been read and converted into the reader's zone, so it is
 * computed at render. Expressing that as a class would need one utility per reachable offset, 1440
 * of them at minute resolution, and Tailwind's extractor cannot see a class name assembled from a
 * variable anyway - so the sheet would ship none of them. Rounding to a coarser set would place
 * items at times they are not at, which is the one thing a calendar must not do.
 *
 * It is 56px - twice `MIN_SPAN_HEIGHT_PX` below - so that half an hour is exactly the shortest box
 * a span is ever drawn as. At the 44px it used to be, anything under about thirty-eight minutes was
 * drawn the same height, so a half-hour item and a three-quarter-hour one could not be told apart
 * and stretching an item below that did nothing a reader could see. Now thirty minutes and every
 * quarter hour above it is drawn at its true length. It is used in arithmetic rather than applied
 * as a length, so it is written as the scalar the arithmetic needs.
 *
 * The row heights below could be classes; they are not, because they have to agree with the offsets
 * exactly. The same number said twice, once in a class and once in arithmetic, is how a grid drifts
 * an hour at a time.
 *
 * Exported so a test that needs a pixel offset computes it from this number rather than restating
 * it by hand - a second copy of `44` in a test file is the same drift risk one step removed.
 */
export const ROW_HEIGHT = 56;

/**
 * `ROW_HEIGHT`'s own arithmetic, named for what it converts rather than repeated inline at every
 * call site - the offset, the full-day height and a span's own height are all "some number of
 * minutes, at this grid's scale".
 */
export function minutesToPx(minutes: number): number {
  return (minutes / 60) * ROW_HEIGHT;
}

/** The rows. A full day, so a 23:00 item is reachable by scrolling rather than absent. */
export const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/**
 * The shortest a timed span is ever drawn, regardless of its real duration.
 *
 * `minutesToPx` alone puts a span under thirty minutes at less than `--control-sm` (28px) tall, and `overflow: hidden` on that box - needed so a short span's two lines of text
 * cannot bleed into the row below it, see the span's own comment - clipped its Reschedule button
 * along with them, shrinking its hit area under the 24px floor WCAG 2.5.8 sets. Clamping the
 * height rather than lifting the clip keeps the box's top exactly where the item starts; only the
 * bottom ever moves, and only when the real duration would have drawn a box too short to hold its
 * own control.
 *
 * The number is `--control-sm` restated as a scalar for the same reason `ROW_HEIGHT` is: it is
 * used in a `Math.max` against a runtime pixel value, not applied as a Tailwind length.
 */
export const MIN_SPAN_HEIGHT_PX = 28;

/**
 * The time the shortest box covers on the grid: thirty minutes at this scale.
 *
 * A quarter-hour item is drawn this tall, which is longer than it lasts. The overlap sweep uses
 * this rather than the real duration for such an item, so the one below it is laned beside it
 * instead of being drawn underneath a box that reaches further than its own end.
 */
export const MIN_SPAN_MINUTES = (MIN_SPAN_HEIGHT_PX / ROW_HEIGHT) * 60;

/**
 * One day column's floor width, shared by the header cell, the all-day band's cell and the hour
 * grid's own column - the same "the gutter's width has to match the one below it" requirement the
 * hour gutter already had, extended to every column rather than just the leftmost one.
 *
 * `min-w-0 flex-1` used to let seven columns divide up whatever width the viewport offered with no
 * floor, which on a phone is around 47px each: too narrow for the event card below to show a title
 * next to its time, and the column kept shrinking instead of the grid ever scrolling.
 *
 * 7rem (112px) is sized off what the card actually draws, not guessed: the event button sits
 * `inset-x-1` inside the column (4px a side) and pads itself `px-1.5` (6px a side), which leaves
 * about 92px of text at `text-xs` - comfortably one truncated title on its own line and a short time
 * like "09:00" on the one below, the two lines the card usually renders (a cross-zone entry's time
 * span carries its own `truncate` too, for the rarer third line a zone name can add). Below that a
 * title stops being a title and starts being an ellipsis before the second word. `sm:min-w-[9rem]`
 * widens it a touch once there is room, the way timeline-view.tsx's `LABEL_COLUMN` widens its own
 * floor at the same breakpoint.
 *
 * `[contain:inline-size]` stops a different failure than the floor above: without it, a browser
 * computing this row's max-content width (needed once the row has to overflow rather than shrink)
 * looks *through* a `flex-1` column at its children's own natural width - so one long all-day title
 * anywhere in the week inflates that column's contribution to hundreds of pixels, and flexbox's
 * max-content algorithm then multiplies that single widest column's width across every other
 * `flex-1` sibling, blowing the whole row out past 2000px. `contain: inline-size` tells the browser
 * this element's own intrinsic size is whatever its explicit `min-width`/`flex-basis` says, full
 * stop - it does not go looking at what is drawn inside. Verified in both week (7 columns) and day
 * (1 column) mode: a long all-day title no longer moves the row's width at all.
 */
export const DAY_COLUMN = 'min-w-[7rem] sm:min-w-[9rem] flex-1 [contain:inline-size]';

/**
 * The hour gutter's own footprint, in whichever of the three rows it appears: the header's blank
 * spacer, the all-day band's "All day" label, and the hour column's row of clock times.
 *
 * `sticky left-0`, matching timeline-view.tsx's `LABEL_COLUMN` - once the grid scrolls horizontally
 * to reach a later day, a reader still needs to see which hour a row is without scrolling back.
 * `bg-surface` is load-bearing rather than decorative: without it, a day column's tinted event card
 * would show straight through the gutter as it slides underneath a sticky element with no fill of
 * its own. `border-r` is its own edge rather than a coincidence: without one, the gutter's right
 * boundary only ever looked bordered because a day column's own `border-l` happened to line up
 * behind it at a zero scroll offset - scroll even a pixel and the gutter has no edge of its own at
 * all.
 */
export const HOUR_GUTTER = 'sticky left-0 z-10 w-12 shrink-0 border-r border-divider bg-surface';

/** Minutes in a full day, for clamping a span that runs past midnight. */
export const MINUTES_PER_DAY = 24 * 60;

/** How far a pressed pointer travels before a press on a card becomes a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 4;

export interface Placed {
  readonly item: Item;

  /** Minutes since midnight, in the reader's zone. Where on the column it sits. */
  readonly minutes: number;

  /** What the clock reads, in the reader's zone. */
  readonly at: string;

  /** The zone the item was written in, which the card names only when it differs. */
  readonly zone: string;

  /**
   * How long the entry runs for, in minutes, clamped to the rest of this day - or null for a
   * point.
   *
   * Null covers three cases that all draw the same way an item with no end always has: the view
   * has no `endDateProperty` configured, the item has no value for it, or the value is not after
   * the start (an end before its start is the reversed span timeline-view.tsx also refuses to
   * draw as a bar, rather than as one with a length that would run backwards). An end that lands
   * on a later day is clamped to midnight rather than drawn past it - this grid is one day tall,
   * and a bar continuing into tomorrow's column belongs to a multi-day rendering this grid does
   * not attempt.
   */
  readonly durationMinutes: number | null;
}

/**
 * A placed item being dragged or stretched, as it would land if the pointer were released now.
 *
 * **This is the pointer's own way to do what the reschedule dialog does**, never the only way: a
 * start and an end are both written from that dialog by keyboard and by touch. What the gesture
 * adds is doing it by eye, in fifteen-minute steps, on the grid itself.
 */
export interface SpanGesture {
  readonly itemId: string;
  readonly kind: 'move' | 'resize';

  /** The column the item would land in. A resize never leaves its own. */
  readonly dayIndex: number;

  /** Where it would start, in minutes since midnight in the reader's zone. */
  readonly minutes: number;

  /** How long it would run, or null for a point that is only being moved. */
  readonly durationMinutes: number | null;
}
