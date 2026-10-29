import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import { ContainerView } from '../../../views/core/container-view';
import { aContainer } from '../../container-fixture';
import { item } from '@nix/web-foundation/testing/api-stub';
import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { aView } from '../../view-fixture';

beforeEach(() => {
  stubViewport(true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

const rows = ['First', 'Second', 'Third', 'Fourth'].map((title, index) =>
  item({ id: `${String(index + 1).repeat(8)}-1111-4111-8111-aaaaaaaaaaaa`, title }),
);

function renderList(onOpen = vi.fn()): { readonly onOpen: ReturnType<typeof vi.fn> } {
  renderAt(
    <ContainerView
      container={aContainer({ children: rows })}
      view={aView({ kind: 'list' })}
      onOpen={onOpen}
    />,
  );
  return { onOpen };
}

const tray = (): HTMLElement => screen.getByRole('toolbar', { name: 'Selected items' });
const noTray = (): void => {
  expect(screen.queryByRole('toolbar', { name: 'Selected items' })).not.toBeInTheDocument();
};

it('opens on a plain click and toggles on a Ctrl-click, without opening', async () => {
  const user = userEvent.setup();
  const { onOpen } = renderList();
  await user.click(screen.getByRole('button', { name: 'First' }));
  expect(onOpen).toHaveBeenCalledWith(rows[0]?.id);
  noTray();

  onOpen.mockClear();
  await user.keyboard('{Control>}');
  await user.click(screen.getByRole('button', { name: 'Second' }));
  await user.keyboard('{/Control}');
  expect(onOpen).not.toHaveBeenCalled();
  expect(within(tray()).getByText('1 selected')).toBeVisible();
  expect(screen.getByRole('row', { name: /second/i })).toHaveAttribute('aria-selected', 'true');

  await user.keyboard('{Control>}');
  await user.click(screen.getByRole('button', { name: 'Second' }));
  await user.keyboard('{/Control}');
  noTray();
});

it('selects the range between two clicks with Shift-click', async () => {
  const user = userEvent.setup();
  renderList();
  await user.keyboard('{Control>}');
  await user.click(screen.getByRole('button', { name: 'First' }));
  await user.keyboard('{/Control}');
  await user.keyboard('{Shift>}');
  await user.click(screen.getByRole('button', { name: 'Third' }));
  await user.keyboard('{/Shift}');
  expect(within(tray()).getByText('3 selected')).toBeVisible();
  expect(screen.getByRole('checkbox', { name: 'Select Fourth' })).not.toBeChecked();
});

it('toggles the focused row with Space instead of opening it', async () => {
  const user = userEvent.setup();
  const { onOpen } = renderList();
  screen.getByRole('button', { name: 'Third' }).focus();
  await user.keyboard(' ');
  expect(onOpen).not.toHaveBeenCalled();
  expect(within(tray()).getByText('1 selected')).toBeVisible();
  await user.keyboard(' ');
  noTray();
});

it('selects everything shown with Ctrl-A, offering Select all only while some are unselected', async () => {
  const user = userEvent.setup();
  renderList();
  screen.getByRole('button', { name: 'First' }).focus();
  await user.keyboard('{Control>}a{/Control}');
  expect(within(tray()).getByText('4 selected')).toBeVisible();
  expect(within(tray()).queryByRole('button', { name: /^Select all/ })).not.toBeInTheDocument();

  await user.click(within(tray()).getByRole('button', { name: 'Clear' }));
  await user.click(screen.getByRole('checkbox', { name: 'Select Second' }));
  await user.click(within(tray()).getByRole('button', { name: 'Select all 4' }));
  expect(within(tray()).getByText('4 selected')).toBeVisible();
});

it('clears with Escape, and leaves Escape alone when nothing is selected', async () => {
  const user = userEvent.setup();
  renderList();
  const first = screen.getByRole('button', { name: 'First' });
  first.focus();
  // Nothing selected: the key is not claimed, so it still means what it meant before.
  expect(fireEvent.keyDown(first, { key: 'Escape' })).toBe(true);

  await user.click(screen.getByRole('checkbox', { name: 'Select First' }));
  first.focus();
  expect(fireEvent.keyDown(first, { key: 'Escape' })).toBe(false);
  noTray();
});

it('shows a row checkbox only on hover or focus until something is selected', async () => {
  const user = userEvent.setup();
  renderList();
  const box = screen.getByRole('checkbox', { name: 'Select First' });
  expect(box.closest('span.flex')).toHaveClass('opacity-0');
  await user.click(box);
  expect(
    screen.getByRole('checkbox', { name: 'Select Second' }).closest('span.flex'),
  ).not.toHaveClass('opacity-0');
});

it('starts a selection with a touch long-press on a row, then a tap toggles', () => {
  vi.useFakeTimers();
  try {
    const { onOpen } = renderList();
    const row = screen.getByRole('row', { name: /first/i });
    fireEvent.pointerDown(row, { pointerType: 'touch', isPrimary: true, clientX: 5, clientY: 5 });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.pointerUp(row, { pointerType: 'touch' });
    expect(within(tray()).getByText('1 selected')).toBeVisible();
    expect(onOpen).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
