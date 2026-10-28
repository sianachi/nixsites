import { render, screen, waitFor, within } from '@testing-library/react';
import { createNixClient, itemChartSchema, NixApiError } from '@nix/api-client';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { ChartView } from '../../../views/chart/chart-view';
import { aContainer } from '../../container-fixture';
import { aView } from '../../view-fixture';

/**
 * The chart view: bars over every child, not over the loaded page.
 *
 * The assertions that matter are the honest-state ones. A chart is a summary, and a summary that
 * quietly leaves something out is worse than no summary: the unset bucket has to be drawn, a
 * truncated chart has to say so, and the numbers have to be readable as text rather than only as
 * lengths.
 */

const query = vi.hoisted(() => vi.fn());

// One client for the whole run, as the provider gives in the app: a new object per render would
// make every render look like a new client and read the chart again.
const client = vi.hoisted((): { current: unknown } => ({ current: null }));
const cache = createNixClient({
  baseUrl: 'http://localhost',
  tokens: {
    getAccessToken: () => Promise.resolve(null),
    refreshAccessToken: () => Promise.resolve(null),
  },
}).cache;

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => (client.current ??= { query, cache }),
}));

function chartOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: '11111111-1111-4111-8111-111111111111',
    viewId: 'v1',
    groupBy: 'status',
    measure: 'count',
    measureProperty: null,
    buckets: [
      { value: 'Todo', children: 6, total: null },
      { value: 'Done', children: 3, total: null },
      { value: null, children: 1, total: null },
    ],
    children: 10,
    distinctValues: 3,
    truncated: false,
    ...over,
  };
}

function answer(body: unknown, ok = true, status = 200): void {
  if (ok) {
    // Parsed as the real client parses it, so the defaults a server from before chart types omits
    // are filled exactly as they are in production.
    query.mockResolvedValue(itemChartSchema.parse(body));
    return;
  }

  query.mockRejectedValue(
    status === 404
      ? NixApiError.fromStatus(status)
      : NixApiError.fromProblemDetails(status, body as { code: string }),
  );
}

function renderChart(): void {
  render(
    <ChartView
      container={aContainer({ itemId: '11111111-1111-4111-8111-111111111111' })}
      view={aView({ id: 'v1', kind: 'chart', groupBy: 'status' })}
      onOpen={vi.fn()}
    />,
  );
}

beforeEach(() => {
  query.mockReset();
  answer(chartOf());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the chart view', () => {
  it('draws a row per bucket with the figure as text', async () => {
    renderChart();

    const todo = await screen.findByRole('row', { name: /todo/i });
    expect(within(todo).getByText('6')).toBeVisible();
  });

  it('draws the children with no value as their own bucket', async () => {
    // A container half of whose children have no status is mostly a container of unset things.
    // Dropping that bucket would misreport every proportion drawn beside it.
    renderChart();

    const unset = await screen.findByRole('row', { name: /unset/i });
    expect(within(unset).getByText('1')).toBeVisible();
  });

  it('says how many items it summarised, so the figures have a denominator', async () => {
    renderChart();

    expect(await screen.findByText(/Counted across all 10 items inside this one/)).toBeVisible();
  });

  it('says so when more groups exist than it drew', async () => {
    answer(chartOf({ truncated: true, distinctValues: 42 }));
    renderChart();

    expect(await screen.findByText(/largest 3 of 42 groups/i)).toBeVisible();
  });

  it('says a container with nothing in it has nothing to summarise', async () => {
    answer(chartOf({ buckets: [], children: 0, distinctValues: 0 }));
    renderChart();

    expect(await screen.findByText(/Nothing to summarise yet/i)).toBeVisible();
  });

  it('says an unfinished chart is unfinished rather than drawing nothing', async () => {
    // An empty chart sends somebody looking for their missing items; the refusal sends them to the
    // configuration that is actually incomplete.
    answer({ code: 'chart.not_configured' }, false, 422);
    renderChart();

    expect(await screen.findByText(/needs a property to group by/i)).toBeVisible();
  });

  it('offers a retry when the chart could not be read at all', async () => {
    answer({ code: 'items.not_found' }, false, 404);
    renderChart();

    expect(await screen.findByRole('button', { name: /try again/i })).toBeVisible();
  });

  it('names the totalled property when the bars total one', async () => {
    answer(
      chartOf({
        measure: 'sum',
        measureProperty: 'estimate',
        buckets: [{ value: 'Todo', children: 6, total: 18 }],
        distinctValues: 1,
      }),
    );
    renderChart();

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: 'estimate' })).toBeVisible();
    });
    expect(screen.getByText('18')).toBeVisible();
  });

  it('names the items a time axis could not place rather than dropping them', async () => {
    answer(
      chartOf({
        chartKind: 'line',
        period: 'month',
        buckets: [
          { value: '2026-01-01', children: 2, total: null },
          { value: '2026-02-01', children: 0, total: null },
        ],
        children: 2,
        distinctValues: 2,
        unplaced: 3,
      }),
    );
    renderChart();

    expect(await screen.findByText(/3 items have no date in "status"/)).toBeVisible();
  });

  it('says how many series values were folded into Other', async () => {
    answer(
      chartOf({
        chartKind: 'column',
        splitBy: 'owner',
        buckets: [
          {
            value: 'Todo',
            children: 6,
            total: null,
            cells: [
              { children: 4, total: null },
              { children: 2, total: null },
            ],
          },
        ],
        series: [
          { value: 'Ada', other: false, children: 4, total: null },
          { value: null, other: true, children: 2, total: null },
        ],
        otherSeries: 5,
        children: 6,
        distinctValues: 1,
      }),
    );
    renderChart();

    expect(await screen.findByText(/the other 5 share one series, Other/)).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Other (5 values)' })).toBeVisible();
  });

  it('reads the chart again past the cache when its saved configuration changes', async () => {
    const container = aContainer({ itemId: '11111111-1111-4111-8111-111111111111' });
    const before = aView({ id: 'v1', kind: 'chart', groupBy: 'status' });
    const { rerender } = render(<ChartView container={container} view={before} onOpen={vi.fn()} />);
    await screen.findByRole('row', { name: /todo/i });

    answer(chartOf({ chartKind: 'pie' }));
    rerender(
      <ChartView
        container={container}
        view={{
          ...before,
          chart: {
            kind: 'pie',
            period: null,
            splitBy: null,
            lastPeriods: null,
            from: null,
            to: null,
            cumulative: null,
            rollingAverage: null,
            stacked: null,
          },
        }}
        onOpen={vi.fn()}
      />,
    );

    expect(await screen.findByRole('columnheader', { name: 'Share (%)' })).toBeVisible();
    expect(query).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ forceRefresh: true }),
    );
  });

  it('points an unfinished chart at its settings instead of offering a retry', async () => {
    answer({ code: 'chart.not_configured' }, false, 422);
    renderChart();

    expect(await screen.findByText(/Finish it in the settings for this view/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });
});
