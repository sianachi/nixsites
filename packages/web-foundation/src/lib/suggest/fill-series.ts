/**
 * What comes next in a column, from the cells somebody already filled in.
 *
 * The spreadsheet incumbents' fill handle, reduced to the patterns people actually type into a
 * column of items and can predict for themselves:
 *
 * - **numbers** in an arithmetic progression - `10, 20` continues `30, 40`, keeping as many decimal
 *   places as the seed shows, so `1.5, 2.0` continues `2.5`, not `2.5000000001`;
 * - **dates** written `yyyy-MM-dd` a constant number of days or weeks apart, or a constant number
 *   of months apart on the same day of the month - `2026-01-31, 2026-02-28` is monthly on the 31st,
 *   and continues `2026-03-31`, clamping to a short month's last day rather than spilling into the
 *   next one, which is what "the last day of every month" means to the person who typed it;
 * - **text with one incrementing number** anywhere in it - `Week 1, Week 2` continues `Week 3`,
 *   `Sprint 09 review, Sprint 10 review` continues `Sprint 11 review`, and `Q1 2026, Q2 2026`
 *   continues `Q3 2026` because only one number varies and the year is held still;
 * - and otherwise, **the last value repeated**, which is the fill everybody already expects.
 *
 * **One varying number, exactly.** Text where two numbers change at once (`1/1, 2/3`) is not a
 * pattern anybody would bet on, so it falls back to repeating rather than guessing a rule. A
 * series of two seeds is accepted - two points are the least that define a step, and the person
 * sees the continuation before anything is written - but every additional seed must agree with the
 * step, so three seeds that disagree are not a series.
 *
 * Pure, and free of `Date`'s local-zone behaviour: day arithmetic runs on UTC calendar days, so a
 * fill crossing a daylight-saving change cannot skip or repeat a date.
 */

export type SeriesKind = 'number' | 'date' | 'text' | 'repeat';

export interface SeriesContinuation {
  /** Which pattern was recognised; `repeat` is the fallback, not a pattern. */
  readonly kind: SeriesKind;

  /** The next `count` values, in order. */
  readonly values: readonly string[];

  /**
   * The step in words, for the sentence offering the fill: "+10", "every 7 days", "monthly",
   * "repeating". Never shown as the value itself.
   */
  readonly describe: string;
}

const NUMBER = /^-?\d+(\.\d+)?$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function decimalsOf(text: string): number {
  const point = text.indexOf('.');
  return point === -1 ? 0 : text.length - point - 1;
}

/** Whether every consecutive difference of `values` equals `step`, at `decimals` precision. */
function constantStep(values: readonly number[], step: number, decimals: number): boolean {
  const scale = 10 ** decimals;
  for (let index = 1; index < values.length; index += 1) {
    const current = values[index] ?? 0;
    const previous = values[index - 1] ?? 0;
    if (Math.round((current - previous) * scale) !== Math.round(step * scale)) {
      return false;
    }
  }
  return true;
}

function numberSeries(seed: readonly string[], count: number): SeriesContinuation | null {
  if (!seed.every((text) => NUMBER.test(text))) {
    return null;
  }
  const values = seed.map(Number);
  const decimals = Math.max(...seed.map(decimalsOf));
  const first = values[0] ?? 0;
  const second = values[1] ?? 0;
  const step = second - first;
  if (step === 0 || !constantStep(values, step, decimals)) {
    return null;
  }
  const last = values[values.length - 1] ?? 0;
  const next = Array.from({ length: count }, (_, index) =>
    (last + step * (index + 1)).toFixed(decimals),
  );
  const stepText = step.toFixed(decimals);
  return { kind: 'number', values: next, describe: step > 0 ? `+${stepText}` : stepText };
}

interface CalendarDay {
  readonly year: number;
  readonly month: number; // 1 to 12
  readonly day: number;
}

