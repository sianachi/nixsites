/**
 * Every calendar in a workspace, collated into one window of dated entries.
 *
 * Three properties of the payload are worth knowing before writing a view against it, because all
 * three are guarantees rather than accidents.
 *
 * **A date is a date wherever it was set.** Which property carries an item's date is decided by the
 * container that holds it, so entries in one response may have been placed by differently named
 * properties. Each entry carries the key it was placed by and the container that decided it, which
 * is what lets a view show them together without claiming one of them was wrong.
 *
 * **Values are not normalised.** A `date` is a day and a `timestamp` is a moment in a named zone,
 * and only the reader's own zone decides which day a moment falls on. The server windows coarsely
 * by the day the value is written with; the client places precisely. An entry near a window edge
 * can therefore belong to a different day for the reader than for the window, which is correct
 * rather than a rounding error.
 *
 * **The response is bounded, and it says so twice, for two different reasons.** `entriesTruncated`
 * means the window holds more concrete entries than came back. `seriesTruncated` means more
 * repeating series exist than this read considered, or than there was room left to expand after
 * concrete entries were read — a different fact, since a workspace can hold more series than this
 * response even names. `unplaceable` names containers that offer a calendar and could place
 * nothing, and repeating items whose series could not be drawn on this calendar — that list is
 * never truncated, because it is the part of the answer that explains what is missing. A truncated
 * list looks short and announces itself; a truncated calendar looks like a calendar, so a view that
 * renders this must say so.
 *
 * **A generated entry is not a stored one.** An entry produced by a recurrence rule rather than
 * read from storage carries `generated: true` and its own `completed` state; a view must not offer
 * to edit or delete it as if it were a row in storage, since there is no row behind it, only the
 * series that produced it. A stored entry's `completed` is always null — it has no completion state
 * of its own to report.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

/** Which of the two dated property types placed an entry. */
const calendarEntryKindSchema = z.enum(['date', 'timestamp']);

export type CalendarEntryKind = z.infer<typeof calendarEntryKindSchema>;

/** One dated item, and where its date came from. */
const calendarEntrySchema = z.object({
  itemId: z.uuid(),

  /**
   * What the item is called, or null when it has never been named. The server does not invent a
   * name, so a view that wants one supplies its own copy.
   */
  title: z.string().nullable(),

  /** The container whose calendar view placed it. */
  containerId: z.uuid(),

  /** What that container is called, so an entry can say where it came from without a second read. */
  containerTitle: z.string().nullable(),

  /** The property key this entry was placed by. Different containers may name different ones. */
  dateProperty: z.string(),

  /**
   * The stored value, verbatim: either a plain `yyyy-MM-dd` day or an RFC 9557 moment with a
   * bracketed zone. Parsed by the reader, in the reader's zone.
   */
  value: z.string(),

  kind: calendarEntryKindSchema,

  /** True when this entry was produced by a recurrence rule rather than read from storage. */
  generated: z.boolean(),

  /**
   * Whether this occurrence is complete. Null for a stored (non-generated) entry, which has no
   * completion state of its own to report.
   */
  completed: z.boolean().nullable(),

  /**
   * The property this entry's calendar ends a span by, or null when that calendar has none.
   * Present whether or not the item has a value for it. Defaulted, so a server from before the
   * field still parses and its entries are simply points.
   */
  endProperty: z.string().nullable().default(null),

  /** The item's raw value for `endProperty`, in the same shape as `value`, or null. */
  endValue: z.string().nullable().default(null),
});

export type CalendarEntry = z.infer<typeof calendarEntrySchema>;

/**
 * A container that offers a calendar and could place nothing on it, or a repeating item whose
 * series could not be drawn.
 *
 * The reason is a token rather than a sentence, because the sentence belongs where it can be
 * translated. The known values are `no_date_property` (the container names no date property),
 * `calendar_not_by_due_date` (the container's calendar does not place by a due date, so a
 * repeating item's series has nowhere to go), `no_due_date` (the item itself has no due date to
 * anchor the series to), and `unreadable_rule` (the stored rule could not be read). `itemId` and
 * `itemTitle` are set only for the series reasons - a container-level reason names no single item.
 */
const unplaceableCalendarSchema = z.object({
  containerId: z.uuid(),
  containerTitle: z.string().nullable(),
  reason: z.string(),
  itemId: z.uuid().nullable(),
  itemTitle: z.string().nullable(),
});

export type UnplaceableCalendar = z.infer<typeof unplaceableCalendarSchema>;

/**
 * A ceiling the server applied, echoed back.
 *
 * `number | string` for the reason `itemSequenceSchema` is: the contract publishes integers as
 * either, and the schema accepts what the contract permits rather than what we expect to see.
 */
const calendarLimitSchema = z.union([z.int(), z.string().regex(/^-?\d+$/)]);

export const workspaceCalendarSchema = z.object({
  workspaceId: z.uuid(),

  /** The window that was asked for, echoed so a late response can be matched to its request. */
  from: z.string(),
  to: z.string(),

  entries: z.array(calendarEntrySchema),
  unplaceable: z.array(unplaceableCalendarSchema),

  entryLimit: calendarLimitSchema,

  /** True when the ceiling was reached, so this is part of the window and not all of it. */
  entriesTruncated: z.boolean(),

  /**
   * True when more repeating series exist than this read considered, or than there was room left
   * to expand after concrete entries were read. Distinct from `entriesTruncated`: a workspace can
   * hold more series than this response even names.
   */
  seriesTruncated: z.boolean(),
});

export type WorkspaceCalendar = z.infer<typeof workspaceCalendarSchema>;

/**
 * The compile-time tie to the generated contract. A field Core renames stops this package
 * compiling rather than failing at runtime in front of a user.
 */
const _workspaceCalendarContract = workspaceCalendarSchema satisfies z.ZodType<
  components['schemas']['WorkspaceCalendarResponse']
>;
void _workspaceCalendarContract;
