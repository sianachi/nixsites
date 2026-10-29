import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ContainerView } from '../../core/container-view';
import { aContainer } from '@nix/web-collections/testing/container-fixture';
import { aView } from '@nix/web-collections/testing/view-fixture';
import { item } from '@nix/web-foundation/testing/api-stub';
import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';

beforeEach(() => {
  stubViewport(false);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
const now = new Date();
const today = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const note = item({
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  title: 'Release plan',
  properties: { due: today },
});

it('browses spreadsheet records on phones while retaining an explicit grid', async () => {
  const onOpen = vi.fn();
  const user = userEvent.setup();
  renderAt(
    <ContainerView
      container={aContainer({ children: [note] })}
      view={aView({ kind: 'sheet' })}
      onOpen={onOpen}
    />,
  );
  expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Release plan' }));
  expect(onOpen).toHaveBeenCalledWith(note.id);
  await user.click(screen.getByRole('button', { name: 'Show spreadsheet grid' }));
  expect(screen.getByRole('grid')).toBeInTheDocument();
});

it('offers no calendar grid toggle in month mode on a phone, where the strip is the calendar', () => {
  renderAt(
    <ContainerView
      container={aContainer({ children: [note] })}
      view={aView({ kind: 'calendar', dateProperty: 'due' })}
      onOpen={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Show calendar grid' })).not.toBeInTheDocument();
});

it('shows dated calendar items in an agenda and keeps undated items available', async () => {
  const user = userEvent.setup();
  const undated = item({ id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', title: 'Unscheduled idea' });
  const onOpen = vi.fn();
  renderAt(
    <ContainerView
      container={aContainer({ children: [note, undated] })}
      view={aView({ kind: 'calendar', dateProperty: 'due', mode: 'week' })}
      onOpen={onOpen}
    />,
  );
  const agenda = screen.getByRole('region', { name: 'Calendar agenda' });
  await user.click(within(agenda).getByRole('button', { name: 'Release plan' }));
  expect(onOpen).toHaveBeenCalledWith(note.id);
  expect(screen.getByRole('button', { name: 'Unscheduled idea' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Show calendar grid' }));
  expect(screen.queryByRole('region', { name: 'Calendar agenda' })).not.toBeInTheDocument();
});

it('offers timeline date editing in place without a horizontal grid', async () => {
  const user = userEvent.setup();
  renderAt(
    <ContainerView
      container={aContainer({ children: [note] })}
      view={aView({ kind: 'timeline', dateProperty: 'due' })}
      onOpen={vi.fn()}
    />,
  );
  const schedule = screen.getByRole('region', { name: 'Timeline schedule' });
  expect(within(schedule).getByRole('button', { name: 'Release plan' })).toBeInTheDocument();
  await user.click(within(schedule).getByRole('button', { name: /^Edit dates: Release plan/ }));
  expect(screen.getByLabelText('Start date')).toBeInTheDocument();
});

it('browses board columns individually and keeps unassigned cards reachable', async () => {
  const status = {
    key: 'status',
    label: 'Status',
    type: 'select' as const,
    options: ['Todo', 'Done'],
    required: false,
  };
  const container = aContainer({
    schema: { properties: [status], declared: [status], inherit: true },
    children: [
      item({ ...note, properties: { status: 'Todo' } }),
      item({ id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', title: 'Unassigned idea' }),
    ],
  });
  renderAt(
    <ContainerView
      container={container}
      view={aView({ kind: 'board', groupBy: 'status' })}
      onOpen={vi.fn()}
    />,
  );
  expect(screen.getByRole('region', { name: 'Todo' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Done' })).not.toBeInTheDocument();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Board column' }), 'unset');
  expect(screen.getByRole('button', { name: 'Unassigned idea' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Todo' })).not.toBeInTheDocument();
});

it('opens the item actions from a phone list row, as the desktop rows do', async () => {
  renderAt(
    <ContainerView
      container={aContainer({ children: [note] })}
      view={aView({ kind: 'list' })}
      onOpen={vi.fn()}
    />,
  );

  const row = screen.getByRole('listitem');
  // A long press on a touch screen raises the same `contextmenu` the right mouse button does on
  // iOS-less platforms; the ContextMenu primitive's own suite covers the timed touch path.
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

  expect(await screen.findByRole('menu', { name: 'Release plan actions' })).toBeVisible();
});
