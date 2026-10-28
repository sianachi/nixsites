/**
 * A recurrence rule on an item, and the two writes that replace, clear, and complete it.
 *
 * The wire shape is intentionally thin: a rule is a frequency, an interval, an optional weekday
 * set, an optional end date, and the completion state Core has recorded against it. The closed set
 * of frequencies and weekdays is validated here so a typo fails at the CLI prompt rather than as an
 * opaque 422 from Core; which combinations Core actually accepts for a given frequency (weekdays
 * only make sense on `weekly`, for instance) stays Core's own judgment, the same way `views set`
 * leaves a view's shape to its 422.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

/** The closed set of frequencies a recurrence rule may repeat on. */
const recurrenceFreqSchema = z.enum(['daily', 'weekly', 'monthly', 'yearly']);

export type RecurrenceFreq = z.infer<typeof recurrenceFreqSchema>;

/** The closed set of weekday tokens a weekly rule may name. */
const recurrenceWeekdaySchema = z.enum(['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su']);

export type RecurrenceWeekday = z.infer<typeof recurrenceWeekdaySchema>;

/**
 * The contract publishes `interval` as int32, which the generated types admit as number or string;
 * this schema accepts what the contract permits rather than what we expect to see.
 */
const recurrenceIntervalSchema = z.union([z.int(), z.string().regex(/^-?\d+$/)]);

/** A recurrence rule as Core stores and returns it. */
const recurrenceRuleSchema = z.object({
  freq: recurrenceFreqSchema,
  interval: recurrenceIntervalSchema,
  weekdays: z.array(recurrenceWeekdaySchema),

  /** The last day a repeating item is due, inclusive, or null for a rule with no end. */
  until: z.string().nullable(),

  /** The watermark: every occurrence through this day is complete. Null before the first completion. */
  completedThrough: z.string().nullable(),

  /** Individual days completed ahead of the watermark, kept only while the rule still lands on them. */
  completed: z.array(z.string()),
});

/** What `PUT /items/{id}/recurrence` returns: the rule as it now stands, or null when cleared. */
export const setRecurrenceResultSchema = z.object({
  rule: recurrenceRuleSchema.nullable(),
});

export type SetRecurrenceResult = z.infer<typeof setRecurrenceResultSchema>;

/** What `POST /items/{id}/recurrence/completions` returns: the rule, and the day just completed. */
export const completeOccurrenceResultSchema = z.object({
  rule: recurrenceRuleSchema.nullable(),
  occurredOn: z.string(),
});

export type CompleteOccurrenceResult = z.infer<typeof completeOccurrenceResultSchema>;

/**
 * The compile-time tie to the generated contract. A field Core renames stops this package
 * compiling rather than failing at runtime in front of a user.
 */
const _setRecurrenceContract = setRecurrenceResultSchema satisfies z.ZodType<
  components['schemas']['SetRecurrenceResponse']
>;
void _setRecurrenceContract;

const _completeOccurrenceContract = completeOccurrenceResultSchema satisfies z.ZodType<
  components['schemas']['CompleteOccurrenceResponse']
>;
void _completeOccurrenceContract;
