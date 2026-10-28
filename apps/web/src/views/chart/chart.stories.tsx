import {
  createNixClient,
  itemChartSchema,
  NixApiError,
  type ItemChart,
  type NixClient,
  type QueryEndpoint,
} from '@nix/api-client';
import { useState, type ReactElement } from 'react';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import type { PropertyDefinition, View } from '../core/container-model';
import type { ContainerData } from '../core/use-container';
import { StructuredViewConfiguration } from '../core/structured-view-configuration';
import { ChartBody, ChartView } from './chart-view';

/**
 * Every chart type, on both grounds and at phone width.
 *
 * Fixtures go through the client's own schema, so a story renders exactly the shape a server
 * response parses to. The year grid is fixed to a known year so the story does not drift.
 */

function chart(over: Record<string, unknown>): ItemChart {
  return itemChartSchema.parse({
    itemId: '11111111-1111-4111-8111-111111111111',
    viewId: 'chart',
    groupBy: 'Status',
    measure: 'count',
    measureProperty: null,
    buckets: [
      { value: 'Todo', children: 14, total: null },
      { value: 'Doing', children: 6, total: null },
      { value: 'Done', children: 23, total: null },
      { value: null, children: 3, total: null },
    ],
    children: 46,
    distinctValues: 4,
    truncated: false,
    ...over,
  });
}

const MONTH_VALUES = [4, 7, 3, 9, 12, 8, 5, 11, 14, 9, 6, 10];
const OWNERS = ['Ada', 'Grace', 'Linus'];

function months(values: readonly number[]): { value: string; children: number; total: null }[] {
  return values.map((children, index) => ({
    value: `2026-${String(index + 1).padStart(2, '0')}-01`,
    children,
    total: null,
  }));
}

const timeChart = (kind: string) =>
  chart({
    groupBy: 'Done on',
    chartKind: kind,
    period: 'month',
    from: '2026-01-01',
    to: '2026-12-31',
    buckets: months(MONTH_VALUES),
    children: MONTH_VALUES.reduce((sum, value) => sum + value, 0),
    distinctValues: 12,
    unplaced: 2,
  });

const PALETTE_OWNERS = ['Ada', 'Grace', 'Linus', 'Margaret', 'Alan', 'Barbara'];

const splitChart = (
  kind: string,
  owners: readonly string[] = OWNERS,
  over: Record<string, unknown> = {},
) => {
  const buckets = months(MONTH_VALUES).map((bucket, index) => {
    const cells = owners.map((_, owner) => ({
      children: Math.max(0, Math.round(bucket.children / 3) + ((index + owner) % 3) - 1),
      total: null,
    }));
    return { ...bucket, children: cells.reduce((sum, cell) => sum + cell.children, 0), cells };
  });
  return chart({
    groupBy: 'Done on',
    chartKind: kind,
    period: 'month',
    splitBy: 'Owner',
    from: '2026-01-01',
    to: '2026-12-31',
    buckets,
    series: owners.map((value, owner) => ({
      value: value === 'Other' ? null : value,
      other: value === 'Other',
      children: buckets.reduce((sum, bucket) => sum + (bucket.cells[owner]?.children ?? 0), 0),
      total: null,
    })),
    children: buckets.reduce((sum, bucket) => sum + bucket.children, 0),
    distinctValues: 12,
    ...over,
  });
};

const yearChart = (() => {
  const start = Date.UTC(2025, 9, 6);
  const buckets = Array.from({ length: 371 }, (_, index) => ({
    value: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    children: (index * 7) % 5 === 0 ? 0 : ((index * 13) % 6) + (index % 7 === 5 ? 0 : 1),
    total: null,
  }));
  return chart({
    groupBy: 'Done on',
    chartKind: 'year',
    period: 'day',
    from: buckets[0]?.value,
    to: buckets.at(-1)?.value,
    buckets,
    children: buckets.reduce((sum, bucket) => sum + bucket.children, 0),
    distinctValues: 371,
  });
})();

function Stage({
  children,
  narrow = false,
}: {
  readonly children: ReactElement;
  readonly narrow?: boolean;
}): ReactElement {
  return (
    <div className={narrow ? 'w-full max-w-sm p-4' : 'mx-auto w-full max-w-4xl p-6'}>
      {children}
    </div>
  );
}

const dark = { globals: { ground: 'dark' } };

export default { title: 'Nix/Charts', parameters: { layout: 'padded' } };

export const Bars = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={chart({})} />
    </Stage>
  ),
};
export const BarsDark = { ...Bars, ...dark };

export const Columns = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={timeChart('column')} />
    </Stage>
  ),
};
export const ColumnsDark = { ...Columns, ...dark };

export const StackedColumns = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={{ ...splitChart('column'), stacked: true }} />
    </Stage>
  ),
};
export const StackedColumnsDark = { ...StackedColumns, ...dark };
export const LongSeriesLabels = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody
        chart={splitChart('column', [
          'PublishingTeamResponsibleForTheEditorialReview',
          'WaitingForTheEditorialReviewAndPublicationDecision',
        ])}
      />
    </Stage>
  ),
};

export const Pie = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={chart({ chartKind: 'pie' })} />
    </Stage>
  ),
};
export const PieDark = { ...Pie, ...dark };

export const LineWithDerivedLines = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={{ ...timeChart('line'), rollingAverage: true }} />
    </Stage>
  ),
};
export const LineWithDerivedLinesDark = { ...LineWithDerivedLines, ...dark };

export const RunningTotal = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={{ ...timeChart('line'), cumulative: true }} />
    </Stage>
  ),
};

export const MultiLine = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={splitChart('line')} />
    </Stage>
  ),
};
export const MultiLineDark = { ...MultiLine, ...dark };

