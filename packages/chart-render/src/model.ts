import type { ChartInput, ChartSeriesInput } from './types.js';

/**
 * The pure arithmetic and vocabulary behind every chart type: what a bucket measures, what a period
 * or a value is called, the derived lines, and how a series is told apart from its neighbours.
 *
 * Nothing here draws, and nothing here knows a locale's defaults or the app's words for "unset":
 * the caller supplies labels and a day formatter, so the web app and a published site agree on
 * every figure while each says it in its own context.
 */

/** Every chart type this build draws. Core's `ChartKinds` is the authority on the words. */
export const CHART_KINDS = ['bar', 'column', 'pie', 'line', 'area', 'year'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

/** The types that need an ordered, dated axis: Core refuses them without a period. */
export const TIME_AXIS_KINDS: ReadonlySet<ChartKind> = new Set(['line', 'area', 'year']);

export const CHART_KIND_LABELS: Record<ChartKind, string> = {
  bar: 'Bars',
  column: 'Columns',
  pie: 'Pie',
  line: 'Line',
  area: 'Area',
  year: 'Year grid',
};

/** Every period a time axis can count by, in the order an editor offers them. */
export const CHART_PERIODS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type ChartPeriod = (typeof CHART_PERIODS)[number];

export const CHART_PERIOD_LABELS: Record<ChartPeriod, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  quarter: 'Quarter',
  year: 'Year',
};

/** The most periods a time axis draws (Core's `ChartOptions.MaximumPeriods`): one year grid of days. */
export const MAXIMUM_CHART_PERIODS = 371;

/** The most series drawn by name (Core's `ChartFolding.MaximumSeries`); the rest share Other. */
export const MAXIMUM_SERIES = 6;

/** How many periods the trailing average spans. */
export const AVERAGE_SPAN = 7;

/** A type this build draws, or bars for one it does not know - what an older build owes a newer view. */
export function chartKindOf(value: string | null | undefined): ChartKind {
  return (CHART_KINDS as readonly string[]).includes(value ?? '') ? (value as ChartKind) : 'bar';
}

export function isChartPeriod(value: string | null | undefined): value is ChartPeriod {
  return (CHART_PERIODS as readonly string[]).includes(value ?? '');
}

/** "1 item", "3 items". */
export function countOf(count: number, noun: string, plural = `${noun}s`): string {
  return `${String(count)} ${count === 1 ? noun : plural}`;
}

/**
 * What a property and its stored values are called.
 *
 * The chart endpoint speaks in property keys and raw stored values, which are what Core can group
 * by; a person reads labels.
 */
export interface ChartLabels {
  /** A property's label, or the key itself when no definition names it. */
  readonly property: (key: string | null) => string;
  /** A stored value as a person reads it: a checkbox's "Checked", an absent value's "Unset". */
  readonly value: (key: string | null, value: string | null) => string;
}

/** The part of a property definition labels read. */
export interface LabelledProperty {
  readonly key: string;
  readonly label: string;
  readonly type: string;
}

/** The priority scale's words, as `priorityLabel` in web-collections reads them. */
const PRIORITY_WORDS: Readonly<Record<string, string>> = {
  '1': 'P1 Urgent',
  '2': 'P2 High',
  '3': 'P3 Normal',
  '4': 'P4 Low',
};

/**
 * Where a bucket sits when its grouping is a closed set: priority 1 to 4, a checkbox unchecked
 * then checked, an absent value last. Null for any other type, which keeps the server's
 * biggest-first order.
 */
export function naturalBucketRank(type: string | undefined, value: string | null): number | null {
  if (type !== 'priority' && type !== 'checkbox' && type !== 'completion') {
    return null;
  }
  if (value === null) {
    return Number.MAX_SAFE_INTEGER;
  }
  return type === 'priority' ? Number(value) : value === 'true' ? 1 : 0;
}

/** Labels from a container's definitions; `unset` is what an absent value is called. */
export function labelsFor(fields: readonly LabelledProperty[], unset: string): ChartLabels {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  return {
    property: (key) => (key === null ? '' : (byKey.get(key)?.label ?? key)),
    value: (key, value) => {
      if (value === null) {
        return unset;
      }
      const type = key === null ? undefined : byKey.get(key)?.type;
      if (type === 'checkbox' || type === 'completion') {
        return value === 'true' ? 'Checked' : value === 'false' ? 'Not checked' : value;
      }
      if (type === 'priority') {
        return PRIORITY_WORDS[value] ?? value;
      }
      return value;
    },
  };
}

/**
 * What a bucket or cell is as large as.
 *
 * A bucket whose children carry no number totals null rather than zero - "nothing to add up" is
 * not "adds up to nothing" - but a mark has to be some size, so null draws as an empty one.
 */
export function measureOf(
  entry: { readonly children: number; readonly total: number | null },
  totals: boolean,
): number {
  return totals ? (entry.total ?? 0) : entry.children;
}

