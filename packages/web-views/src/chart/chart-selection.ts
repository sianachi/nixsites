import type { ItemChart } from '@nix/api-client';
import type { Item } from '@nix/web-collections/core/container-model';

import { bucketKey, isChartPeriod } from './chart-model';

/**
 * Which items sit behind a figure on the chart.
 *
 * A mark is picked by the keys of the buckets it stands for (one, or several for a pie's Other
 * slice) and, on a split chart, the index of one series. Keys rather than positions, so a pick
 * survives a switch of chart type and is dropped, not mis-pointed, when a reload removes its bucket.
 *
 * shortcut: the items come from the container's loaded children, bucketed here the way Core buckets
 * them, so a truncated container lists only what is loaded; the panel says so. Upgrade to a Core
 * endpoint that lists a bucket's items when containers outgrow the loaded page.
 */
export interface ChartPick {
  readonly keys: readonly string[];
  readonly series: number | null;
}

/** What the marks need to be pickable: which are picked, and how to toggle one. */
export interface ChartPicking {
  readonly toggle: (keys: readonly string[], series?: number) => void;
  readonly isOn: (keys: readonly string[], series?: number) => boolean;
}

const UNSET = ' unset';

/** The start of the period a day falls in, as Core computes it (Monday weeks), or null if not a date. */
function periodStart(value: string, period: string): string | null {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (period === 'week') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (period === 'month') date.setUTCDate(1);
  if (period === 'quarter') date.setUTCMonth(Math.floor(date.getUTCMonth() / 3) * 3, 1);
  if (period === 'year') date.setUTCMonth(0, 1);
  return date.toISOString().slice(0, 10);
}

/** The bucket keys an item counts in: a multi-select counts in each of its values. */
function keysOf(item: Item, key: string, period: string | null): string[] {
  const raw = item.properties[key];
  const values = (Array.isArray(raw) ? raw : [raw]).filter(
    (value): value is string | number | boolean =>
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  );
  const texts = values.map(String).filter((text) => text !== '');
  if (period === null || !isChartPeriod(period)) return texts.length === 0 ? [UNSET] : texts;
  const start = texts[0] === undefined ? null : periodStart(texts[0], period);
  return start === null ? [] : [start];
}

function inSeries(item: Item, chart: ItemChart, series: number): boolean {
  if (chart.splitBy === null) return true;
  const wanted = chart.series[series];
  if (wanted === undefined) return false;
  const have = keysOf(item, chart.splitBy, null).filter((value) => value !== UNSET);
  if (wanted.other) {
    const named = chart.series.filter((entry) => !entry.other).map((entry) => entry.value);
    return have.some((value) => !named.includes(value));
  }
  return wanted.value === null ? have.length === 0 : have.includes(wanted.value);
}

/** The pick if the chart still has everything it names, else null. */
export function validPick(chart: ItemChart, pick: ChartPick | null): ChartPick | null {
  if (pick === null) return null;
  const known = new Set(chart.buckets.map(bucketKey));
  const seriesOk = pick.series === null || chart.series[pick.series] !== undefined;
  return seriesOk && pick.keys.every((key) => known.has(key)) ? pick : null;
}

export function pickedItems(chart: ItemChart, children: readonly Item[], pick: ChartPick): Item[] {
  const keys = new Set(pick.keys);
  return children.filter(
    (item) =>
      keysOf(item, chart.groupBy, chart.period).some((key) => keys.has(key)) &&
      (pick.series === null || inSeries(item, chart, pick.series)),
  );
}

export function samePick(a: ChartPick | null, b: ChartPick | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.series === b.series &&
    a.keys.length === b.keys.length &&
    a.keys.every((key, index) => key === b.keys[index])
  );
}
