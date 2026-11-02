import { dayNumber, dayText, localDay, validZone, weekday } from '../finance/dates';
import { type Dec, ZERO, must, decOf, num, sum } from '../finance/dec';
import type { ViewAnswer, ViewCompute } from '../types';

/** GET /items/{id}/habit?from&to, ported from HabitTracker.cs and Domain/Habits. */

const MAXIMUM_CHILDREN = 2000;
const MAXIMUM_QUANTITY: Dec = 1_000_000n * 10n ** 12n;
/** DateOnly.MinValue, day number 0. */
const NO_DAY = 0;

type Bag = Record<string, unknown>;
const isBag = (value: unknown): value is Bag =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Settings {
  frequency: string;
  weekdays: number[];
  timezone: string;
  startDate: number;
  target: Dec;
  unit: string;
  reminderTime: string | null;
}

const scheduled = (s: Settings, day: number): boolean =>
  day >= s.startDate && (s.frequency === 'daily' || s.weekdays.includes(weekday(day)));

function validSettings(s: Settings): boolean {
  if (s.frequency !== 'daily' && s.frequency !== 'weekly') return false;
  if (s.target <= ZERO || s.target > MAXIMUM_QUANTITY) return false;
  if (s.unit.trim() === '' || s.unit.length > 32) return false;
  if (s.timezone.trim() === '' || s.timezone.length > 128 || !validZone(s.timezone)) return false;
  if (
    s.weekdays.length > 7 ||
    s.weekdays.some((d) => d < 0 || d > 6) ||
    new Set(s.weekdays).size !== s.weekdays.length
  )
    return false;
  if ((s.frequency === 'daily') !== (s.weekdays.length === 0)) return false;
  return s.reminderTime === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(s.reminderTime);
}

/** HabitSettings.Read: the current settings in a bag, or null when absent or malformed. */
function readSettings(bag: Bag): Settings | null {
  const { $habit_frequency: frequency, $habit_timezone: timezone, $habit_unit: unit } = bag;
  const start = typeof bag.$habit_start_date === 'string' ? dayNumber(bag.$habit_start_date) : null;
  const target = decOf(bag.$habit_target);
  if (
    typeof frequency !== 'string' ||
    typeof timezone !== 'string' ||
    typeof unit !== 'string' ||
    start === null ||
    target === null
  )
    return null;
  const days = bag.$habit_weekdays ?? [];
  if (!Array.isArray(days) || !days.every((d) => Number.isInteger(d))) return null;
  const reminder = bag.$habit_reminder_time ?? null;
  if (reminder !== null && typeof reminder !== 'string') return null;
  const settings: Settings = {
    frequency,
    weekdays: days as number[],
    timezone,
    startDate: start,
    target,
    unit,
    reminderTime: reminder,
  };
  return validSettings(settings) ? settings : null;
}

interface History {
  settings: { from: number; settings: Settings }[];
  statuses: { from: number; status: string }[];
}

const MAXIMUM_VERSIONS = 512;
const STATUSES = ['active', 'paused', 'archived'];
const bySort = <T extends { from: number }>(list: T[]): T[] => list.sort((a, b) => a.from - b.from);

/** HabitHistory.Read: legacy settings as the first version; malformed history fails closed. */
function readHistory(bag: Bag): History | null {
  const current = readSettings(bag);
  if (current === null) return null;
  const settings: History['settings'] = [];
  const versions = bag.$habit_versions;
  if (Array.isArray(versions)) {
    if (versions.length > MAXIMUM_VERSIONS) return null;
    for (const entry of versions) {
      if (!isBag(entry)) return null;
      const value = isBag(entry.settings) ? readSettings(entry.settings) : null;
      const from = typeof entry.effectiveFrom === 'string' ? dayNumber(entry.effectiveFrom) : null;
      if (value === null || from === null) return null;
      settings.push({ from, settings: value });
    }
  } else if (versions !== undefined && versions !== null) return null;
  const effective = bag.$habit_effective_from;
  if (effective === undefined || effective === null)
    settings.push({ from: NO_DAY, settings: current });
  else {
    const from = typeof effective === 'string' ? dayNumber(effective) : null;
    if (from === null) return null;
    settings.push({ from, settings: current });
  }
  const statuses: History['statuses'] = [{ from: NO_DAY, status: 'active' }];
  const statusVersions = bag.$habit_status_versions;
  if (Array.isArray(statusVersions)) {
    if (statusVersions.length > MAXIMUM_VERSIONS) return null;
    for (const entry of statusVersions) {
      if (!isBag(entry)) return null;
      const from = typeof entry.effectiveFrom === 'string' ? dayNumber(entry.effectiveFrom) : null;
      if (typeof entry.status !== 'string' || !STATUSES.includes(entry.status) || from === null)
        return null;
      statuses.push({ from, status: entry.status });
    }
  } else if (statusVersions !== undefined && statusVersions !== null) return null;
  else if (bag.$habit_status !== undefined && bag.$habit_status !== null) {
    if (typeof bag.$habit_status !== 'string' || !STATUSES.includes(bag.$habit_status)) return null;
    statuses[0] = { from: NO_DAY, status: bag.$habit_status };
  }
  return { settings: bySort(settings), statuses: bySort(statuses) };
}

