/**
 * What the caller should do today in one workspace.
 *
 * Nothing here is stored: every row names an original item, and its `action` names the existing
 * command that finishes it. An action is a hint, not a permission grant; the command still checks.
 *
 * **Coverage is part of the answer.** A section is `partial` when a ceiling was reached or an item
 * could not be judged, and `omitted` is null when the count cannot be known. Zero rows with a
 * partial coverage is not an empty day, so a view must read `coverage` before claiming either.
 *
 * **Two days.** `taskDay` is the caller's current day. A habit's own `occurrence.date` is its local
 * day in its saved zone and can differ from it; check-ins and undo use that date unchanged.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';
import { habitOccurrenceSchema } from './habits.js';

/** Why a section may be missing rows. */
const myDayCoverageCodeSchema = z.enum([
  'candidate_limit',
  'row_limit',
  'invalid_schema',
  'invalid_properties',
  'invalid_recurrence',
  'habit_locked',
  'invalid_habit',
  'habit_history_limit',
]);

export type MyDayCoverageCode = z.infer<typeof myDayCoverageCodeSchema>;

const coverageSchema = z.object({
  kind: z.enum(['complete', 'partial']),
  reasons: z.array(z.object({ code: myDayCoverageCodeSchema, omitted: z.int().nullable() })),
});

const limitsSchema = z.object({ candidates: z.int(), rows: z.int() });

const rowSource = {
  itemId: z.uuid(),
  containerId: z.uuid().nullable(),
  /** The parent's title: the row's source label. */
  containerTitle: z.string().nullable(),
  title: z.string(),
};

/**
 * `property` sets `key` to true on the item. `occurrence` completes the series' occurrence on
 * `occurredOn`; there is no occurrence undo.
 */
const myDayTaskActionSchema = z.object({
  kind: z.enum(['property', 'occurrence']),
  key: z.string().nullable(),
  occurredOn: z.iso.date().nullable(),
});

const myDayTaskRowSchema = z.object({
  ...rowSource,
  section: z.enum(['today', 'overdue', 'assigned']),
  dueDay: z.iso.date().nullable(),
  startDay: z.iso.date().nullable(),
  priority: z.int().nullable(),
  estimate: z.number().nullable(),
  action: myDayTaskActionSchema,
});

const myDayHabitRowSchema = z.object({
  ...rowSource,
  /** The habit's saved zone, which decided `occurrence.date`. */
  timezone: z.string(),
  occurrence: habitOccurrenceSchema,
});

export const myDaySchema = z.object({
  workspaceId: z.uuid(),
  evaluatedAt: z.iso.datetime({ offset: true }),
  taskDay: z.iso.date(),
  taskTimezone: z.string(),
  tasks: z.object({
    rows: z.array(myDayTaskRowSchema),
    coverage: coverageSchema,
    limits: limitsSchema,
  }),
  habits: z.object({
    rows: z.array(myDayHabitRowSchema),
    coverage: coverageSchema,
    limits: limitsSchema,
  }),
});

export type MyDay = z.infer<typeof myDaySchema>;
export type MyDayTaskRow = z.infer<typeof myDayTaskRowSchema>;
export type MyDayHabitRow = z.infer<typeof myDayHabitRowSchema>;

/** A field Core renames stops this package compiling rather than failing in front of a user. */
const _myDayContract = myDaySchema satisfies z.ZodType<components['schemas']['MyDayResponse']>;
void _myDayContract;
