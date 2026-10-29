import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import { ContainerView } from '../../../views/core/container-view';
import { ClickSelectsContext, useItemOpenProps } from '@nix/web-collections/core/item-open-click';
import { aContainer } from '@nix/web-collections/testing/container-fixture';
import { item } from '@nix/web-foundation/testing/api-stub';
import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { aView } from '@nix/web-collections/testing/view-fixture';

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

const row = item({ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', title: 'First' });

it('opens a tab-mode row as a pinned tab', async () => {
  const onOpen = vi.fn();
  const onOpenPinned = vi.fn();
  renderAt(
    <ContainerView
      container={aContainer({ children: [row] })}
      view={aView({ kind: 'list', open: 'tab' })}
      onOpen={onOpen}
      onOpenPinned={onOpenPinned}
    />,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'First' }));
  expect(onOpenPinned).toHaveBeenCalledWith(row.id);
  expect(onOpen).not.toHaveBeenCalled();
});

it('falls back to the plain open when no host can pin a tab', async () => {
  const onOpen = vi.fn();
  renderAt(
    <ContainerView
      container={aContainer({ children: [row] })}
      view={aView({ kind: 'list', open: 'tab' })}
      onOpen={onOpen}
    />,
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'First' }));
  expect(onOpen).toHaveBeenCalledWith(row.id);
});

function renderNone(kind: 'list' | 'checklist') {
  const onOpen = vi.fn();
  renderAt(
    <ContainerView
      container={aContainer({
        children: [row],
        schema: {
          properties: [
            { key: 'done', label: 'Done', type: 'checkbox', options: [], required: false },
          ],
          declared: [],
          inherit: true,
        },
      })}
      view={aView({ kind, open: 'none' })}
      onOpen={onOpen}
    />,
  );
  return onOpen;
}

it('selects on a click and opens on a double-click in a none-mode list', async () => {
  const onOpen = renderNone('list');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'First' }));
  expect(onOpen).not.toHaveBeenCalled();
  expect(
    within(screen.getByRole('toolbar', { name: 'Selected items' })).getByText('1 selected'),
  ).toBeVisible();

  await user.dblClick(screen.getByRole('button', { name: 'First' }));
  expect(onOpen).toHaveBeenCalledWith(row.id);
});

it('opens a none-mode row on Enter and from the context menu', async () => {
  const onOpen = renderNone('list');
  const user = userEvent.setup();
  screen.getByRole('button', { name: 'First' }).focus();
  await user.keyboard('{Enter}');
  expect(onOpen).toHaveBeenCalledTimes(1);

  onOpen.mockClear();
  await user.pointer({
    keys: '[MouseRight]',
    target: screen.getByRole('button', { name: 'First' }),
  });
  await user.click(await screen.findByRole('menuitem', { name: 'Open' }));
  expect(onOpen).toHaveBeenCalledWith(row.id);
});

it('selects on a click and opens on a double-click in a none-mode checklist', async () => {
  const onOpen = renderNone('checklist');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Open First' }));
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByText('1 selected')).toBeVisible();

  await user.dblClick(screen.getByRole('button', { name: 'Open First' }));
  expect(onOpen).toHaveBeenCalledWith(row.id);
});

it('does nothing on a click where the view offers no selection, but still opens on a double-click', async () => {
  const onOpen = vi.fn();
  function Probe() {
    const openProps = useItemOpenProps(onOpen);
    return (
      <button type="button" {...openProps('x')}>
        Probe
      </button>
    );
  }
  renderAt(
    <ClickSelectsContext value>
      <Probe />
    </ClickSelectsContext>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Probe' }));
  expect(onOpen).not.toHaveBeenCalled();
  await user.dblClick(screen.getByRole('button', { name: 'Probe' }));
  expect(onOpen).toHaveBeenCalledWith('x');
});
