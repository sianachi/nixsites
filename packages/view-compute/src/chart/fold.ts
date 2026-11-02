/** Port of Core's ChartFolding: what a chart may claim from the cells a read returns. */

import * as dates from './dates';
import type { Period, PeriodRange } from './dates';

export const MAXIMUM_SERIES = 6;
export const MAXIMUM_PERIODS = 371;

export interface Cell {
  readonly bucket: string | null;
  readonly series: string | null;
  readonly children: number;
  readonly total: number | null;
  readonly other: boolean;
}

export interface Cells {
  readonly cells: readonly Cell[];
  readonly children: number;
  readonly distinctBuckets: number | null;
  readonly cellsCut: boolean;
  readonly outsideWindow: number;
  readonly seriesValues: number;
}

export interface Bucket {
  readonly value: string | null;
  readonly children: number;
  readonly total: number | null;
  readonly cells: readonly { children: number; total: number | null }[];
}

export interface Series {
  readonly value: string | null;
  readonly other: boolean;
  readonly children: number;
  readonly total: number | null;
}

export interface Folded {
  readonly buckets: readonly Bucket[];
  readonly series: readonly Series[];
  readonly children: number;
  readonly distinctValues: number;
  readonly unplaced: number;
  readonly otherSeries: number;
  readonly truncated: boolean;
  readonly from: number | null;
  readonly to: number | null;
  readonly outsideWindow: number;
}

const DECIMAL_MAX = 7.922816251426434e28;

/** Postgres round(x, 6); the sums are of at most six-place values so this only cleans float noise. */
export function round6(value: number): number {
  const scaled = Math.round(Math.abs(value) * 1e6) / 1e6;
  return value < 0 ? -scaled : scaled;
}

/** Core's TotalAccumulator: null when nothing was added, or when the sum cannot be represented. */
class Total {
  private sum = 0;
  private any = false;
  private overflowed = false;

  get value(): number | null {
    return this.any && !this.overflowed ? round6(this.sum) : null;
  }

  add(value: number | null): void {
    if (value === null || this.overflowed) return;
    this.sum += value;
    this.any = true;
    if (Math.abs(this.sum) > DECIMAL_MAX) this.overflowed = true;
  }
}

interface Pick {
  readonly series: readonly Series[];
  readonly columns: ReadonlyMap<string | null, number>;
  readonly otherColumn: number;
  readonly otherValues: number;
}

const NO_SERIES: Pick = { series: [], columns: new Map(), otherColumn: -1, otherValues: 0 };

function bucketOf(value: string | null, cells: readonly Cell[], pick: Pick): Bucket {
  let children = 0;
  const total = new Total();
  const columns =
    pick.series.length === 0 ? null : pick.series.map(() => ({ children: 0, total: new Total() }));

  for (const cell of cells) {
    children += cell.children;
    total.add(cell.total);
    if (columns !== null) {
      const column =
        columns[
          cell.other ? pick.otherColumn : (pick.columns.get(cell.series) ?? pick.otherColumn)
        ];
      if (column === undefined) throw new Error('chart cell fits no series');
      column.children += cell.children;
      column.total.add(cell.total);
    }
  }

  return {
    value,
    children,
    total: total.value,
    cells:
      columns === null ? [] : columns.map((c) => ({ children: c.children, total: c.total.value })),
  };
}

function pickSeries(cells: readonly Cell[], seriesValues: number): Pick {
  const totals = new Map<string | null, { children: number; total: Total }>();
  let otherChildren = 0;
  const otherTotal = new Total();
  let foldedByRead = false;
  for (const cell of cells) {
    if (cell.other) {
      foldedByRead = true;
      otherChildren += cell.children;
      otherTotal.add(cell.total);
      continue;
    }
    const entry = totals.get(cell.series) ?? { children: 0, total: new Total() };
    entry.children += cell.children;
    entry.total.add(cell.total);
    totals.set(cell.series, entry);
  }

  // Largest first, unset after every named series of its size, then by value (ordinal).
  const ranked = [...totals].sort(
    ([a, x], [b, y]) =>
      y.children - x.children ||
      (a === null ? 1 : 0) - (b === null ? 1 : 0) ||
      (a === b ? 0 : (a ?? '') < (b ?? '') ? -1 : 1),
  );

  const series: Series[] = [];
  const columns = new Map<string | null, number>();
  let foldedHere = 0;
  for (const [value, entry] of ranked) {
    if (series.length < MAXIMUM_SERIES) {
      columns.set(value, series.length);
      series.push({ value, other: false, children: entry.children, total: entry.total.value });
      continue;
    }
    foldedHere++;
    otherChildren += entry.children;
    otherTotal.add(entry.total.value);
  }

  if (!foldedByRead && foldedHere === 0)
    return { series, columns, otherColumn: -1, otherValues: 0 };

  const otherValues = Math.max(foldedHere, seriesValues - series.length);
  const otherColumn = series.length;
  series.push({ value: null, other: true, children: otherChildren, total: otherTotal.value });
  return { series, columns, otherColumn, otherValues: Math.max(1, otherValues) };
}

