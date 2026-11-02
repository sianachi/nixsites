/**
 * Ports of Core's three chart reads (RollupSql.BucketChildrenByProperty, ...AndSeries and ...ByDay):
 * the same grouping, ranking, folding and ordering, over the children held in memory.
 */

import { MAXIMUM_SERIES, round6, type Cell, type Cells } from './fold';

export const MAXIMUM_BUCKETS = 100;
export const MAXIMUM_CELLS = 10_000;

/** Thrown when an exact answer needs something the synced copy cannot reproduce; becomes null. */
export class Unfaithful extends Error {}

type Properties = Readonly<Record<string, unknown>>;

/** `properties ->> key`: a string as is, a boolean as true/false, absent and JSON null as null. */
export function text(properties: Properties, key: string): string | null {
  const value = properties[key];
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  // A fraction or exponent would print the way jsonb stores it, which a parsed copy cannot tell.
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new Unfaithful(`property ${key} has no faithful text form`);
}

/** NumberSql.Bounded: a JSON number within 1e15, else nothing. */
function measureOf(properties: Properties, key: string | null): number | null {
  if (key === null) return null;
  const value = properties[key];
  return typeof value === 'number' && Math.abs(value) <= 1e15 ? value : null;
}

/** round(CappedSum(...), 6): null with nothing to add or a total past 1e28. */
function total(measures: readonly (number | null)[], measuring: boolean): number | null {
  if (!measuring) return null;
  const numbers = measures.filter((m): m is number => m !== null);
  if (numbers.length === 0) return null;
  const sum = numbers.reduce((a, b) => a + b, 0);
  return Math.abs(sum) <= 1e28 ? round6(sum) : null;
}

/**
 * Text order for ties. Postgres orders by the database collation, which is not known here, so
 * only strings whose order every collation agrees on are compared; the rest refuse.
 */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  if (!/^[A-Za-z0-9]+$/.test(a) || !/^[A-Za-z0-9]+$/.test(b))
    throw new Unfaithful('collation order');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const x = a[i];
  const y = b[i];
  if (x !== undefined && y !== undefined) {
    const lower = (c: string) => !/[A-Z]/.test(c);
    if (lower(x) !== lower(y)) throw new Unfaithful('collation order');
  }
  return a < b ? -1 : 1;
}

/** ORDER BY value ASC NULLS LAST. */
function byValue(a: string | null, b: string | null): number {
  if (a === null || b === null) return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  return compareText(a, b);
}

interface Counted {
  readonly count: number;
  readonly measures: (number | null)[];
}

function tally(
  rows: readonly { key: string | null; measure: number | null }[],
): Map<string | null, Counted> {
  const groups = new Map<string | null, Counted>();
  for (const { key, measure } of rows) {
    const group = groups.get(key) ?? { count: 0, measures: [] };
    groups.set(key, { count: group.count + 1, measures: [...group.measures, measure] });
  }
  return groups;
}

/** Series by size (count desc, value asc nulls last), as dense_rank; rank 1 is the largest. */
function rankSeries(groups: ReadonlyMap<string | null, Counted>): Map<string | null, number> {
  const ranked = [...groups].sort(([a, x], [b, y]) => y.count - x.count || byValue(a, b));
  return new Map(ranked.map(([series], index) => [series, index + 1]));
}

export function bucketByProperty(
  children: readonly Properties[],
  groupKey: string,
  measureKey: string | null,
): {
  buckets: { value: string | null; children: number; total: number | null }[];
  distinct: number;
  children: number;
} {
  const groups = tally(
    children.map((p) => ({ key: text(p, groupKey), measure: measureOf(p, measureKey) })),
  );
  const ordered = [...groups].sort(([a, x], [b, y]) => y.count - x.count || byValue(a, b));
  return {
    buckets: ordered.slice(0, MAXIMUM_BUCKETS).map(([value, g]) => ({
      value,
      children: g.count,
      total: total(g.measures, measureKey !== null),
    })),
    distinct: groups.size,
    children: children.length,
  };
}

