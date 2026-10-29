import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import { SelectionBar } from '../../../core/selection-bar';

it('draws nothing while nothing is selected', () => {
  render(<SelectionBar count={0} onClear={vi.fn()} />);
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
});

it('reads count, Select all, Move, Delete, the view actions, then Clear with its Esc hint', () => {
  render(
    <SelectionBar
      count={3}
      shownCount={42}
      onSelectAll={vi.fn()}
      onMove={vi.fn()}
      onDelete={vi.fn()}
      onClear={vi.fn()}
    >
      <button type="button">Archive</button>
    </SelectionBar>,
  );
  const bar = screen.getByRole('toolbar', { name: 'Selected items' });
  expect(
    within(bar)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Select all 42', 'Move to…', 'Delete', 'Archive', 'ClearEsc']);
  expect(within(bar).getByText('3 selected')).toHaveAttribute('aria-live', 'polite');
  expect(within(bar).getByRole('button', { name: 'Clear' })).toBeVisible();
});

it('offers Select all only when something shown is still unselected', () => {
  const { rerender } = render(
    <SelectionBar count={42} shownCount={42} onSelectAll={vi.fn()} onClear={vi.fn()} />,
  );
  expect(screen.queryByRole('button', { name: /^Select all/ })).not.toBeInTheDocument();
  rerender(<SelectionBar count={1} shownCount={42} onSelectAll={vi.fn()} onClear={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Select all 42' })).toBeVisible();
});

it('walks its buttons with the arrow keys and never takes focus when it opens', async () => {
  const user = userEvent.setup();
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  render(<SelectionBar count={2} onMove={vi.fn()} onClear={vi.fn()} />);
  expect(outside).toHaveFocus();
  outside.remove();

  screen.getByRole('button', { name: 'Move to…' }).focus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('button', { name: 'Clear' })).toHaveFocus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('button', { name: 'Move to…' })).toHaveFocus();
  await user.keyboard('{End}');
  expect(screen.getByRole('button', { name: 'Clear' })).toHaveFocus();
});

it('draws in place, with the same copy, in its compact variant', async () => {
  const user = userEvent.setup();
  const onClear = vi.fn();
  render(<SelectionBar compact count={1} shownCount={5} onSelectAll={vi.fn()} onClear={onClear} />);
  expect(screen.getByText('1 selected')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Select all 5' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Clear' }));
  expect(onClear).toHaveBeenCalled();
});

it('drops the Esc key cap on a coarse pointer', () => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: query.includes('coarse'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
  try {
    render(<SelectionBar count={1} onClear={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveTextContent(/^Clear$/);
  } finally {
    globalThis.matchMedia = previous;
  }
});