/** The figure as a person reads it: whole numbers plain, fractions to two places. */
export function formatMeasure(value: number | null): string {
  if (value === null) {
    return '-';
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * A period's start date as the person reads it, long or short.
 *
 * `locale` is undefined in the app (the reader's own) and fixed on a published site, whose output
 * must not depend on the machine that built it.
 */
export function bucketLabel(
  value: string | null,
  period: string | null,
  labels: ChartLabels,
  groupBy: string | null = null,
  short = false,
  locale?: string,
): string {
  if (value === null) {
    return labels.value(groupBy, null);
  }
  if (!isChartPeriod(period)) {
    return labels.value(groupBy, value);
  }

  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const options = (parts: Intl.DateTimeFormatOptions) =>
    date.toLocaleDateString(locale, { ...parts, timeZone: 'UTC' });

  switch (period) {
    case 'day':
      return short
        ? options({ day: 'numeric', month: 'short' })
        : options({ day: 'numeric', month: 'short', year: 'numeric' });
    case 'week':
      return short
        ? options({ day: 'numeric', month: 'short' })
        : `Week of ${options({ day: 'numeric', month: 'short', year: 'numeric' })}`;
    case 'month':
      return short ? options({ month: 'short' }) : options({ month: 'short', year: 'numeric' });
    case 'quarter':
      return `Q${String(Math.floor(date.getUTCMonth() / 3) + 1)}${short ? '' : ` ${String(date.getUTCFullYear())}`}`;
    case 'year':
      return String(date.getUTCFullYear());
  }
}

/** What a series is called in a legend and a table header. */
export function seriesLabel(
  series: ChartSeriesInput,
  otherValues: number,
  labels: ChartLabels,
  splitBy: string | null = null,
): string {
  if (series.other) {
    return `Other (${countOf(otherValues, 'value')})`;
  }
  return labels.value(splitBy, series.value);
}

/** The running total of a run of values. */
export function cumulative(values: readonly number[]): number[] {
  let running = 0;
  return values.map((value) => (running += value));
}

/**
 * The trailing average over the last {@link AVERAGE_SPAN} periods, the current one included.
 *
 * Null until a full span exists: an "average" over the first two periods is a different statistic
 * wearing the same line.
 */
export function trailingAverage(values: readonly number[], span = AVERAGE_SPAN): (number | null)[] {
  return values.map((_, index) => {
    if (index + 1 < span) {
      return null;
    }
    let sum = 0;
    for (let offset = index + 1 - span; offset <= index; offset += 1) {
      sum += values[offset] ?? 0;
    }
    return sum / span;
  });
}

/**
 * How one series is told apart without colour: a hatch for fills, a dash for lines, and which of
 * the six series roles (or the muted "Other" role, index 6) it takes its tone from.
 */
export type SeriesHatch =
  'none' | 'diagonal' | 'dots' | 'cross' | 'horizontal' | 'vertical' | 'back';

export interface SeriesPattern {
  /** 0 to 5 for the series roles, 6 for "Other". */
  readonly role: number;
  readonly dash: string | undefined;
  readonly hatch: SeriesHatch;
}

/** The role index "Other" takes. */
export const OTHER_ROLE = MAXIMUM_SERIES;

const SERIES_DASHES: readonly (string | undefined)[] = [
  undefined,
  '8 4',
  '2 4',
  '8 3 2 3',
  '4 4',
  '12 4',
];

const SERIES_HATCHES: readonly SeriesHatch[] = [
  'none',
  'diagonal',
  'dots',
  'cross',
  'horizontal',
  'vertical',
];

export function seriesPattern(index: number, other: boolean): SeriesPattern {
  if (other) {
    return { role: OTHER_ROLE, dash: '1 4', hatch: 'back' };
  }
  const role = index % MAXIMUM_SERIES;
  return { role, dash: SERIES_DASHES[role], hatch: SERIES_HATCHES[role] ?? 'none' };
}

/** One drawn series: a label, its values per bucket, and how it is styled. */
export interface PlottedSeries<S = SeriesPattern> {
  readonly key: string;
  readonly label: string;
  readonly values: readonly number[];
  readonly style: S;
}

/**
 * The series a chart draws, with the line transforms applied.
 *
 * An unsplit chart is one series named after what it measures, so every renderer draws series and
 * none has a second code path for "not split". `style` turns a series position into whatever the
 * renderer styles with: class names in the app, a {@link SeriesPattern} on a site.
 */
export function plottedSeries<S>(
  chart: ChartInput,
  labels: ChartLabels,
  options: { readonly cumulative?: boolean },
  style: (index: number, other: boolean) => S,
): PlottedSeries<S>[] {
  const totals = chart.measure === 'sum';
  const transform = (values: number[]) =>
    options.cumulative === true ? cumulative(values) : values;

  if (chart.series.length === 0) {
    return [
      {
        key: 'all',
        label: totals ? labels.property(chart.measureProperty) || 'Total' : 'Items',
        values: transform(chart.buckets.map((bucket) => measureOf(bucket, totals))),
        style: style(0, false),
      },
    ];
  }

  return chart.series.map((series, index) => ({
    key: series.other ? ' other' : (series.value ?? ' unset'),
    label: seriesLabel(series, chart.otherSeries, labels, chart.splitBy),
    values: transform(
      chart.buckets.map((bucket) => {
        const cell = bucket.cells[index];
        return cell === undefined ? 0 : measureOf(cell, totals);
      }),
    ),
    style: style(index, series.other),
  }));
}

/** What a chart shows, said once above the drawing: measure, grouping, split and window. */
export function chartCaption(
  chart: ChartInput,
  labels: ChartLabels,
  formatDay: (day: string | null) => string,
): string {
  const totals = chart.measure === 'sum';
  const what = totals ? `Total of ${labels.property(chart.measureProperty)}` : 'How many items';
  const by = isChartPeriod(chart.period)
    ? `per ${chart.period} of ${labels.property(chart.groupBy)}`
    : `by ${labels.property(chart.groupBy)}`;
  const split = chart.splitBy === null ? '' : `, split by ${labels.property(chart.splitBy)}`;
  const window =
    chart.from !== null && chart.to !== null
      ? `, ${formatDay(chart.from)} to ${formatDay(chart.to)}`
      : '';
  return `${what} ${by}${split}${window}`;
}
