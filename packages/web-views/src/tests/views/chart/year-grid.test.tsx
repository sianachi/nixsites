import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { YearGrid, yearGridLevel, yearGridMove, type YearGridCell } from '../../../chart/year-grid';

function days(count: number, start = '2026-01-05'): YearGridCell[] {
  const first = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(first + index * 86_400_000).toISOString().slice(0, 10);
    const value = index % 4;
    return { date, value, label: `${date}: ${String(value)} times` };
  });
}

function nth(list: readonly HTMLElement[], index: number): HTMLElement {
  const element = list[index];
  if (element === undefined) {
    throw new Error(`No element ${String(index)}.`);
  }
  return element;
}

describe('the year grid', () => {
  it('shades in four steps of the largest value, with nothing as its own step', () => {
    expect(yearGridLevel(null, 8)).toBe(0);
    expect(yearGridLevel(0, 8)).toBe(0);
    expect(yearGridLevel(1, 8)).toBe(1);
    expect(yearGridLevel(2, 8)).toBe(1);
    expect(yearGridLevel(3, 8)).toBe(2);
    expect(yearGridLevel(6, 8)).toBe(3);
    expect(yearGridLevel(8, 8)).toBe(4);
    expect(yearGridLevel(5, 0)).toBe(0);
  });

  it('is a grid of seven weekday rows when there is nothing to choose', () => {
    render(<YearGrid cells={days(14)} label="Runs" unit="times" />);

    const grid = screen.getByRole('grid', { name: 'Runs' });
    const rows = within(grid).getAllByRole('row');
    expect(rows).toHaveLength(7);
    expect(within(nth(rows, 0)).getByRole('rowheader', { name: 'Monday' })).toBeInTheDocument();
    expect(within(grid).getByRole('gridcell', { name: '2026-01-06: 1 times' })).toBeVisible();
    // Nothing in a grid to read is a button that does nothing.
    expect(within(grid).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(/Four steps up to 3 times/)).toBeVisible();
  });

  it('keeps one tab stop, reads out the focused day, and moves by day and by week', () => {
    render(<YearGrid cells={days(30)} label="Runs" unit="times" />);

    const cells = within(screen.getByRole('grid', { name: 'Runs' }))
      .getAllByRole('gridcell')
      .filter((cell) => cell.getAttribute('aria-label') !== null);
    const byDate = (date: string) =>
      nth(
        cells.filter((cell) => cell.getAttribute('aria-label')?.startsWith(date) === true),
        0,
      );

    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
    expect(byDate('2026-02-03').tabIndex).toBe(0);

    fireEvent.focus(byDate('2026-01-05'));
    expect(screen.getByText('2026-01-05: 0 times')).toBeVisible();

    fireEvent.keyDown(byDate('2026-01-05'), { key: 'ArrowRight' });
    expect(byDate('2026-01-12')).toHaveFocus();
    expect(screen.getByText('2026-01-12: 3 times')).toBeVisible();

    fireEvent.keyDown(byDate('2026-01-12'), { key: 'ArrowDown' });
    expect(byDate('2026-01-13')).toHaveFocus();
  });

  it('moves left and right by week, stays put at an edge, and Home and End follow the row', () => {
    // 30 days from a Monday: indexes 0-29, offset 0.
    expect(yearGridMove('ArrowLeft', 3, 30, 0, false)).toBeNull();
    expect(yearGridMove('ArrowRight', 27, 30, 0, false)).toBeNull();
    expect(yearGridMove('ArrowRight', 3, 30, 0, false)).toBe(10);
    expect(yearGridMove('ArrowUp', 7, 30, 0, false)).toBe(6);
    expect(yearGridMove('Home', 24, 30, 0, false)).toBe(3);
    expect(yearGridMove('End', 3, 30, 0, false)).toBe(24);
    expect(yearGridMove('Home', 24, 30, 0, true)).toBe(0);
    expect(yearGridMove('End', 3, 30, 0, true)).toBe(29);
    // Starting on a Wednesday: Monday's row begins at the first Monday, index 5.
    expect(yearGridMove('Home', 12, 30, 2, false)).toBe(5);
  });

  it('starts its first column on the right weekday', () => {
    // 2026-01-07 is a Wednesday: Monday and Tuesday of that week are empty cells.
    render(<YearGrid cells={days(3, '2026-01-07')} label="Runs" unit="times" />);

    const rows = within(screen.getByRole('grid', { name: 'Runs' })).getAllByRole('row');
    const monday = within(nth(rows, 0)).getAllByRole('gridcell');
    expect(monday[0]).not.toHaveAttribute('aria-label');
    expect(within(nth(rows, 2)).getByRole('gridcell', { name: /2026-01-07/ })).toBeVisible();
  });

  it('makes each day a button only when a day can be chosen', () => {
    const onSelect = vi.fn();
    render(
      <YearGrid
        cells={days(7)}
        label="Runs"
        unit="times"
        onSelect={onSelect}
        selected="2026-01-06"
      />,
    );

    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.getByRole('button', { name: '2026-01-06: 1 times' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: '2026-01-08: 3 times' }));
    expect(onSelect).toHaveBeenCalledWith('2026-01-08');
  });
});
