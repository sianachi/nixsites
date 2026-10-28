/**
 * A chart view's data: a container's children summarised into buckets, server-side.
 *
 * Server-side and not in the browser, because a chart tallied from a loaded page of a container
 * with three thousand children would be a picture of the first page presented as a picture of the
 * whole. ADR-0044 records the decision; what this file owns is the boundary parse.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

/** One series' share of one bucket. */
const chartCellSchema = z.object({
  children: z.int(),
  total: z.number().nullable(),
});

const chartBucketSchema = z.object({
  /**
   * The grouping property's value, or null for the children that have none.
   *
   * Unset is a bucket rather than an omission: a container half of whose children have no status is
   * mostly a container of unset things, and dropping them would misreport every proportion.
   */
  value: z.string().nullable(),

  children: z.int(),

  /** The measured property's total, or null when the chart counts rather than totals. */
  total: z.number().nullable(),

  /**
   * One cell per series, aligned with the chart's `series`; empty when the chart is not split.
   * Defaulted so a server from before series answers without it and costs nothing.
   */
  cells: z.array(chartCellSchema).default([]),
});

/** One series of a split chart. */
const chartSeriesSchema = z.object({
  /** The splitting property's value; null for the children with none, and for "Other". */
  value: z.string().nullable(),

  /** Whether this series stands for every value past the sixth, folded together. */
  other: z.boolean(),
  children: z.int(),
  total: z.number().nullable(),
});

export const itemChartSchema = z.object({
  itemId: z.uuid(),
  viewId: z.string(),
  groupBy: z.string(),

  /** What each bar measures. An open string, matching every other view vocabulary on this wire. */
  measure: z.string(),
  measureProperty: z.string().nullable(),

  buckets: z.array(chartBucketSchema),

  /** Every child summarised, across every bucket including any left out. */
  children: z.int(),

  /** How many distinct values the grouping property takes, whether or not each one fitted. */
  distinctValues: z.int(),

  /**
   * Whether more buckets exist than were returned.
   *
   * Carried rather than inferred from a count, because inferring it is exactly the arithmetic a
   * client gets wrong once and then draws confidently forever.
   */
  truncated: z.boolean(),

  /**
   * The type the view draws: `bar`, `column`, `pie`, `line`, `area` or `year`. An open string, like
   * `measure`; the renderer draws a type it does not know as bars. Defaulted so a server from before
   * chart types answers without it.
   */
  chartKind: z.string().default('bar'),

  /**
   * The time axis's period (`day`, `week`, `month`, `quarter`, `year`), or null for a chart of
   * categories. On a time axis every bucket's `value` is its period's start date, `yyyy-MM-dd`,
   * earliest first, empty periods included as zeros.
   */
  period: z.string().nullable().default(null),
  splitBy: z.string().nullable().default(null),

  /** The first and last day a time axis covers. */
  from: z.iso.date().nullable().default(null),
  to: z.iso.date().nullable().default(null),

  /** The series, largest first and any "Other" last; empty when not split. */
  series: z.array(chartSeriesSchema).default([]),

  /** How many series values were folded into "Other" (every value past the sixth). */
  otherSeries: z.int().default(0),

  /**
   * Dated items outside the time axis's window - before it, or after its end - counted so a chart
   * whose items all fall elsewhere can say so rather than looking empty.
   */
  outsideWindow: z.int().default(0),

  /**
   * The view's drawing options, as stored, returned with the buckets so a renderer reads every
   * option from this one payload rather than mixing it with a possibly newer client-side view.
   */
  stacked: z.boolean().default(false),
  cumulative: z.boolean().default(false),
  rollingAverage: z.boolean().default(false),

  /**
   * Children a time axis could not place because they have no date. Counted rather than dropped,
   * so the chart can say so instead of quietly shrinking.
   */
  unplaced: z.int().default(0),
});

export type ChartBucket = z.infer<typeof chartBucketSchema>;
export type ChartCell = z.infer<typeof chartCellSchema>;
export type ChartSeries = z.infer<typeof chartSeriesSchema>;
export type ItemChart = z.infer<typeof itemChartSchema>;

/**
 * The compile-time tie to the generated contract: a field Core renames stops this package's build
 * rather than emptying a chart in front of somebody.
 */
const _itemChartContract = itemChartSchema satisfies z.ZodType<
  components['schemas']['ChartResponse']
>;
void _itemChartContract;
