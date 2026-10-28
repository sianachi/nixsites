/**
 * The arithmetic of dragging a placed item on the hour grid: where a pointer is in minutes, and
 * what a move or a resize makes of it.
 *
 * Kept apart from the grid so the snapping is one rule in one place. Everything here is in
 * minutes since midnight in the reader's zone, which is what the grid is drawn in.
 */

/** The step a dragged start or end lands on. */
const SNAP_MINUTES = 15;

const MINUTES_PER_DAY = 24 * 60;

function snap(minutes: number): number {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES;
}

/**
 * Where a moved item starts: the pointer's minute less where on the item it was grabbed, snapped,
 * and kept inside the day so the item cannot be dropped off either end of the column.
 */
export function movedStart(pointerMinutes: number, grabOffsetMinutes: number): number {
  return Math.min(
    Math.max(snap(pointerMinutes - grabOffsetMinutes), 0),
    MINUTES_PER_DAY - SNAP_MINUTES,
  );
}

/**
 * A duration as a reader says it: "15m", "1h", "1h 30m".
 *
 * Shown beside the times while an item is being stretched, because "09:00 - 10:30" makes the
 * reader do the subtraction and the length is the thing they are setting.
 */
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) {
    return `${String(rest)}m`;
  }
  return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`;
}

/**
 * How long a resized item runs: from its start to the pointer's minute, snapped, never shorter
 * than one step and never past midnight - the column is one day tall.
 */
export function resizedDuration(startMinutes: number, pointerMinutes: number): number {
  return Math.min(
    Math.max(snap(pointerMinutes) - startMinutes, SNAP_MINUTES),
    MINUTES_PER_DAY - startMinutes,
  );
}
