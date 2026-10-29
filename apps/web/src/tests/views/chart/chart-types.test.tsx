import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChartBody } from '@nix/web-views/chart/chart-view';
import { aChart, aSplitChart, aTimeChart, aYearChart } from './chart-fixtures';

/**
 * Every chart type is also a table.
 *
 * The drawings are decoration: these assertions are about the figures being in the markup as text,
 * which is what a screen reader reads and what a copy carries, whatever the drawing looks like.
 */
describe('every chart type', () => {
  it.each(['column', 'pie', 'line', 'area'])(
    'draws a %s chart above a table holding every figure',
    (chartKind) => {
      const { container } = render(<ChartBody chart={aChart({ chartKind })} />);

      const table = screen.getByRole('table');
      expect(within(table).getByRole('row', { name: /todo/i })).toHaveTextContent('6');
      expect(within(table).getByRole('row', { name: /unset/i })).toHaveTextContent('1');

      // The drawing is there, and it is hidden from assistive technology.
      const drawing = container.querySelector('svg');
      expect(drawing).not.toBeNull();
      expect(drawing?.closest('[aria-hidden="true"]')).not.toBeNull();
    },
  );

  it('draws a type this build does not know as bars rather than nothing', () => {
    render(<ChartBody chart={aChart({ chartKind: 'radar' })} />);

    expect(screen.getByRole('row', { name: /todo/i })).toHaveTextContent('6');
  });

  it('gives a pie each slice its share as text', () => {
    render(<ChartBody chart={aChart({ chartKind: 'pie' })} />);

    expect(screen.getByRole('columnheader', { name: 'Share (%)' })).toBeVisible();
    expect(screen.getByRole('row', { name: /todo/i })).toHaveTextContent('60');
  });

  it('labels a time axis by its periods, earliest first', () => {
    render(<ChartBody chart={aTimeChart()} />);

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toHaveTextContent(/Jan 2026/);
    expect(rows[2]).toHaveTextContent('0');
  });

  it('puts the running total and the trailing average in the table when they are drawn', () => {
    render(<ChartBody chart={aTimeChart({ cumulative: true, rollingAverage: true })} />);

    expect(screen.getByRole('columnheader', { name: 'Items (running total)' })).toBeVisible();
    expect(
      screen.getByRole('columnheader', { name: 'Items (running total) (7-period average)' }),
    ).toBeVisible();
    // 1 + 2 + 0 + 4 + 5 + 3 + 2 + 6 + 1 + 0 + 4 + 2 = 30, the last running total.
    expect(screen.getAllByRole('row').at(-1)).toHaveTextContent('30');
  });

  it('ignores the line toggles on a type that has no line', () => {
    render(
      <ChartBody
        chart={aTimeChart({ chartKind: 'column', cumulative: true, rollingAverage: true })}
      />,
    );

    expect(screen.queryByRole('columnheader', { name: /running total/ })).toBeNull();
  });

  it('gives each series a column and a legend entry', () => {
    render(<ChartBody chart={aSplitChart()} />);

    expect(screen.getByRole('columnheader', { name: 'Ada' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'All' })).toBeVisible();
    expect(screen.getByRole('list')).toHaveTextContent('Ada');

    const todo = screen.getByRole('row', { name: /todo/i });
    expect(
      within(todo)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['4', '2', '6']);
  });

  it('names properties and checkbox values by their labels, not their keys', () => {
    render(
      <ChartBody
        chart={aSplitChart({
          splitBy: 'urgent',
          series: [
            { value: 'true', other: false, children: 5, total: null },
            { value: 'false', other: false, children: 4, total: null },
          ],
        })}
        fields={
          [
            { key: 'status', label: 'Stage', type: 'select', options: [], required: false },
            { key: 'urgent', label: 'Urgent', type: 'checkbox', options: [], required: false },
          ] as never
        }
      />,
    );

    expect(screen.getByRole('heading', { name: /by Stage, split by Urgent/ })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Checked' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Not checked' })).toBeVisible();
  });

  it('splits the bars of a bar chart into series with their own figures', () => {
    render(<ChartBody chart={aSplitChart({ chartKind: 'bar' })} />);

    const done = screen.getByRole('row', { name: /done/i });
    expect(
      within(done)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['1', '2', '3']);
  });

  it('draws a year grid whose days are named by their values, with the table behind a disclosure', () => {
    render(<ChartBody chart={aYearChart()} />);

    const grid = screen.getByRole('grid', { name: /how many items per day/i });
    const days = within(grid)
      .getAllByRole('gridcell')
      .filter((cell) => cell.getAttribute('aria-label') !== null);
    expect(days).toHaveLength(371);
    const firstDay = new Date('2025-10-06T00:00:00Z').toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    expect(within(grid).getByRole('gridcell', { name: `${firstDay}: 1 item` })).toBeVisible();
    expect(screen.getByText('Every day as a table')).toBeVisible();
  });

  it('names the window and what fell outside it when nothing falls inside', () => {
    render(
      <ChartBody
        chart={aTimeChart({
          buckets: [],
          children: 0,
          distinctValues: 0,
          from: '2025-10-06',
          to: '2026-10-09',
          outsideWindow: 14,
          unplaced: 2,
        })}
      />,
    );

    expect(screen.queryByText(/Nothing to summarise yet/)).toBeNull();
    expect(screen.getByText(/^Nothing between .+2025 and .+2026\.$/)).toBeVisible();
    expect(screen.getByText('14 items fall outside these dates.')).toBeVisible();
    expect(screen.getByText(/2 items have no date/)).toBeVisible();
  });

  it('sorts pie slices by value and folds the smallest past six into one Other slice', () => {
    const buckets = [1, 9, 3, 7, 2, 8, 5, 4].map((children, index) => ({
      value: `v${String(index)}`,
      children,
      total: null,
    }));
    render(
      <ChartBody chart={aChart({ chartKind: 'pie', buckets, children: 39, distinctValues: 8 })} />,
    );

    const legend = screen.getByRole('list');
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['v1', 'v5', 'v3', 'v6', 'v7', 'v2', 'Other (2 values)']);
    // The table still names every bucket.
    expect(screen.getAllByRole('row')).toHaveLength(9);
  });

  it('says the trailing average needs seven periods rather than drawing a shorter one', () => {
    render(
      <ChartBody
        chart={aTimeChart({
          buckets: [
            { value: '2026-01-01', children: 1, total: null },
            { value: '2026-02-01', children: 2, total: null },
          ],
          distinctValues: 2,
          children: 3,
          rollingAverage: true,
        })}
      />,
    );

    expect(screen.getByText(/needs at least 7 periods; this chart has 2/)).toBeVisible();
    expect(screen.queryByRole('columnheader', { name: /average/ })).toBeNull();
  });
});