const settingsOn = (h: History, day: number): Settings =>
  (h.settings.findLast((e) => e.from <= day) ?? must(h.settings[0])).settings;
const statusOn = (h: History, day: number): string =>
  h.statuses.findLast((e) => e.from <= day)?.status ?? 'active';
const historyStart = (h: History): number =>
  Math.min(...h.settings.map((e) => e.settings.startDate));

interface CheckIn {
  id: string;
  day: number;
  completed: boolean;
  quantity: Dec | null;
}

/** HabitTracker.ReadCheckIn: null when the row is malformed. */
function readCheckIn(id: string, bag: Bag): CheckIn | null {
  const day =
    typeof bag.$habit_check_in_date === 'string' ? dayNumber(bag.$habit_check_in_date) : null;
  if (day === null || typeof bag.$habit_check_in_completed !== 'boolean') return null;
  let quantity: Dec | null = null;
  if (bag.$habit_check_in_quantity !== undefined && bag.$habit_check_in_quantity !== null) {
    quantity = decOf(bag.$habit_check_in_quantity);
    if (quantity === null || quantity < ZERO || quantity > MAXIMUM_QUANTITY) return null;
  }
  return { id, day, completed: bag.$habit_check_in_completed, quantity };
}

interface Occurrence {
  day: number;
  scheduled: boolean;
  state: string;
  target: Dec;
  unit: string;
  quantity: Dec | null;
  completed: boolean;
}

function occurrences(h: History, rows: CheckIn[], from: number, to: number, today: number) {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const result: Occurrence[] = [];
  for (let day = from; day <= to; day++) {
    const effective = settingsOn(h, day);
    const row = byDay.get(day);
    const isScheduled =
      row !== undefined || (scheduled(effective, day) && statusOn(h, day) === 'active');
    const state = !isScheduled
      ? 'unscheduled'
      : row?.completed === true
        ? 'completed'
        : (row?.quantity ?? ZERO) > ZERO
          ? 'partial'
          : day >= today
            ? 'scheduled'
            : 'missed';
    result.push({
      day,
      scheduled: isScheduled,
      state,
      target: effective.target,
      unit: effective.unit,
      quantity: row?.quantity ?? null,
      completed: row?.completed === true,
    });
  }
  return result;
}

const problem = (status: number, code: string, detail: string): ViewAnswer => ({
  status,
  code,
  detail,
});
const refuse = (code: string, detail: string) =>
  problem(
    ['habits.not_configured', 'habits.history_locked', 'habits.invalid_history'].includes(code)
      ? 409
      : 422,
    code,
    detail,
  );

function dateQuery(url: URL, name: string): number | null | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value === '') return undefined;
  return dayNumber(value);
}

