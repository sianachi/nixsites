import type { CalendarEntry, WorkspaceCalendar } from '@nix/api-client';

import type { Item } from '@nix/web-collections/core/container-model';

/**
 * Turning collated entries into something the shared grids can draw.
 *
 * **One property key for every entry, invented here.** Both grids take a single `dateProperty` and
 * read it off each item, because a container has exactly one. The collated calendar does not: its
 * entries were placed by whatever their own container names, and the dev workspace alone uses four
 * different keys. Rewriting each entry onto one synthetic key is what lets the grids stay untouched
 * - the alternative was widening them to resolve a key per item, which would put the container
 * calendar's whole suite in the blast radius for a view it does not have.
 *
 * The key is not a real property and is never written back. It exists between this module and the
 * grid, for one render.
 *
 * Nothing here reads a clock or a zone; it is a rewrite of values that already exist.
 */

/**
 * The key the grids read.
 *
 * Prefixed and unlikely to collide with a real property, because it shares a namespace with them
 * inside the synthetic item below. A container that genuinely declared a property called
 * `nix:collated-date` would be shadowed, which is a trade worth making for a key nobody can type
 * into the schema editor by accident.
 */
export const COLLATED_DATE_KEY = 'nix:collated-date';

/**
 * The date property a daily note is placed by. A daily note's date is its identity - the note is
 * that day's - so unlike an ordinary entry it is never moved to another day from the calendar.
 */
const DAILY_DATE_PROPERTY = '$daily';

export function isDailyNote(entry: CalendarEntry): boolean {
  return entry.dateProperty === DAILY_DATE_PROPERTY;
}

/**
 * One entry as the grids expect an item.
 *
 * **A view model wearing `Item`'s shape.** The grids read exactly
 * three things off an item - `id`, `properties.title`, and `properties[dateProperty]` - and the
 * calendar response carries all three. It does not carry a workspace identifier, a sequence, or
 * the timestamps `Item` also declares, and inventing them would put facts on screen this response
 * never returned. So the unread fields are filled with the empty value of their type.
 *
 * If a grid ever starts reading a fourth field, this is where it will be wrong, and it will be
 * wrong quietly - which is why the three are named here rather than left to be rediscovered.
 *
 * No cast is needed: `Item`'s identifier and timestamp fields are typed as plain strings, since Zod
 * infers `string` from `z.uuid()` and `z.iso.datetime()`. The compiler will not catch a placeholder
 * here, which is precisely why the placeholders are named above.
 */
/**
 * The one key every entry's end is rewritten onto, for the same reason the start is: the hour grid
 * takes one end property, and these entries end by whatever their own containers name.
 */
export const COLLATED_END_KEY = 'nix:collated-end';

export function toGridItem(entry: CalendarEntry): Item {
  return {
    id: entry.itemId,
    workspaceId: '',
    type: 'note',
    title: entry.title ?? '',
    parentId: entry.containerId,
    hasChildren: false,
    seq: 0,
    lifecycleState: 'active',
    properties: {
      title: entry.title ?? '',
      [COLLATED_DATE_KEY]: entry.value,
      ...(entry.endValue === null ? {} : { [COLLATED_END_KEY]: entry.endValue }),
    },
    createdAt: '',
    updatedAt: '',
  };
}

/** Every entry, as grid items, in the order the server sent them. */
export function toGridItems(entries: readonly CalendarEntry[]): readonly Item[] {
  return entries.map(toGridItem);
}

/**
 * The entries of one day, bucketed by the day their value names.
 *
 * **The day is the value's own first ten characters, not a conversion.** A `date` is already a day.
 * A `timestamp` is a moment in a named zone, and converting it into the reader's zone here would be
 * right for the hour grid and wrong for the month grid, which places by the day the value was
 * written with. The hour grid does its own conversion when it lays a moment on an hour, which is
 * the only place the reader's zone actually decides anything.
 *
 * **The entries themselves, not `toGridItem`'s view model.** The month cell needs `generated` and
 * `completed` to tell a repeating occurrence from a stored entry - facts `Item`'s shape has nowhere
 * to carry - so this keeps the entry whole; `toGridItem` remains what the hour grid and the
 * reschedule dialog read, both of which take one `dateProperty` off an `Item` and neither of which
 * draws a "Repeats" marker or a "Mark done" control.
 */
