/**
 * The earliest stretch of free time long enough for something, inside the hours it may go in.
 *
 * Plain interval arithmetic over epoch milliseconds. Which hours count as working hours, in which
 * zone, and which items count as busy are the caller's knowledge - a calendar view knows its
 * reader's zone and what it has loaded - so they arrive here already turned into spans, and this
 * module stays free of clocks, zones and items.
 *
 * Busy spans may overlap, touch, or sit outside every window; a slot may start exactly when a busy
 * span ends and end exactly when the next begins, because a meeting from 10:00 to 11:00 does not
 * occupy 11:00.
 */

/** A half-open span of time, `[start, end)`, in epoch milliseconds. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * The first `duration`-long span inside one of `windows`, starting no earlier than `notBefore`,
 * that overlaps none of `busy` - or null when no window has room.
 *
 * Windows are searched in time order whatever order they arrive in. A non-positive duration has no
 * meaningful slot and answers null.
 */
export function nextFreeSlot(
  windows: readonly Span[],
  busy: readonly Span[],
  duration: number,
  notBefore: number,
): Span | null {
  if (duration <= 0) {
    return null;
  }

  const blocked = busy
    .filter((span) => span.end > span.start)
    .slice()
    .sort((a, b) => a.start - b.start);

  for (const window of [...windows].sort((a, b) => a.start - b.start)) {
    let cursor = Math.max(window.start, notBefore);

    for (const span of blocked) {
      if (cursor + duration <= window.end && span.start >= cursor + duration) {
        // The next busy span starts after a slot would already have ended: everything later is
        // later still, since the list is sorted.
        break;
      }
      if (span.end > cursor && span.start < cursor + duration) {
        cursor = Math.max(cursor, span.end);
      }
    }

    if (cursor + duration <= window.end) {
      return { start: cursor, end: cursor + duration };
    }
  }

  return null;
}
