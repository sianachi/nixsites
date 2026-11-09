import type { ItemChart } from '@nix/api-client';
import type { ReactNode } from 'react';

import {
  bucketKey,
  bucketLabel,
  countOf,
  MAXIMUM_SERIES,
  measureOf,
  seriesStyle,
  type ChartLabels,
} from './chart-model';
import type { ChartPicking } from './chart-selection';
import { ChartTable } from './chart-table';
import { ChartLegend, PieChart, type PieSlice } from './svg-charts';

/**
 * A pie, its slices largest first, with every slice past the series cap drawn as one Other slice.
 * The table under it lists every bucket by name, folded or not.
 */
export function PieWithTable({
  chart,
  labels,
  rowHeader,
  picking,
}: {
  readonly picking?: ChartPicking | undefined;
  readonly chart: ItemChart;
  readonly labels: ChartLabels;
  readonly rowHeader: string;
}): ReactNode {
  const totals = chart.measure === 'sum';
  const ranked = chart.buckets
    .map((bucket) => ({
      key: bucketKey(bucket),
      label: bucketLabel(bucket.value, chart.period, labels, chart.groupBy),
      value: measureOf(bucket, totals),
      muted: bucket.value === null,
    }))
    .sort((first, second) => second.value - first.value);
  const named = ranked.slice(0, MAXIMUM_SERIES);
  const folded = ranked.slice(MAXIMUM_SERIES);
  const slices: PieSlice[] = [
    ...named.map((slice, index) => ({
      ...slice,
      keys: [slice.key],
      style: seriesStyle(index, false),
    })),
    ...(folded.length === 0
      ? []
      : [
          {
            key: ' other',
            keys: folded.map((slice) => slice.key),
            label: `Other (${countOf(folded.length, 'value')})`,
            value: folded.reduce((sum, slice) => sum + slice.value, 0),
            style: seriesStyle(MAXIMUM_SERIES, true),
          },
        ]),
  ];
  const whole = ranked.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);

  return (
    <div className="flex flex-col gap-3">
      <PieChart slices={slices} picking={picking} />
      <ChartLegend entries={slices} lines={false} />
      <ChartTable
        caption="Every figure"
        rowHeader={rowHeader}
        rows={ranked}
        collapse={ranked.length > 12}
        picking={picking}
        columns={[
          {
            key: 'value',
            label: totals ? labels.property(chart.measureProperty) || 'Total' : 'Items',
            values: ranked.map((slice) => slice.value),
          },
          {
            key: 'share',
            label: 'Share (%)',
            values: ranked.map((slice) =>
              whole === 0 ? 0 : Math.round((Math.max(0, slice.value) / whole) * 10000) / 100,
            ),
          },
        ]}
      />
    </div>
  );
}