export const computeHabit: ViewCompute = async (source, request, match) => {
  const parent = await source.item((match[1] ?? '').toLowerCase());
  if (parent?.lifecycleState !== 'active')
    return problem(404, 'items.not_found', 'No such habit is visible and accessible.');
  const bag = isBag(parent.properties) ? parent.properties : {};
  const settings = readSettings(bag);
  if (settings === null)
    return refuse(
      Object.hasOwn(bag, '$habit_frequency') ? 'habits.invalid_settings' : 'habits.not_configured',
      'This item has no valid habit settings.',
    );
  // Query values Core's model binding would refuse (a 400) are not guessed at offline.
  const askedTo = dateQuery(request.url, 'to');
  const askedFrom = dateQuery(request.url, 'from');
  if (askedTo === null || askedFrom === null) return null;
  const today = localDay(source.now(), settings.timezone);
  const end = askedTo ?? today;
  const start = askedFrom ?? Math.max(0, end - 27);
  if (end < start || end - start >= 366)
    return refuse('habits.invalid_range', 'Choose an ordered date range of no more than 366 days.');
  if (parent.locked) return null;
  const children = (await source.workspaceItems(parent.workspaceId)).filter(
    (item) => item.parentId === parent.id,
  );
  if (children.length > MAXIMUM_CHILDREN)
    return refuse(
      'habits.history_limit',
      'This first version supports at most 2,000 children per habit. Its totals cannot be calculated safely.',
    );
  const history = readHistory(bag);
  if (history === null)
    return refuse('habits.invalid_history', 'The saved habit history is malformed.');
  if (today - historyStart(history) > 36_600)
    return refuse(
      'habits.history_limit',
      'Habit statistics support a history of at most 100 years.',
    );

  const all: CheckIn[] = [];
  const seen = new Set<number>();
  for (const child of children) {
    const childBag = isBag(child.properties) ? child.properties : {};
    if (!Object.hasOwn(childBag, '$habit_check_in_date')) continue;
    const row = readCheckIn(child.id, childBag);
    if (row === null || seen.has(row.day))
      return refuse(
        'habits.invalid_history',
        "A check-in is malformed or duplicated. Review the habit's child items before using its totals.",
      );
    seen.add(row.day);
    all.push(row);
  }
  const rows = all
    .filter((row) => row.day >= start && row.day <= end)
    .sort((a, b) => a.day - b.day);
  const shown = occurrences(history, all, start, end, today);
  const lifetime = occurrences(history, all, historyStart(history), today, today);

  const weeks = new Map<number, Occurrence[]>();
  for (const o of shown) {
    const weekStart = Math.max(0, o.day - ((weekday(o.day) + 6) % 7));
    weeks.set(weekStart, [...(weeks.get(weekStart) ?? []), o]);
  }
  const months = new Map<string, Occurrence[]>();
  for (const o of shown) {
    const key = dayText(o.day).slice(0, 7);
    months.set(key, [...(months.get(key) ?? []), o]);
  }
  const quantity = (list: Occurrence[]) => sum(list, (o) => o.quantity ?? ZERO);
  const planned = shown.filter((o) => o.scheduled && (o.day < today || o.completed)).length;
  const completed = shown.filter((o) => o.scheduled && o.completed).length;
  let current = 0;
  let best = 0;
  for (const o of lifetime) {
    if (!o.scheduled || o.day > today || (o.day === today && !o.completed)) continue;
    current = o.completed ? current + 1 : 0;
    best = Math.max(best, current);
  }
  const statusText = bag.$habit_status;
  return {
    status: 200,
    body: {
      habitId: parent.id,
      frequency: settings.frequency,
      weekdays: settings.weekdays,
      timezone: settings.timezone,
      startDate: dayText(settings.startDate),
      target: num(settings.target),
      unit: settings.unit,
      checkIns: rows.map((row) => ({
        id: row.id,
        occurredOn: dayText(row.day),
        completed: row.completed,
        quantity: row.quantity === null ? null : num(row.quantity),
      })),
      weeks: [...weeks].map(([weekStart, list]) => ({
        weekStart: dayText(weekStart),
        planned: list.filter((o) => o.scheduled).length,
        completed: list.filter((o) => o.scheduled && o.completed).length,
        quantity: num(quantity(list)),
      })),
      status: statusText === 'paused' || statusText === 'archived' ? statusText : 'active',
      occurrences: shown.map((o) => ({
        date: dayText(o.day),
        scheduled: o.scheduled,
        state: o.state,
        target: num(o.target),
        unit: o.unit,
        quantity: o.quantity === null ? null : num(o.quantity),
        completed: o.completed,
      })),
      progress: {
        currentStreak: current,
        bestStreak: best,
        planned,
        completed,
        completionRate: planned === 0 ? 0 : completed / planned,
        quantity: num(quantity(shown)),
      },
      months: [...months]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([month, list]) => ({
          month,
          planned: list.filter((o) => o.scheduled).length,
          completed: list.filter((o) => o.scheduled && o.completed).length,
          quantity: num(quantity(list)),
        })),
      reminderTime: settings.reminderTime,
    },
  };
};
