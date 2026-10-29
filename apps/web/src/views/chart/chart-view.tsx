import type { ItemChart } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
} from '@nix/web-foundation/components/states/status-panels';
import type { PropertyDefinition } from '../../collections/core/container-model';
import type { ViewRendererProps } from '../core/view-kinds';
import { Drawing } from './chart-drawing';
import {
  chartCaption,
  chartKindOf,
  chartLabels,
  countOf,
  formatDay,
  isChartPeriod,
} from './chart-model';
import { Notices } from './chart-notices';
import { useChart } from './use-chart';

/**
 * The chart view: a container's children summarised into bars, columns, a pie, lines, areas or a
 * year grid.
 *
 * **The third kind whose data is not the loaded children.** Its buckets come from
 * `GET /items/{id}/chart`, computed over every child rather than over the page the container
 * happens to hold - a chart tallied in the browser from the first two hundred of three thousand
 * would be a picture of the first page presented as a picture of the whole. `container.children` is
 * deliberately ignored, and so is `useViewChrome`, whose filter and sort branches are statements
 * about children this view does not draw.
 *
 * **One source for every option.** The chart's type, period, split, window and line options are all
 * read from the server's payload - the stored configuration the buckets were computed from - never
 * mixed with the client's copy of the view, which may already be newer. A change to the stored view
 * changes its fingerprint, and the chart is read again.
 *
 * **Every type is a table that happens to be drawn.** The numbers are text in the markup and the
 * drawing is `aria-hidden` decoration over them, so a screen reader gets the figures rather than a
 * description of a picture, and a copy-paste gets data. Bars keep the oldest form of that rule - the
 * bar sits behind its own row - and every other type draws above a table of the same figures. The
 * year grid's days carry their sentences, with the full table behind a disclosure because a year of
 * days is a long table.
 *
 * **Unset is a bar, and undated and out-of-window are said.** A container half of whose children
 * have no status is mostly a container of unset things, and dropping that bucket would misreport
 * every proportion beside it. On a time axis an item with no date, or one outside the window, has
 * no period to sit in, so it is counted and the chart says how many rather than quietly shrinking.
 */
export function ChartView(props: ViewRendererProps): ReactNode {
  const { container, view } = props;
  const fields = container.schema?.properties ?? [];

  // What the stored configuration is, so a saved change is read again rather than left drawn.
  const fingerprint = JSON.stringify([
    view.groupBy,
    view.measure ?? null,
    view.measureProperty ?? null,
    view.chart ?? null,
  ]);
  const run = useChart(container.itemId ?? '', view.id, fingerprint);

  if (run.status === 'loading') {
    return <LoadingPanel label="this chart" />;
  }

  if (run.status === 'error' || run.chart === null) {
    // Retrying cannot finish a configuration or unlock an item, so only a failure that a second
    // attempt could fix offers one.
    const retryable = run.failure === 'unavailable' || run.failure === null;
    return (
      <ErrorPanel
        title="This chart could not be drawn"
        detail={run.error ?? 'The chart could not be read.'}
        action={
          retryable ? (
            <Button
              variant="secondary"
              onClick={() => {
                void run.reload();
              }}
            >
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  }

  return <ChartBody chart={run.chart} fields={fields} />;
}

export interface ChartBodyProps {
  readonly chart: ItemChart;
  /** The container's property definitions, which name the keys and values the payload carries. */
  readonly fields?: readonly PropertyDefinition[] | undefined;
}

/**
 * A loaded chart, drawn as its type says. Separate from {@link ChartView} so stories and tests can
 * hand it a payload without a server.
 */
export function ChartBody({ chart, fields = [] }: ChartBodyProps): ReactNode {
  const labels = chartLabels(fields);
  const kind = chartKindOf(chart.chartKind);
  const timeAxis = isChartPeriod(chart.period);
  const caption = chartCaption(chart, labels);

  if (
    chart.buckets.length === 0 &&
    chart.children === 0 &&
    chart.unplaced === 0 &&
    chart.outsideWindow === 0
  ) {
    return (
      <EmptyPanel
        title="Nothing to summarise yet"
        detail={`This chart groups the items inside this one by "${labels.property(chart.groupBy)}". Add some and it fills in.`}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Text as="h3" variant="h6">
        {caption}
      </Text>

      <Notices chart={chart} labels={labels} />

      {chart.buckets.length === 0 ? (
        <Text variant="bodySmall" tone="muted">
          {timeAxis && chart.from !== null && chart.to !== null
            ? `Nothing between ${formatDay(chart.from)} and ${formatDay(chart.to)}.`
            : timeAxis && chart.from !== null
              ? `Nothing since ${formatDay(chart.from)}.`
              : 'There is nothing to draw.'}
        </Text>
      ) : (
        <Drawing chart={chart} kind={kind} labels={labels} caption={caption} />
      )}

      <Text variant="note" tone="muted">
        {`${chart.measure === 'sum' ? 'Totalled' : 'Counted'} across ${chart.children === 1 ? 'the 1 item' : `all ${countOf(chart.children, 'item')}`} inside this one${timeAxis ? ' that fall in these periods' : ''}.`}
      </Text>
    </div>
  );
}
