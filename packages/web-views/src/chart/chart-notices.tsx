import type { ItemChart } from '@nix/api-client';
import type { ReactNode } from 'react';

import { PartialNotice } from '@nix/web-foundation/components/states/status-panels';
import { countOf, isChartPeriod, MAXIMUM_SERIES, type ChartLabels } from './chart-model';

/** Everything the chart cannot show, said before it is drawn. */
export function Notices({
  chart,
  labels,
}: {
  readonly chart: ItemChart;
  readonly labels: ChartLabels;
}): ReactNode {
  const timeAxis = isChartPeriod(chart.period);
  const notices: string[] = [];
  const groupBy = labels.property(chart.groupBy);

  if (chart.truncated) {
    notices.push(
      timeAxis
        ? chart.buckets.length === 0
          ? 'This chart has more entries than it can read at once, and the latest it read had no date.'
          : `This chart shows the latest ${String(chart.buckets.length)} of ${String(chart.distinctValues)} periods. Earlier ones are not drawn.`
        : `This chart shows the largest ${String(chart.buckets.length)} of ${String(chart.distinctValues)} groups. The rest are not drawn.`,
    );
  }
  if (chart.outsideWindow > 0) {
    notices.push(
      `${countOf(chart.outsideWindow, 'item')} ${chart.outsideWindow === 1 ? 'falls' : 'fall'} outside these dates.`,
    );
  }
  if (chart.unplaced > 0) {
    notices.push(
      `${countOf(chart.unplaced, 'item')} ${chart.unplaced === 1 ? 'has' : 'have'} no date in "${groupBy}" and ${chart.unplaced === 1 ? 'is' : 'are'} not on this chart.`,
    );
  }
  if (chart.otherSeries > 0) {
    notices.push(
      `Only the ${String(MAXIMUM_SERIES)} largest values of "${labels.property(chart.splitBy)}" have their own series; the other ${String(chart.otherSeries)} share one series, Other.`,
    );
  }

  return notices.map((notice) => <PartialNotice key={notice} pending={notice} />);
}
