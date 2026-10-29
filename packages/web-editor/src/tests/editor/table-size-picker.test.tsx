import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  MAX_PICKER_COLUMNS,
  MAX_PICKER_ROWS,
  TableSizePicker,
} from '../../editor/table-size-picker';

/**
 * The table size picker: a grid to sweep, with a keyboard that does the same.
 */

describe('the table size picker', () => {
  it('opens on the three-by-three the fixed insert used to make', () => {
    render(<TableSizePicker onPick={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByRole('button', { name: '3 by 3 table' })).toHaveFocus();
    expect(screen.getByText('3 rows × 3 columns')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(MAX_PICKER_ROWS * MAX_PICKER_COLUMNS);
  });

  it('reads the size out as the arrows move, and picks on Enter', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<TableSizePicker onPick={onPick} onDismiss={vi.fn()} />);

    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowDown}');
    expect(screen.getByText('4 rows × 5 columns')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4 by 5 table' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith({ rows: 4, cols: 5 });
  });

  it('stops at the edges of the grid', async () => {
    const user = userEvent.setup();
    render(<TableSizePicker onPick={vi.fn()} onDismiss={vi.fn()} />);

    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    expect(screen.getByText('1 rows × 1 columns')).toBeInTheDocument();

    for (let index = 0; index < MAX_PICKER_COLUMNS + 2; index += 1) {
      await user.keyboard('{ArrowRight}');
    }
    expect(screen.getByText(`1 rows × ${String(MAX_PICKER_COLUMNS)} columns`)).toBeInTheDocument();
  });

  it('follows the pointer without taking the focus, and picks on click', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<TableSizePicker onPick={onPick} onDismiss={vi.fn()} />);

    await user.hover(screen.getByRole('button', { name: '2 by 6 table' }));
    expect(screen.getByText('2 rows × 6 columns')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3 by 3 table' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: '2 by 6 table' }));
    expect(onPick).toHaveBeenCalledWith({ rows: 2, cols: 6 });
  });

  it('dismisses on Escape', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<TableSizePicker onPick={vi.fn()} onDismiss={onDismiss} />);

    await user.keyboard('{Escape}');
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
