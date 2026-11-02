import { type Day, parseDay } from './days';

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface RecurrenceRule {
  readonly frequency: Frequency;
  readonly interval: number;
  /** ISO weekdays (Monday 1) in stored order, empty when none were named. */
  readonly weekdays: readonly number[];
  readonly until: Day | null;
  readonly completedThrough: Day | null;
  readonly completed: readonly Day[];
}

const WEEKDAYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
const MAXIMUM_INTERVAL = 366;
const MAXIMUM_COMPLETED = 200;

export const isCompleted = (rule: RecurrenceRule, day: Day): boolean =>
  (rule.completedThrough !== null && day <= rule.completedThrough) || rule.completed.includes(day);

/** An optional day: absent or JSON null is fine, anything unparsable is not (undefined). */
function optionalDay(value: unknown): Day | null | undefined {
  if (value === undefined || value === null) return null;
  return parseDay(value) ?? undefined;
}

/** RecurrenceRuleJson.Read: the stored rule, or null when this build cannot read it. */
export function readRule(stored: unknown): RecurrenceRule | null {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null;
  const doc = stored as Record<string, unknown>;

  const frequency = doc.freq;
  if (
    frequency !== 'daily' &&
    frequency !== 'weekly' &&
    frequency !== 'monthly' &&
    frequency !== 'yearly'
  )
    return null;

  const interval = doc.interval;
  if (
    typeof interval !== 'number' ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > MAXIMUM_INTERVAL
  )
    return null;

  const weekdays: number[] = [];
  if (doc.weekdays !== undefined && doc.weekdays !== null) {
    if (!Array.isArray(doc.weekdays) || doc.weekdays.length === 0) return null;
    for (const entry of doc.weekdays as unknown[]) {
      const weekday = typeof entry === 'string' ? WEEKDAYS.indexOf(entry) + 1 : 0;
      if (weekday === 0 || weekdays.includes(weekday)) return null;
      weekdays.push(weekday);
    }
    // Weekdays on a non-weekly rule are refused, not ignored.
    if (frequency !== 'weekly') return null;
  }

  const until = optionalDay(doc.until);
  const completedThrough = optionalDay(doc.completedThrough);
  if (until === undefined || completedThrough === undefined) return null;

  let completed: Day[] = [];
  if (doc.completed !== undefined && doc.completed !== null) {
    if (!Array.isArray(doc.completed)) return null;
    const days = (doc.completed as unknown[]).map(parseDay);
    if (days.length > MAXIMUM_COMPLETED || days.some((day) => day === null)) return null;
    completed = days as Day[];
  }
  // Strictly ascending, and above the watermark.
  let previous = -Infinity;
  for (const day of completed) {
    if (day <= previous || (completedThrough !== null && day <= completedThrough)) return null;
    previous = day;
  }

  return { frequency, interval, weekdays, until, completedThrough, completed };
}
