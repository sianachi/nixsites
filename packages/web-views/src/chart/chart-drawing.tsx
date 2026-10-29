import type { ItemChart } from '@nix/api-client';
import { Text, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import { BarTable } from './bar-table';
import {
  AVERAGE_SPAN,
  bucketKey,
  bucketLabel,
  CHART_PERIOD_LABELS,
  countOf,
  formatMeasure,
  isChartPeriod,
  measureOf,
  plottedSeries,
  seriesStyle,
  trailingAverage,
  type ChartKind,
  type ChartLabels,
} from './chart-model';
import { ChartTable, type ChartTableColumn } from './chart-table';
import { PieWithTable } from './pie-with-table';
import { ChartLegend, ColumnChart, LineChart } from './svg-charts';
import { YearGrid } from './year-grid';

export function Drawing({
  chart,
  kind,
  labels,
  caption,
}: {
  readonly chart: ItemChart;
  readonly kind: ChartKind;
  readonly labels: ChartLabels;
  readonly caption: string;
}): ReactNode {
  const lines = kind === 'line' || kind === 'area';
  const cumulative = lines && chart.cumulative;
  const split = chart.series.length > 0;
  const stacked = chart.stacked && split;
  const totals = chart.measure === 'sum';

  // A trailing average over a stack would sit on the wrong baseline, and one over fewer periods
  // than it spans is a different statistic; both are said rather than drawn.
  const averageAsked = lines && chart.rollingAverage;
  const averageStacked = averageAsked && kind === 'area' && stacked;
  const averageShort = averageAsked && chart.buckets.length < AVERAGE_SPAN;
  const averaged = averageAsked && !averageStacked && !averageShort;

  const rowHeader = isChartPeriod(chart.period)
    ? CHART_PERIOD_LABELS[chart.period]
    : labels.property(chart.groupBy);
  const rows = chart.buckets.map((bucket) => ({
    key: bucketKey(bucket),
    label: bucketLabel(bucket.value, chart.period, labels, chart.groupBy),
    muted: bucket.value === null,
  }));
  const axis = {
    labels: rows.map((row) => row.label),
    shortLabels: chart.buckets.map((bucket) =>
      bucketLabel(bucket.value, chart.period, labels, chart.groupBy, true),
    ),
    whole: !totals,
  };
  const series = plottedSeries(chart, labels, { cumulative });
  const averages = averaged ? series.map((entry) => trailingAverage(entry.values)) : undefined;

  const drawnLabel = (label: string) => (cumulative ? `${label} (running total)` : label);
  const columns: ChartTableColumn[] = [
    ...series.map((entry) => ({
      key: entry.key,
      label: drawnLabel(entry.label),
      values: entry.values,
    })),
    // The average is of what is drawn, so over a running total it is the running total's average,
    // and the header says so.
    ...(averages ?? []).map((values, index) => ({
      key: `average-${series[index]?.key ?? String(index)}`,
      label: `${drawnLabel(series[index]?.label ?? '')} (${String(AVERAGE_SPAN)}-period average)`,
      values,
    })),
    ...(split && !cumulative
      ? [
          {
            key: ' total',
            label: 'All',
            values: chart.buckets.map((bucket) => measureOf(bucket, totals)),
          },
        ]
      : []),
  ];

  const table = (
    <ChartTable
      caption="Every figure"
      rowHeader={rowHeader}
      rows={rows}
      columns={columns}
      collapse={rows.length > 12}
    />
  );

  switch (kind) {
    case 'bar':
      return (
        <BarTable
          chart={chart}
          caption={caption}
          rowHeader={rowHeader}
          rows={rows}
          series={series}
        />
      );

    case 'column':
      return (
        <div className="flex flex-col gap-3">
          {split ? <ChartLegend entries={series} lines={false} /> : null}
          <ColumnChart series={series} stacked={stacked} {...axis} />
          {table}
        </div>
      );

    case 'line':
    case 'area':
      return (
        <div className="flex flex-col gap-3">
          {split || averages !== undefined ? (
            <ChartLegend
              lines={kind === 'line'}
              entries={[
                ...series,
                ...(averages === undefined
                  ? []
                  : [
                      {
                        key: ' average',
                        label: `Dotted lines: each series' ${String(AVERAGE_SPAN)}-period average`,
                        style: seriesStyle(0, true),
                        dotted: true,
                      },
                    ]),
              ]}
            />
          ) : null}
          {averageStacked ? (
            <Text variant="note" tone="muted">
              {`The ${String(AVERAGE_SPAN)}-period average is not drawn on stacked areas, where it would sit on the wrong baseline.`}
            </Text>
          ) : null}
          {averageShort ? (
            <Text variant="note" tone="muted">
              {`The ${String(AVERAGE_SPAN)}-period average needs at least ${String(AVERAGE_SPAN)} periods; this chart has ${String(chart.buckets.length)}.`}
            </Text>
          ) : null}
          <LineChart
            series={series}
            area={kind === 'area'}
            stacked={stacked}
            averages={averages}
            {...axis}
          />
          {table}
        </div>
      );

    case 'pie':
      return <PieWithTable chart={chart} labels={labels} rowHeader={rowHeader} />;

    case 'year': {
      const unit = totals ? labels.property(chart.measureProperty) || 'total' : 'items';
      const cells = chart.buckets.map((bucket) => {
        const value = measureOf(bucket, totals);
        return {
          date: bucket.value ?? '',
          value,
          label: `${bucketLabel(bucket.value, 'day')}: ${totals ? `${formatMeasure(value)} ${unit}` : countOf(value, 'item')}`,
        };
      });
      return (
        <div className="flex flex-col gap-3">
          <YearGrid cells={cells} label={caption} unit={unit} />
          <details>
            <summary
              className={cn(
                'cursor-pointer rounded-sm py-1 any-pointer-coarse:min-h-(--control-lg)',
                focusRing,
              )}
            >
              <Text as="span" variant="bodySmall">
                Every day as a table
              </Text>
            </summary>
            {table}
          </details>
        </div>
      );
    }
  }
}