export const StackedArea = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={{ ...splitChart('area'), stacked: true }} />
    </Stage>
  ),
};
export const StackedAreaDark = { ...StackedArea, ...dark };

export const YearGridChart = {
  name: 'Year grid',
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={yearChart} />
    </Stage>
  ),
};
export const YearGridChartDark = { ...YearGridChart, name: 'Year grid dark', ...dark };

export const PhoneWidth = {
  render: (): ReactElement => (
    <Stage narrow>
      <ChartBody chart={splitChart('column')} />
    </Stage>
  ),
};
export const PhoneWidthYearGrid = {
  render: (): ReactElement => (
    <Stage narrow>
      <ChartBody chart={yearChart} />
    </Stage>
  ),
};

const FIELDS = [
  { key: 'status', label: 'Status', type: 'select', options: ['Todo', 'Done'], required: false },
  { key: 'done_on', label: 'Done on', type: 'date', options: [], required: false },
  { key: 'owner', label: 'Owner', type: 'select', options: OWNERS, required: false },
] as PropertyDefinition[];

function EditorStory(): ReactElement {
  const [view, setView] = useState<View>({
    id: 'chart',
    name: 'Done per month',
    kind: 'chart',
    columns: [],
    groupBy: 'done_on',
    groupOrder: [],
    dateProperty: null,
    sortBy: null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    layout: null,
    filters: [],
    chart: {
      kind: 'line',
      period: 'month',
      splitBy: null,
      lastPeriods: 12,
      from: null,
      to: null,
      cumulative: null,
      rollingAverage: true,
      stacked: null,
    },
  });
  return (
    <Stage narrow>
      <div className="flex flex-col gap-3">
        <StructuredViewConfiguration
          view={view}
          fields={FIELDS}
          onChange={setView}
          showSort={false}
        />
      </div>
    </Stage>
  );
}

export const Options = { render: (): ReactElement => <EditorStory /> };
export const OptionsDark = { ...Options, ...dark };

const FULL_PALETTE = [...PALETTE_OWNERS, 'Other'];

export const SixSeriesAndOther = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={splitChart('column', FULL_PALETTE, { otherSeries: 9 })} />
    </Stage>
  ),
};
export const SixSeriesAndOtherDark = { ...SixSeriesAndOther, ...dark };

export const SixLines = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={splitChart('line', FULL_PALETTE, { otherSeries: 9 })} />
    </Stage>
  ),
};
export const SixLinesDark = { ...SixLines, ...dark };

const crowdedPie = chart({
  chartKind: 'pie',
  groupBy: 'Category',
  buckets: ['Food', 'Rent', 'Travel', 'Fun', 'Health', 'Books', 'Gifts', 'Tools', 'Garden'].map(
    (value, index) => ({ value, children: 20 - index * 2, total: null }),
  ),
  children: 108,
  distinctValues: 9,
});

export const PiePastTheCap = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={crowdedPie} />
    </Stage>
  ),
};
export const PiePastTheCapDark = { ...PiePastTheCap, ...dark };

const partial = chart({
  ...timeChart('column'),
  truncated: true,
  distinctValues: 40,
  unplaced: 3,
  outsideWindow: 5,
});

export const PartialNotices = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={partial} />
    </Stage>
  ),
};
export const PartialNoticesDark = { ...PartialNotices, ...dark };

const emptyWindow = chart({
  groupBy: 'Done on',
  chartKind: 'line',
  period: 'month',
  from: '2025-10-01',
  to: '2026-10-31',
  buckets: [],
  children: 0,
  distinctValues: 0,
  outsideWindow: 14,
});

export const WindowWithNothingInIt = {
  render: (): ReactElement => (
    <Stage>
      <ChartBody chart={emptyWindow} />
    </Stage>
  ),
};
export const WindowWithNothingInItDark = { ...WindowWithNothingInIt, ...dark };

/** A client whose chart read never settles, or refuses, so the view's own states show. */
function clientFor(outcome: 'loading' | 'error'): NixClient {
  return {
    ...createNixClient({
      baseUrl: 'http://nix.invalid',
      tokens: {
        getAccessToken: () => Promise.resolve(null),
        refreshAccessToken: () => Promise.resolve(null),
      },
    }),
    query<T>(endpoint: QueryEndpoint<T>): Promise<T> {
      void endpoint;
      return outcome === 'loading'
        ? new Promise<T>(() => undefined)
        : Promise.reject(NixApiError.fromStatus(503));
    },
  };
}

const storyContainer: Pick<ContainerData, 'itemId' | 'schema'> = {
  itemId: '11111111-1111-4111-8111-111111111111',
  schema: null,
};

function ViewStory({ outcome }: { readonly outcome: 'loading' | 'error' }): ReactElement {
  return (
    <ApiClientOverrideProvider client={clientFor(outcome)}>
      <Stage>
        <ChartView
          container={storyContainer as ContainerData}
          view={{ ...STORY_VIEW }}
          onOpen={() => undefined}
        />
      </Stage>
    </ApiClientOverrideProvider>
  );
}

const STORY_VIEW: View = {
  id: 'chart',
  name: 'Chart',
  kind: 'chart',
  columns: [],
  groupBy: 'status',
  groupOrder: [],
  dateProperty: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
  coverProperty: null,
  endDateProperty: null,
  cardSize: null,
  layout: null,
  filters: [],
};

export const Loading = { render: (): ReactElement => <ViewStory outcome="loading" /> };
export const LoadingDark = { ...Loading, ...dark };
export const Failed = { render: (): ReactElement => <ViewStory outcome="error" /> };
export const FailedDark = { ...Failed, ...dark };