export function bucketBySeries(
  children: readonly Properties[],
  groupKey: string,
  splitKey: string,
  measureKey: string | null,
): Cells {
  const rows = children.map((p) => ({
    bucket: text(p, groupKey),
    series: text(p, splitKey),
    measure: measureOf(p, measureKey),
  }));
  const rank = rankSeries(tally(rows.map((r) => ({ key: r.series, measure: null }))));

  // One cell per (bucket, series), every series past the cap folded into one per bucket.
  const cells = new Map<
    string,
    {
      bucket: string | null;
      series: string | null;
      other: boolean;
      measures: (number | null)[];
      count: number;
    }
  >();
  const bucketChildren = new Map<string | null, number>();
  for (const row of rows) {
    const other = (rank.get(row.series) ?? 0) > MAXIMUM_SERIES;
    const series = other ? null : row.series;
    const key = JSON.stringify([row.bucket, series, other]);
    const cell = cells.get(key) ?? { bucket: row.bucket, series, other, measures: [], count: 0 };
    cell.count++;
    cell.measures.push(row.measure);
    cells.set(key, cell);
    bucketChildren.set(row.bucket, (bucketChildren.get(row.bucket) ?? 0) + 1);
  }

  const buckets = [...bucketChildren].sort(([a, x], [b, y]) => y - x || byValue(a, b));
  const bucketRank = new Map(buckets.map(([bucket], index) => [bucket, index + 1]));

  const kept = [...cells.values()]
    .filter((c) => (bucketRank.get(c.bucket) ?? 0) <= MAXIMUM_BUCKETS)
    .sort(
      (a, b) =>
        (bucketRank.get(a.bucket) ?? 0) - (bucketRank.get(b.bucket) ?? 0) ||
        Number(a.other) - Number(b.other),
    );
  const read: Cell[] = kept.slice(0, MAXIMUM_CELLS).map((c) => ({
    bucket: c.bucket,
    series: c.series,
    children: c.count,
    total: total(c.measures, measureKey !== null),
    other: c.other,
  }));

  return {
    cells: read,
    children: rows.length,
    distinctBuckets: buckets.length,
    cellsCut: kept.length > read.length,
    outsideWindow: 0,
    seriesValues: rank.size,
  };
}

/** pg_input_is_valid(x, 'date') for a yyyy-MM-dd prefix. */
function validDate(prefix: string): boolean {
  const [year, month, day] = [
    Number(prefix.slice(0, 4)),
    Number(prefix.slice(5, 7)),
    Number(prefix.slice(8, 10)),
  ];
  if (year < 1) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function bucketByDay(
  children: readonly Properties[],
  dateKey: string,
  splitKey: string | null,
  measureKey: string | null,
  fromDay: string | null,
  toDay: string | null,
): Cells {
  const rows = children.map((p) => {
    const raw = p[dateKey];
    const prefix =
      typeof raw === 'string' ? (/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.exec(raw)?.[0] ?? null) : null;
    const day = prefix !== null && validDate(prefix) ? prefix : null;
    return {
      day,
      series: splitKey === null ? null : text(p, splitKey),
      measure: measureOf(p, measureKey),
      outside:
        day !== null && ((fromDay !== null && day < fromDay) || (toDay !== null && day > toDay)),
    };
  });

  const inWindow = rows.filter((r) => r.day !== null && !r.outside);
  const rank = rankSeries(tally(inWindow.map((r) => ({ key: r.series, measure: null }))));

  const cells = new Map<
    string,
    {
      bucket: string | null;
      series: string | null;
      other: boolean;
      outside: boolean;
      measures: (number | null)[];
      count: number;
    }
  >();
  for (const row of rows) {
    const placed = row.day !== null && !row.outside;
    const other = placed && (rank.get(row.series) ?? 0) > MAXIMUM_SERIES;
    const series = !placed || other ? null : row.series;
    const bucket = row.outside ? null : row.day;
    const key = JSON.stringify([bucket, series, other, row.outside]);
    const cell = cells.get(key) ?? {
      bucket,
      series,
      other,
      outside: row.outside,
      measures: [],
      count: 0,
    };
    cell.count++;
    cell.measures.push(row.measure);
    cells.set(key, cell);
  }
  // Cutting a read inside the undated/outside rows, whose order Postgres leaves open, is not reproducible.
  if (cells.size > MAXIMUM_CELLS) throw new Unfaithful('cell ceiling');

  // Newest first, undated and outside rows ahead of every day.
  const ordered = [...cells.values()].sort((a, b) =>
    a.bucket === b.bucket
      ? Number(a.other) - Number(b.other)
      : a.bucket === null
        ? -1
        : b.bucket === null
          ? 1
          : a.bucket < b.bucket
            ? 1
            : -1,
  );

  let outside = 0;
  const read: Cell[] = [];
  for (const cell of ordered) {
    if (cell.outside) {
      outside += cell.count;
      continue;
    }
    read.push({
      bucket: cell.bucket,
      series: cell.series,
      children: cell.count,
      total: total(cell.measures, measureKey !== null),
      other: cell.other,
    });
  }

  return {
    cells: read,
    children: rows.length - outside,
    distinctBuckets: null,
    cellsCut: false,
    outsideWindow: outside,
    seriesValues: rank.size,
  };
}