export function bucketByDay(
  entries: readonly CalendarEntry[],
): ReadonlyMap<string, CalendarEntry[]> {
  const byDay = new Map<string, CalendarEntry[]>();

  for (const entry of entries) {
    const day = entry.value.slice(0, 10);
    const bucket = byDay.get(day);

    if (bucket === undefined) {
      byDay.set(day, [entry]);
      continue;
    }

    bucket.push(entry);
  }

  return byDay;
}

/**
 * How many entries the response could not place, counted rather than listed.
 *
 * A value that does not begin with a day is one this build cannot put anywhere - the server windows
 * on those ten characters, so it should not arrive, and if it does the honest thing is to say a
 * number rather than silently draw a shorter month.
 */
export function unplaceableEntryCount(calendar: WorkspaceCalendar): number {
  return calendar.entries.filter((entry) => !/^\d{4}-\d{2}-\d{2}/.test(entry.value)).length;
}

/**
 * The notes the address is filtering to.
 *
 * **Empty means everything, not nothing.** The calendar is workspace-wide by default and the filter
 * narrows it, so an absent parameter and an empty one both mean "no narrowing" - the alternative
 * would make a shared link with a stale parameter render a blank calendar that looks like a quiet
 * workspace.
 *
 * Identifiers this build does not recognise are kept rather than dropped. They match nothing, which
 * is the honest result of asking for a note that is not in this window, and dropping them would
 * silently rewrite somebody's link.
 */
export function parseNotes(raw: string | null): ReadonlySet<string> {
  if (raw === null || raw.length === 0) {
    return new Set();
  }

  return new Set(raw.split(',').filter((id) => id.length > 0));
}

/** How the selection is written into the address, in a stable order so a link does not churn. */
export function notesParam(notes: ReadonlySet<string>): string {
  return [...notes].sort((left, right) => left.localeCompare(right)).join(',');
}

/**
 * The entries a selection admits.
 *
 * Filtered here rather than at the server, because the window's entries are already in hand and
 * bounded - a refetch per checkbox would be a round trip to remove rows this build is holding.
 */
export function filterByNotes(
  entries: readonly CalendarEntry[],
  notes: ReadonlySet<string>,
): readonly CalendarEntry[] {
  return notes.size === 0 ? entries : entries.filter((entry) => notes.has(entry.containerId));
}

/**
 * The notes that could be filtered to, drawn from the entries themselves.
 *
 * **Offered from the payload rather than from the workspace tree.** A picker listing every note in
 * the workspace would be mostly notes with nothing on this calendar, and choosing one would appear
 * to do nothing. These are exactly the notes that placed something in the window.
 *
 * **A second caller besides the filter: `CreateEntryButton`'s destinations.** Every note here has,
 * by construction, a calendar view and a real date property - an entry could not exist otherwise -
 * so this doubles as "notes it is safe to create into" without a second read. What it cannot offer
 * is a note with a calendar view and nothing placed on it yet in this window; there is no
 * workspace-wide read this build can ask for that list without a bulk read of every container's own
 * views, which is out of reach for now.
 */
export function noteOptions(
  entries: readonly CalendarEntry[],
): readonly { readonly id: string; readonly title: string }[] {
  const byId = new Map<string, string>();

  for (const entry of entries) {
    byId.set(entry.containerId, entry.containerTitle ?? 'Untitled');
  }

  return [...byId]
    .map(([id, title]) => ({ id, title }))
    .sort((left, right) => left.title.localeCompare(right.title));
}