function parseDay(text: string): CalendarDay | null {
  const parts = DAY.exec(text);
  if (parts === null) {
    return null;
  }
  const day = { year: Number(parts[1]), month: Number(parts[2]), day: Number(parts[3]) };
  const probe = new Date(Date.UTC(day.year, day.month - 1, day.day));
  // Refuses 2026-02-30 rather than letting Date roll it into March.
  return probe.getUTCFullYear() === day.year &&
    probe.getUTCMonth() === day.month - 1 &&
    probe.getUTCDate() === day.day
    ? day
    : null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDay(day: CalendarDay): string {
  return `${String(day.year).padStart(4, '0')}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
}

function serialDay(day: CalendarDay): number {
  return Math.round(Date.UTC(day.year, day.month - 1, day.day) / DAY_MS);
}

function fromSerial(serial: number): CalendarDay {
  const date = new Date(serial * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** The month `offset` months after `year`/`month`, on `anchor` or the month's last day. */
function monthAfter(year: number, month: number, offset: number, anchor: number): CalendarDay {
  const index = year * 12 + (month - 1) + offset;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  return {
    year: nextYear,
    month: nextMonth,
    day: Math.min(anchor, daysInMonth(nextYear, nextMonth)),
  };
}

function dateSeries(seed: readonly string[], count: number): SeriesContinuation | null {
  const days = seed.map(parseDay);
  if (days.some((day) => day === null)) {
    return null;
  }
  const parsed = days as CalendarDay[];
  const first = parsed[0];
  const last = parsed[parsed.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }

  // Monthly first: month lengths differ, so a monthly series never has a constant day step and
  // would otherwise be refused outright. The anchor is the first seed's day, so a series begun on
  // the 31st keeps returning to the 31st in the months that have one.
  const monthIndexes = parsed.map((day) => day.year * 12 + day.month);
  const monthStep = (monthIndexes[1] ?? 0) - (monthIndexes[0] ?? 0);
  const anchor = first.day;
  const monthly =
    monthStep !== 0 &&
    constantStep(monthIndexes, monthStep, 0) &&
    parsed.every((day) => day.day === Math.min(anchor, daysInMonth(day.year, day.month)));
  if (monthly) {
    const values = Array.from({ length: count }, (_, index) =>
      formatDay(monthAfter(last.year, last.month, monthStep * (index + 1), anchor)),
    );
    const every = Math.abs(monthStep);
    return {
      kind: 'date',
      values,
      describe: every === 1 ? 'monthly' : `every ${String(every)} months`,
    };
  }

  const serials = parsed.map(serialDay);
  const step = (serials[1] ?? 0) - (serials[0] ?? 0);
  if (step === 0 || !constantStep(serials, step, 0)) {
    return null;
  }
  const lastSerial = serials[serials.length - 1] ?? 0;
  const values = Array.from({ length: count }, (_, index) =>
    formatDay(fromSerial(lastSerial + step * (index + 1))),
  );
  const every = Math.abs(step);
  const describe =
    every % 7 === 0
      ? every === 7
        ? 'weekly'
        : `every ${String(every / 7)} weeks`
      : every === 1
        ? 'daily'
        : `every ${String(every)} days`;
  return { kind: 'date', values, describe };
}

function textSeries(seed: readonly string[], count: number): SeriesContinuation | null {
  // Split keeping the digit runs: odd indexes are numbers, even indexes the text between them.
  const split = seed.map((text) => text.split(/(\d+)/));
  const shape = split[0];
  if (shape === undefined || shape.length < 2) {
    return null;
  }
  if (split.some((parts) => parts.length !== shape.length)) {
    return null;
  }

  let varying = -1;
  for (let index = 0; index < shape.length; index += 1) {
    const same = split.every((parts) => parts[index] === shape[index]);
    if (same) {
      continue;
    }
    // Text between the numbers must match exactly; only a number may vary, and only one.
    if (index % 2 === 0 || varying !== -1) {
      return null;
    }
    varying = index;
  }
  if (varying === -1) {
    return null;
  }

  const runs = split.map((parts) => parts[varying] ?? '');
  const numbers = runs.map(Number);
  const step = (numbers[1] ?? 0) - (numbers[0] ?? 0);
  if (step === 0 || !constantStep(numbers, step, 0)) {
    return null;
  }

  // Zero padding is kept when the seed shows it ("Sprint 09"), so the fill sorts with the seed.
  const padded = runs.some((run) => run.length > 1 && run.startsWith('0'));
  const width = padded ? Math.max(...runs.map((run) => run.length)) : 0;
  const last = numbers[numbers.length - 1] ?? 0;
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = last + step * (index + 1);
    if (next < 0) {
      // A count down past zero would need a minus sign the seed never had; stop the pattern there.
      return null;
    }
    const parts = [...shape];
    parts[varying] = String(next).padStart(width, '0');
    values.push(parts.join(''));
  }
  return { kind: 'text', values, describe: step > 0 ? `+${String(step)}` : String(step) };
}

/**
 * The next `count` values after `seed`, by the first pattern that fits, or the last value repeated.
 *
 * `seed` is the filled cells in order, already trimmed of blanks by the caller; fewer than one
 * seed is nothing to continue and answers null. A single seed can only repeat.
 */
export function continueSeries(seed: readonly string[], count: number): SeriesContinuation | null {
  const values = seed.map((text) => text.trim());
  if (values.length === 0 || count <= 0 || values.some((text) => text.length === 0)) {
    return null;
  }

  if (values.length >= 2) {
    const series =
      numberSeries(values, count) ?? dateSeries(values, count) ?? textSeries(values, count);
    if (series !== null) {
      return series;
    }
  }

  const last = values[values.length - 1] ?? '';
  return {
    kind: 'repeat',
    values: Array.from({ length: count }, () => last),
    describe: 'repeating',
  };
}
