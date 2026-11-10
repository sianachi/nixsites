import type { MirrorItem } from '@nix/sync-core/mirror';

import type { ViewAnswer, ViewCompute, ViewSource } from '../types';
import * as dates from './dates';
import type { Period } from './dates';
import * as fold from './fold';
import { Unfaithful, bucketByDay, bucketByProperty, bucketBySeries } from './read';

/** GET /api/v1/items/{id}/chart, ported from Core's RunItemChartHandler; null when it cannot be exact. */

const VIEW_KINDS = [
  'list',
  'chat',
  'habit_tracker',
  'board',
  'calendar',
  'gallery',
  'timeline',
  'sheet',
  'form',
  'query',
  'interactive_form',
  'drive',
  'checklist',
  'outline',
  'custom',
  'matrix',
  'chart',
];
const CHART_KINDS = ['bar', 'column', 'pie', 'line', 'area', 'year'];

type Json = Record<string, unknown>;

const refuse = (status: number, code: string, detail: string): ViewAnswer => ({
  status,
  code,
  detail,
});
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface Options {
  kind: string | null;
  period: Period | null;
  splitBy: string | null;
  lastPeriods: number | null;
  from: number | null;
  to: number | null;
  cumulative: boolean;
  rollingAverage: boolean;
  stacked: boolean;
}

/** ChartOptionsJson.Read: fail-soft, field by field. */
function readOptions(node: unknown): Options {
  const stored = isObject(node) ? node : {};
  const period = dates.PERIODS.includes(str(stored.period) ?? '')
    ? (stored.period as Period)
    : null;
  let kind = CHART_KINDS.includes(str(stored.kind) ?? '') ? (stored.kind as string) : null;
  if ((kind === 'line' || kind === 'area' || kind === 'year') && period === null) kind = null;

  const last = stored.lastPeriods;
  const lastPeriods =
    typeof last === 'number' && Number.isInteger(last) && last >= 1 && last <= fold.MAXIMUM_PERIODS
      ? last
      : null;
  const day = (value: unknown): number | null => {
    const text = str(value);
    return text !== null && text.length === 10 ? dates.readDate(text) : null;
  };
  let from = period === null || lastPeriods !== null ? null : day(stored.from);
  let to = period === null || lastPeriods !== null ? null : day(stored.to);
  if (from !== null && to !== null && to < from) from = to = null;

  return {
    kind,
    period,
    splitBy:
      str(stored.splitBy) !== null && (stored.splitBy as string).length > 0
        ? (stored.splitBy as string)
        : null,
    lastPeriods: period === null ? null : lastPeriods,
    from,
    to,
    cumulative: stored.cumulative === true,
    rollingAverage: stored.rollingAverage === true,
    stacked: stored.stacked === true,
  };
}

/** The first valid, first-of-its-id view entry, as ViewDefinitionsJson.Read keeps them. */
function findView(views: Json | null, id: string): Json | null {
  const seen = new Set<string>();
  const entries = Array.isArray(views?.views) ? (views.views as unknown[]) : [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const entryId = str(entry.id);
    if (entryId === null || entryId === '' || !VIEW_KINDS.includes(str(entry.kind) ?? '')) continue;
    if (seen.has(entryId)) continue;
    seen.add(entryId);
    if (entryId === id) return entry.kind === 'chart' ? entry : null;
  }
  return null;
}

/** The container must be readable whole: active, unlocked, and under no locked or removed ancestor. */
async function readable(source: ViewSource, item: MirrorItem): Promise<boolean> {
  let node: MirrorItem | undefined = item;
  for (let depth = 0; node !== undefined && depth < 1000; depth++) {
    if (node.lifecycleState !== 'active' || node.locked) return false;
    if (node.parentId === null) return true;
    node = await source.item(node.parentId);
  }
  return false;
}

function window(options: Options, axis: Period, kind: string, today: number) {
  if (options.lastPeriods !== null) {
    const range = dates.lastPeriods(
      today,
      axis,
      Math.min(Math.max(options.lastPeriods, 1), fold.MAXIMUM_PERIODS),
    );
    return { first: range.first, last: range.last, endAtData: false };
  }
  if (options.to !== null) return { first: options.from, last: options.to, endAtData: false };
  if (kind === 'year' && options.from === null) {
    const monday = dates.start(today, 'week');
    return { first: monday - 52 * 7, last: monday + 6, endAtData: false };
  }
  return { first: options.from, last: today, endAtData: true };
}