/** A chart of categories with one series. */
export function categories(read: {
  buckets: readonly { value: string | null; children: number; total: number | null }[];
  distinct: number;
  children: number;
}): Folded {
  return {
    buckets: read.buckets.map((b) => ({ ...b, cells: [] })),
    series: [],
    children: read.children,
    distinctValues: read.distinct,
    unplaced: 0,
    otherSeries: 0,
    truncated: read.distinct > read.buckets.length,
    from: null,
    to: null,
    outsideWindow: 0,
  };
}

/** A chart of categories split into series. */
export function categoriesBySeries(read: Cells): Folded {
  const groups: { value: string | null; cells: Cell[] }[] = [];
  for (const cell of read.cells) {
    let group = groups[groups.length - 1];
    if (group?.value !== cell.bucket) {
      group = { value: cell.bucket, cells: [] };
      groups.push(group);
    }
    group.cells.push(cell);
  }
  if (read.cellsCut && groups.length > 0) groups.pop();

  const pick = pickSeries(
    groups.flatMap((g) => g.cells),
    read.seriesValues,
  );
  const buckets = groups.map((g) => bucketOf(g.value, g.cells, pick));
  const distinct = read.distinctBuckets ?? buckets.length;

  return {
    buckets,
    series: pick.series,
    children: read.children,
    distinctValues: distinct,
    unplaced: 0,
    otherSeries: pick.otherValues,
    truncated: read.cellsCut || distinct > buckets.length,
    from: null,
    to: null,
    outsideWindow: 0,
  };
}

/** A chart along a time axis: days folded into periods and empty periods filled. */
export function days(
  read: Cells,
  period: Period,
  first: number | null,
  last: number | null,
  split: boolean,
  endAtData: boolean,
): Folded {
  let unplaced = 0;
  let dated: { start: number; cell: Cell }[] = [];
  for (const cell of read.cells) {
    const day = dates.readDate(cell.bucket);
    if (day === null) unplaced += cell.children;
    else dated.push({ start: dates.start(day, period), cell });
  }

  const truncated = read.cellsCut;
  let earliestKnown: number | null = null;
  if (read.cellsCut && dated.length > 0) {
    const cut = (dated[dated.length - 1] as { start: number }).start;
    dated = dated.filter((entry) => entry.start !== cut);
    earliestKnown = dates.add(cut, period, 1);
  }

  const children = read.children - unplaced;
  const windowFrom = first === null ? null : dates.start(first, period);
  const windowTo =
    last !== null && !endAtData ? dates.end(dates.start(last, period), period) : null;
  const empty = (): Folded => ({
    buckets: [],
    series: [],
    children,
    distinctValues: 0,
    unplaced,
    otherSeries: 0,
    truncated,
    from: windowFrom,
    to: windowTo,
    outsideWindow: read.outsideWindow,
  });

  if (dated.length === 0) return empty();

  const starts = dated.map((entry) => entry.start);
  const dataFirst = Math.min(...starts);
  const dataLast = Math.max(...starts);

  let rangeFirst = first === null ? dataFirst : dates.start(first, period);
  let rangeLast = last === null ? dataLast : dates.start(last, period);
  if (endAtData && dataLast < rangeLast) rangeLast = dataLast;
  if (earliestKnown !== null && rangeFirst < earliestKnown) rangeFirst = earliestKnown;
  if (rangeLast < rangeFirst) return empty();

  const whole: PeriodRange = { first: rangeFirst, last: rangeLast, period };
  const range = dates.keepLatest(whole, MAXIMUM_PERIODS);

  const byPeriod = new Map<number, Cell[]>();
  const drawn: Cell[] = [];
  for (const { start, cell } of dated) {
    if (start < range.first || start > range.last) continue;
    byPeriod.set(start, [...(byPeriod.get(start) ?? []), cell]);
    drawn.push(cell);
  }

  const pick = split ? pickSeries(drawn, read.seriesValues) : NO_SERIES;
  const buckets = [...dates.enumerate(range)].map((start) =>
    bucketOf(dates.format(start), byPeriod.get(start) ?? [], pick),
  );

  return {
    buckets,
    series: pick.series,
    children,
    distinctValues: dates.size(whole),
    unplaced,
    otherSeries: pick.otherValues,
    truncated: truncated || dates.size(range) < dates.size(whole),
    from: range.first,
    to: dates.end(range.last, period),
    outsideWindow: read.outsideWindow,
  };
}
