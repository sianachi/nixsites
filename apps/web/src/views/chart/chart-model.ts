import type { ChartBucket, ItemChart } from '@nix/api-client';
import {
  bucketLabel as drawnBucketLabel,
  chartCaption as drawnChartCaption,
  labelsFor,
  plottedSeries as drawnPlottedSeries,
  seriesPattern,
  type ChartLabels,
  type PlottedSeries as DrawnSeries,
  type SeriesHatch,
} from '@nix/chart-render';

import { formatCalendarDay } from '@nix/web-foundation/lib/date-format';
import { UNSET_LABEL, type PropertyDefinition } from '@nix/web-collections/core/container-model';

/**
 * The app's side of the chart model.
 *
 * The arithmetic, vocabulary and geometry live in `@nix/chart-render` so a published site draws
 * the same figures without React. What stays here is what only the app knows: its word for an
 * absent value, the reader's locale for days, and the Tailwind classes each series role maps to.
 */

export {
  AVERAGE_SPAN,
  CHART_KIND_LABELS,
  CHART_PERIODS,
  CHART_PERIOD_LABELS,
  MAXIMUM_CHART_PERIODS,
  MAXIMUM_SERIES,
  TIME_AXIS_KINDS,
  chartKindOf,
  countOf,
  cumulative,
  formatMeasure,
  isChartPeriod,
  measureOf,
  trailingAverage,
  type ChartKind,
  type ChartLabels,
} from '@nix/chart-render';

export function chartLabels(fields: readonly PropertyDefinition[]): ChartLabels {
  return labelsFor(fields, UNSET_LABEL);
}

/** Labels that know no definitions: keys and values as stored. */
const RAW_LABELS: ChartLabels = chartLabels([]);

/** A stored day as a person reads it - "6 Oct 2025" in their locale - or the text itself. */
export function formatDay(day: string | null): string {
  return day === null ? '' : (formatCalendarDay(day) ?? day);
}

/** A period's start date as the person reads it, long or short. */
export function bucketLabel(
  value: string | null,
  period: string | null,
  labels: ChartLabels = RAW_LABELS,
  groupBy: string | null = null,
  short = false,
): string {
  return drawnBucketLabel(value, period, labels, groupBy, short);
}

/**
 * How one series is told apart from the others: a series role's colour classes plus the shared
 * pattern (a hatch for fills, a dash for lines). Never by colour alone - every series is also
 * named in the legend and the table. See `@nix/chart-render`'s `seriesPattern`.
 */
export interface SeriesStyle {
  /** Classes for a filled mark's colour: a column segment, an area, a slice, a legend swatch. */
  readonly fill: string;
  /** Classes for a stroked mark: a line. */
  readonly stroke: string;
  /** The SVG dash pattern for a line, or undefined for a solid one. */
  readonly dash: string | undefined;
  /** Which hatch a fill carries over its colour; `none` for a solid fill. */
  readonly hatch: SeriesHatch;
}

const SERIES_ROLES: readonly { readonly fill: string; readonly stroke: string }[] = [
  { fill: 'fill-series-1 bg-series-1', stroke: 'stroke-series-1' },
  { fill: 'fill-series-2 bg-series-2', stroke: 'stroke-series-2' },
  { fill: 'fill-series-3 bg-series-3', stroke: 'stroke-series-3' },
  { fill: 'fill-series-4 bg-series-4', stroke: 'stroke-series-4' },
  { fill: 'fill-series-5 bg-series-5', stroke: 'stroke-series-5' },
  { fill: 'fill-series-6 bg-series-6', stroke: 'stroke-series-6' },
  { fill: 'fill-muted bg-muted', stroke: 'stroke-muted' },
];

export function seriesStyle(index: number, other: boolean): SeriesStyle {
  const pattern = seriesPattern(index, other);
  const role = SERIES_ROLES[pattern.role] ?? { fill: '', stroke: '' };
  return { fill: role.fill, stroke: role.stroke, dash: pattern.dash, hatch: pattern.hatch };
}

/** One drawn series: a label, its values per bucket, and how it is styled. */
export type PlottedSeries = DrawnSeries<SeriesStyle>;

/** The series a chart draws, with the line transforms applied. */
export function plottedSeries(
  chart: ItemChart,
  labels: ChartLabels = RAW_LABELS,
  options: { readonly cumulative?: boolean } = {},
): PlottedSeries[] {
  return drawnPlottedSeries(chart, labels, options, seriesStyle);
}

/** What a chart shows, said once above the drawing: measure, grouping, split and window. */
export function chartCaption(chart: ItemChart, labels: ChartLabels = RAW_LABELS): string {
  return drawnChartCaption(chart, labels, formatDay);
}

/** A bucket's key for React, stable across reloads. */
export function bucketKey(bucket: ChartBucket): string {
  return bucket.value ?? ' unset';
}
