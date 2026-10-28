/**
 * A chart view's data, structurally.
 *
 * Mirrors the fields of `@nix/api-client`'s `ItemChart` that drawing reads, so the API client's
 * parsed value is assignable here without this package depending on the client (or on Zod).
 */

interface ChartCellInput {
  readonly children: number;
  readonly total: number | null;
}

interface ChartBucketInput {
  readonly value: string | null;
  readonly children: number;
  readonly total: number | null;
  readonly cells: readonly ChartCellInput[];
}

export interface ChartSeriesInput {
  readonly value: string | null;
  readonly other: boolean;
  readonly children: number;
  readonly total: number | null;
}

export interface ChartInput {
  readonly groupBy: string;
  readonly measure: string;
  readonly measureProperty: string | null;
  readonly buckets: readonly ChartBucketInput[];
  readonly chartKind: string;
  readonly period: string | null;
  readonly splitBy: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly series: readonly ChartSeriesInput[];
  readonly otherSeries: number;
  readonly stacked: boolean;
  readonly cumulative: boolean;
  readonly rollingAverage: boolean;
}
