import { type Row, groupComparator, groupKey } from './run';
import { jsonType, textOf } from './text';

const VALUE_BOUND = 1e15; // NumberSql.ValueBound
const TOTAL_BOUND = 1e28; // NumberSql.TotalBound
const MAXIMUM_GROUPS = 100;

// shortcut: sums run in doubles, then round to six places like Core; a column of values near
// 1e15 with fractions can lose digits Postgres numeric keeps. Upgrade to scaled BigInt if needed.
function round6(x: number): number {
  const y = Number(Math.abs(x).toPrecision(15));
  return Math.sign(x) * (Math.round(y * 1e6) / 1e6);
}

interface Tally {
  count: number;
  skipped: number;
  values: number[];
}

function fold(fn: string, tally: Tally): number | null {
  const { values } = tally;
  switch (fn) {
    case 'count':
      return tally.count;
    case 'sum': {
      if (values.length === 0) return null;
      const sum = values.reduce((a, b) => a + b, 0);
      return Math.abs(sum) <= TOTAL_BOUND ? round6(sum) : null;
    }
    case 'avg':
      return values.length === 0 ? null : round6(values.reduce((a, b) => a + b, 0) / values.length);
    case 'min':
      return values.length === 0 ? null : round6(Math.min(...values));
    default:
      return values.length === 0 ? null : round6(Math.max(...values));
  }
}

function add(tally: Tally, row: Row, fn: string, property: string | null): void {
  tally.count++;
  if (fn === 'count' || property === null) return;
  const value = Object.hasOwn(row.props, property) ? row.props[property] : undefined;
  const type = jsonType(value);
  const bounded =
    type === 'number' && Math.abs(value as number) <= VALUE_BOUND ? (value as number) : null;
  if (bounded !== null) tally.values.push(bounded);
  else if (type !== undefined && type !== 'null' && textOf(value) !== '') tally.skipped++;
}

/** `QuerySql.CompileAggregate`: totals over every match, and per group in display order. */
export function aggregate(
  matched: readonly Row[],
  fn: string,
  property: string | null,
  grouping: { readonly key: string; readonly order: readonly string[] } | undefined,
): {
  groups: unknown[];
  total: number | null;
  count: number;
  skipped: number;
  groupCount: number;
  truncated: boolean;
} {
  const all: Tally = { count: 0, skipped: 0, values: [] };
  const byGroup = new Map<string | null, Tally>();
  for (const row of matched) {
    add(all, row, fn, property);
    if (grouping === undefined) continue;
    const key = groupKey(row, grouping.key);
    let tally = byGroup.get(key);
    if (tally === undefined) byGroup.set(key, (tally = { count: 0, skipped: 0, values: [] }));
    add(tally, row, fn, property);
  }

  // count(distinct group_key) + 1 when some row has no group; with no grouping every key is null.
  const keys =
    grouping === undefined
      ? new Set<string | null>(matched.length > 0 ? [null] : [])
      : new Set(byGroup.keys());
  const ordered =
    grouping === undefined
      ? []
      : [...byGroup.entries()].sort(([a], [b]) => groupComparator(grouping.order)(a, b));
  const groups = ordered.slice(0, MAXIMUM_GROUPS).map(([key, tally]) => ({
    key,
    label: key,
    value: fold(fn, tally),
    count: tally.count,
    skipped: tally.skipped,
  }));
  return {
    groups,
    total: fold(fn, all),
    count: all.count,
    skipped: all.skipped,
    groupCount: keys.size,
    // Core derives it as GroupCount > Groups.Count, so an ungrouped aggregate over rows reports true.
    truncated: keys.size > groups.length,
  };
}
