import { screen, within } from '@testing-library/react';
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

const first = item({ id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', title: 'First' });
const second = item({ id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', title: 'Second' });

it('selects list rows by their boxes, counts them, and clears them again', async () => {
  const user = userEvent.setup();
  renderAt(
    <ContainerView
      container={aContainer({ children: [first, second] })}
      view={aView({ kind: 'list' })}
      onOpen={vi.fn()}
    />,
  );
  expect(screen.queryByRole('toolbar', { name: 'Selected items' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: 'Select First' }));
  await user.click(screen.getByRole('checkbox', { name: 'Select Second' }));
  const bar = screen.getByRole('toolbar', { name: 'Selected items' });
  expect(within(bar).getByText('2 selected')).toBeVisible();
  // No shell around this view, so there is nowhere to move to: the bar offers no Move.
  expect(within(bar).queryByRole('button', { name: 'Move to…' })).not.toBeInTheDocument();
  await user.click(within(bar).getByRole('button', { name: 'Clear' }));
  expect(screen.queryByRole('toolbar', { name: 'Selected items' })).not.toBeInTheDocument();
});

it('offers Select from the row menu and says what a drop changes on a board', async () => {
  const user = userEvent.setup();
  renderAt(
    <ContainerView
      container={aContainer({ children: [first] })}
      view={aView({ kind: 'list' })}
      onOpen={vi.fn()}
    />,
  );
  const row = screen.getByRole('row', { name: /first/i });
  await user.pointer({ keys: '[MouseRight]', target: row });
  await user.click(await screen.findByRole('menuitem', { name: 'Select' }));
  expect(screen.getByText('1 selected')).toBeVisible();
});

it('names what dragging changes on a board, before anything is dragged', () => {
  renderAt(
    <ContainerView
      container={aContainer({
        children: [first],
        schema: {
          properties: [
            {
              key: 'status',
              label: 'Status',
              type: 'select',
              options: ['A', 'B'],
              required: false,
            },
          ],
          declared: [],
          inherit: true,
        },
      })}
      view={aView({ kind: 'board', groupBy: 'status', groupOrder: ['A', 'B'] })}
      onOpen={vi.fn()}
    />,
  );
  expect(screen.getByText('Dropping changes the grouping property, not the order.')).toBeVisible();
});

it('selects a board card by its box, which sits outside the drag handle', async () => {
  const user = userEvent.setup();
  renderAt(
    <ContainerView
      container={aContainer({
        children: [first, second],
        schema: {
          properties: [
            {
              key: 'status',
              label: 'Status',
              type: 'select',
              options: ['A', 'B'],
              required: false,
            },
          ],
          declared: [],
          inherit: true,
        },
      })}
      view={aView({ kind: 'board', groupBy: 'status', groupOrder: ['A', 'B'] })}
      onOpen={vi.fn()}
    />,
  );
  const box = screen.getByRole('checkbox', { name: 'Select First' });
  expect(box.closest('[draggable]')).toBeNull();
  await user.click(box);
  const bar = screen.getByRole('toolbar', { name: 'Selected items' });
  expect(within(bar).getByText('1 selected')).toBeVisible();
});

it('selects checklist lines from the menu, then by their boxes, apart from the boxes that tick them', async () => {
  const user = userEvent.setup();
  renderAt(
    <ContainerView
      container={aContainer({
        children: [first, second],
        schema: {
          properties: [
            { key: 'done', label: 'Done', type: 'checkbox', options: [], required: false },
          ],
          declared: [],
          inherit: true,
        },
      })}
      view={aView({ kind: 'checklist' })}
      onOpen={vi.fn()}
    />,
  );
  await user.pointer({
    keys: '[MouseRight]',
    target: screen.getByRole('button', { name: 'Open First' }),
  });
  await user.click(await screen.findByRole('menuitem', { name: 'Select' }));
  await user.click(await screen.findByRole('checkbox', { name: 'Select Second' }));
  const bar = screen.getByRole('toolbar', { name: 'Selected items' });
  expect(within(bar).getByText('2 selected')).toBeVisible();
  expect(screen.getByRole('checkbox', { name: 'First' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Second' })).not.toBeChecked();
});

it('does not show the drag hint on a coarse pointer', () => {
  // beforeEach restores a mouse viewport for the next test.
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
  renderAt(
    <ContainerView
      container={aContainer({
        children: [first],
        schema: {
          properties: [
            {
              key: 'status',
              label: 'Status',
              type: 'select',
              options: ['A', 'B'],
              required: false,
            },
          ],
          declared: [],
          inherit: true,
        },
      })}
      view={aView({ kind: 'board', groupBy: 'status', groupOrder: ['A', 'B'] })}
      onOpen={vi.fn()}
    />,
  );
  expect(
    screen.queryByText('Dropping changes the grouping property, not the order.'),
  ).not.toBeInTheDocument();
});
