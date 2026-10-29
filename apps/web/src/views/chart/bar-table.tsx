import type { ItemChart } from '@nix/api-client';
import { Text, cn, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

import { UNSET_LABEL } from '../../collections/core/container-model';
import { bucketKey, formatMeasure, measureOf, type PlottedSeries } from './chart-model';
import { ChartLegend } from './svg-charts';

/**
 * Horizontal bars: the table itself, with each row's bar drawn behind its label.
 *
 * The bar sits behind the label rather than in a column of its own: it is the same information drawn
 * twice, and a second column would make a reader check which one to believe. Split into series, the
 * bar is stacked from the series' segments at a quarter strength, so a label over it keeps its full
 * contrast, and each series gets its own column of figures. Labels are always in the default tone;
 * an unset bucket says so in words.
 */
export function BarTable({
  chart,
  caption,
  rowHeader,
  rows,
  series,
}: {
  readonly chart: ItemChart;
  readonly caption: string;
  readonly rowHeader: string;
  readonly rows: readonly { readonly key: string; readonly label: string }[];
  readonly series: readonly PlottedSeries[];
}): ReactNode {
  const totals = chart.measure === 'sum';
  const split = chart.series.length > 0;
  const largest = chart.buckets.reduce(
    (most, bucket) => Math.max(most, measureOf(bucket, totals)),
    0,
  );

  return (
    <div className="flex flex-col gap-3">
      {split ? <ChartLegend entries={series} lines={false} /> : null}
      <div
        role="region"
        aria-label={caption}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: a scrollable region needs a tab stop or its content cannot be scrolled without a pointer.
        tabIndex={0}
        className={cn('min-w-0 max-w-full overflow-x-auto rounded-sm', focusRing)}
      >
        <table className="w-full border-collapse">
          <caption className="sr-only">{caption}</caption>

          <thead>
            <tr>
              <th scope="col" className="p-1 text-left font-normal">
                <Text variant="note" tone="muted" as="span">
                  {rowHeader}
                </Text>
              </th>
              {split
                ? series.map((entry) => (
                    <th key={entry.key} scope="col" className="p-1 text-right font-normal">
                      <Text variant="note" tone="muted" as="span" className="whitespace-nowrap">
                        {entry.label}
                      </Text>
                    </th>
                  ))
                : null}
              <th scope="col" className="p-1 text-right font-normal">
                <Text variant="note" tone="muted" as="span">
                  {split ? 'All' : series[0]?.label}
                </Text>
              </th>
            </tr>
          </thead>

          <tbody>
            {chart.buckets.map((bucket, index) => {
              const measured = measureOf(bucket, totals);
              const label = rows[index]?.label ?? '';
              return (
                <tr key={bucketKey(bucket)} className="border-b border-divider">
                  <th scope="row" className="w-full p-1 text-left font-normal">
                    <span className="relative block">
                      <span aria-hidden="true" className="absolute inset-y-0 left-0 flex w-full">
                        {split ? (
                          series.map((entry) => (
                            <span
                              key={entry.key}
                              className={cn(
                                'h-full opacity-25 first:rounded-l-sm',
                                entry.style.fill,
                              )}
                              style={{ width: share(entry.values[index] ?? 0, largest) }} // design-token-exempt: a segment's length is the datum - this series' share of the largest bar - not a dimension anybody chose.
                            />
                          ))
                        ) : (
                          <span
                            className="h-full rounded-sm bg-accent/18"
                            style={{ width: share(measured, largest) }} // design-token-exempt: a bar's length is the datum - this bucket's share of the largest - not a dimension anybody chose, and no step on any scale could express it. The same case as a pane's share.
                          />
                        )}
                      </span>
                      <Text as="span" variant="bodySmall" className="relative px-2 py-1">
                        {bucket.value === null ? `${UNSET_LABEL} (no value)` : label}
                      </Text>
                    </span>
                  </th>

                  {split
                    ? series.map((entry) => (
                        <td key={entry.key} className="whitespace-nowrap p-1 text-right">
                          <Text as="span" variant="bodySmall">
                            {formatMeasure(entry.values[index] ?? 0)}
                          </Text>
                        </td>
                      ))
                    : null}

                  <td className="whitespace-nowrap p-1 text-right">
                    <Text as="span" variant="bodySmall">
                      {formatMeasure(measured)}
                    </Text>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function share(value: number, largest: number): string {
  return `${String(largest <= 0 ? 0 : (Math.max(0, value) / largest) * 100)}%`;
}