/** The calendar day of an instant in an IANA zone; null or an unknown zone is UTC, as in Core. */
function dayIn(instant: Date, zone: string | null): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
  } catch {
    return dayIn(instant, null);
  }
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return dates.dayNumber(part('year'), part('month'), part('day'));
}

const iso = (day: number | null): string | null => (day === null ? null : dates.format(day));

export const computeChart: ViewCompute = async (source, request, match) => {
  const itemId = match[1] ?? '';
  const viewId = request.url.searchParams.get('view');
  if (viewId === null || viewId === '')
    return refuse(404, 'chart.view_not_found', 'Name the view to draw: ?view=<view id>.');

  const item = await source.item(itemId);
  if (item === undefined) return refuse(404, 'items.not_found', `No item ${itemId} is visible.`);
  // A lock, a trashed ancestor or a withheld child changes the answer in ways the copy cannot show.
  if (!(await readable(source, item))) return null;

  const view = findView(item.views, viewId);
  if (view === null)
    return refuse(404, 'chart.view_not_found', `Item ${itemId} has no chart view '${viewId}'.`);

  const name = str(view.name) ?? viewId;
  const groupBy = str(view.groupBy);
  if (groupBy === null || groupBy === '')
    return refuse(422, 'chart.not_configured', `'${name}' has no property to group by.`);

  const measure = view.measure === 'sum' ? 'sum' : 'count';
  const measureProperty = measure === 'sum' ? str(view.measureProperty) : null;
  if (measure === 'sum' && (measureProperty === null || measureProperty === ''))
    return refuse(
      422,
      'chart.not_configured',
      `'${name}' totals a property, so it needs one to total.`,
    );

  const options = readOptions(view.chart);
  let kind = options.kind ?? 'bar';
  const splitBy = options.splitBy;

  const children = (await source.workspaceItems(item.workspaceId)).filter(
    (child) => child.parentId === itemId && child.lifecycleState === 'active',
  );
  if (children.some((child) => child.locked)) return null;
  const rows = children.map((child) => child.properties);

  try {
    let folded: fold.Folded;
    let period: Period | null = null;
    if (options.period !== null) {
      const axis: Period = kind === 'year' ? 'day' : options.period;
      period = axis;
      // Core's "today" is the reader's own day; an unknown zone cannot be answered offline.
      if (source.timeZone === undefined) return null;
      const today = dayIn(source.now(), source.timeZone);
      const { first, last, endAtData } = window(options, axis, kind, today);
      const cells = bucketByDay(
        rows,
        groupBy,
        splitBy,
        measureProperty,
        first === null ? null : dates.format(dates.start(first, axis)),
        dates.format(dates.end(dates.start(last, axis), axis)),
      );
      folded = fold.days(cells, axis, first, last, splitBy !== null, endAtData);
    } else {
      if (kind === 'line' || kind === 'area' || kind === 'year') kind = 'bar';
      folded =
        splitBy === null
          ? fold.categories(bucketByProperty(rows, groupBy, measureProperty))
          : fold.categoriesBySeries(bucketBySeries(rows, groupBy, splitBy, measureProperty));
    }

    return {
      status: 200,
      body: {
        itemId,
        viewId,
        groupBy,
        measure,
        measureProperty,
        buckets: folded.buckets,
        children: folded.children,
        distinctValues: folded.distinctValues,
        truncated: folded.truncated,
        chartKind: kind,
        period,
        splitBy,
        from: iso(folded.from),
        to: iso(folded.to),
        series: folded.series,
        otherSeries: folded.otherSeries,
        unplaced: folded.unplaced,
        outsideWindow: folded.outsideWindow,
        stacked: options.stacked,
        cumulative: options.cumulative,
        rollingAverage: options.rollingAverage,
      },
    };
  } catch (error) {
    if (error instanceof Unfaithful) return null;
    throw error;
  }
};
