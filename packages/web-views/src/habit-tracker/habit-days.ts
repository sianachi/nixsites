import type { HabitTracker } from '@nix/api-client';
import { formatShortDate } from '@nix/web-foundation/lib/date-format';

export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
export function dateText(day: Date): string {
  return `${String(day.getFullYear())}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

export function todayInTimezone(timezone: string): string {
  return formatShortDate(new Date(), timezone);
}

export function shiftedDay(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

export function weekdayFor(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

export function weekWindow(offset = 0): { from: string; to: string; days: readonly string[] } {
  const now = new Date();
  const monday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - ((now.getDay() + 6) % 7) + offset * 7,
  );
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + index);
    return dateText(day);
  });
  return { from: days[0] ?? dateText(monday), to: days[6] ?? dateText(monday), days };
}

const spokenDay = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

/** A stored `yyyy-mm-dd` day as a person says it - "Tuesday 20 October" - for screen readers. */
export function spokenDayName(day: string): string {
  return spokenDay.format(new Date(`${day}T00:00:00Z`));
}

/** Whether the habit is due on `day`, from the server's occurrence when it has one. */
export function habitScheduled(tracker: HabitTracker, day: string): boolean {
  const occurrence = tracker.occurrences?.find((entry) => entry.date === day);
  return (
    occurrence?.scheduled ??
    (day >= tracker.startDate &&
      (tracker.frequency === 'daily' || tracker.weekdays.includes(weekdayFor(day))))
  );
}

export function habitDone(tracker: HabitTracker, day: string): boolean {
  const occurrence = tracker.occurrences?.find((entry) => entry.date === day);
  return (
    occurrence?.completed ??
    tracker.checkIns.some((entry) => entry.occurredOn === day && entry.completed)
  );
}

/** Which week (0 = this one) holds `day`, so the loaded range follows day navigation. */
export function weekOffsetFor(day: string): number {
  const monday = weekWindow(0).from;
  const days = Math.round(
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / 86_400_000,
  );
  return Math.floor(days / 7);
}
