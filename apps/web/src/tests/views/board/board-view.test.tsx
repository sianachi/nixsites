import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '../../render-with-router';
import { aView, itemOf, schemaOf } from '../../view-fixture';
import { stubViewport } from '../../stub-viewport';
import { BoardView } from '../../../views/board/board-view';
import type {
  EffectiveSchema,
  Item,
  PropertyDefinition,
  View,
} from '../../../views/core/container-model';
import { aContainer, views } from '../../container-fixture';
import type { ContainerData } from '../../../views/core/use-container';

/**
 * The board, driven the way a person drives it.
 *
 * `ContainerData` is handed in rather than fetched, because every assertion here is about what the
 * board does with a container - which columns it draws, where a card lands, what it says when it
 * cannot draw anything. The transport is `useContainer`'s subject, and duplicating it here would
 * only mean these tests failed when the API shape moved rather than when the board broke.
 *
 * The one place the real hook's behaviour matters is the refused write, so `boardWith` reproduces
 * exactly the part of it that a board depends on: an optimistic move, then a reconcile that puts
 * the card back and reports why.
 */

const STATUS: PropertyDefinition = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['Backlog', 'Doing', 'Review', 'Blocked', 'Done', 'Archived'],
  required: false,
};

const OWNER: PropertyDefinition = {
  key: 'owner',
  label: 'Owner',
  type: 'text',
  options: [],
  required: false,
};

function viewOf(overrides: Partial<View> = {}): View {
  return aView({
    id: 'v1000000-0000-4000-8000-000000000001',
    name: 'Delivery',
    kind: 'board',
    groupBy: 'status',
    ...overrides,
  });
}

function containerOf(overrides: Partial<ContainerData> = {}): ContainerData {
  return aContainer({
    schema: schemaOf(STATUS, OWNER),
    views: views([]),
    ...overrides,
  });
}

/**
 * A board wired to a stand-in for `useContainer`: the write is optimistic, and a refusal puts the
 * card back and reports why - which is the behaviour the board is built to surface.
 */
function boardWith(options: {
  readonly items: readonly Item[];
  readonly view?: View;
  readonly schema?: EffectiveSchema | null;
  readonly refuse?: string;
  readonly onOpen?: (itemId: string) => void;
  readonly onWrite?: (itemId: string, properties: Record<string, unknown>) => void;
}): ReactElement {
  function Harness(): ReactNode {
    const [children, setChildren] = useState<readonly Item[]>(options.items);
    const [writeError, setWriteError] = useState<string | null>(null);

    const container = containerOf({
      schema: options.schema === undefined ? schemaOf(STATUS, OWNER) : options.schema,
      children,
      writeError,
      setProperties: (itemId, properties) => {
        options.onWrite?.(itemId, properties);
        setWriteError(null);
        setChildren((current) =>
          current.map((item) =>
            item.id === itemId
              ? { ...item, properties: { ...item.properties, ...properties } }
              : item,
          ),
        );

        if (options.refuse !== undefined) {
          setChildren(options.items);
          setWriteError(options.refuse);
        }

        // The refusal is returned as well as put in `writeError`, matching the real hook's two
        // channels. The board reads the second and ignores this, which is what makes it the board.
        return Promise.resolve(options.refuse ?? null);
      },
    });

    return (
      <BoardView
        container={container}
        view={options.view ?? viewOf()}
        onOpen={options.onOpen ?? (() => undefined)}
      />
    );
  }

  return <Harness />;
}

const DOING = itemOf({ id: 'i1', title: 'Search ranking', properties: { status: 'Doing' } });
const DONE = itemOf({
  id: 'i2',
  title: 'Export to CSV',
  properties: { status: 'Done' },
  seq: 2000,
});
const UNSET = itemOf({ id: 'i3', title: 'Retention policy', seq: 3000 });

/** The card's context menu is the keyboard and touch path for a column move (drag is desktop only). */
async function moveViaMenu(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
  column: string,
): Promise<void> {
  const card = screen.getByRole('button', { name: title }).closest('li');
  expect(card).not.toBeNull();
  fireEvent.contextMenu(card as HTMLElement, { clientX: 10, clientY: 10 });
  const entry = await screen.findByRole('menuitem', { name: `Move to ${column}` });
  // The menu is ready once it has taken focus; before that a click can land on a closing panel.
  await waitFor(() => {
    expect(document.activeElement).toHaveAttribute('role', 'menuitem');
  });
  await user.click(entry);
  // Let the card's own refocus frame run inside this test rather than the next one.
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

describe('the board view', () => {
  it('keeps a 3,200-card board DOM bounded across its columns', () => {
    const statuses = ['Backlog', 'Doing', 'Done'] as const;
    const many = Array.from({ length: 3_200 }, (_unused, index) =>
      itemOf({
        id: `item-${String(index)}`,
        title: `Item ${String(index + 1)}`,
        seq: index,
        properties: { status: statuses[index % statuses.length] },
      }),
    );

    renderAt(
      boardWith({
        items: many,
        view: viewOf({ groupOrder: [...statuses] }),
      }),
    );

    expect(screen.getAllByRole('listitem').length).toBeLessThanOrEqual(100);
  });

  it('draws its columns in the order the view names, not the order the property declares', () => {
    renderAt(
      boardWith({
        items: [DOING, DONE],
        view: viewOf({ groupOrder: ['Done', 'Doing'] }),
      }),
    );

    const columns = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'));
    expect(columns).toEqual(['Done', 'Doing', 'Unset']);
  });

  it('falls back to the grouping property s declared options when the view names no order', () => {
    renderAt(boardWith({ items: [DOING] }));

    const columns = screen
      .getAllByRole('region')
      .map((region) => region.getAttribute('aria-label'));
    expect(columns).toEqual(['Backlog', 'Doing', 'Review', 'Blocked', 'Done', 'Archived', 'Unset']);
  });

  it('shows only the columns the view chose, even though the property allows more', () => {
    // Board columns are freely definable: a status with six options may be shown as a two-column
    // board. The property s other values must not force columns nobody asked for.
    renderAt(
      boardWith({
        items: [DOING, DONE],
        view: viewOf({ groupOrder: ['Doing', 'Done'] }),
      }),
    );

    expect(screen.getByRole('region', { name: 'Doing' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Backlog' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Archived' })).not.toBeInTheDocument();
  });

  it('says how many items its columns cannot hold rather than dropping them silently', () => {
    renderAt(
      boardWith({
        items: [DOING, DONE],
        view: viewOf({ groupOrder: ['Doing'] }),
      }),
    );

    expect(screen.getByRole('status')).toHaveTextContent(/1 item is not on this board/i);
    expect(screen.getByRole('status')).toHaveTextContent(/still here/i);
  });

  it('gives items with no value a column of their own instead of losing them', () => {
    renderAt(boardWith({ items: [DOING, UNSET], view: viewOf({ groupOrder: ['Doing'] }) }));

    const unset = screen.getByRole('region', { name: 'Unset' });
    expect(within(unset).getByRole('button', { name: /^retention policy$/i })).toBeVisible();
  });

  it('keeps the unset column on screen when nothing is in it, so the board shows it has one', () => {
    renderAt(boardWith({ items: [DOING], view: viewOf({ groupOrder: ['Doing'] }) }));

    expect(screen.getByRole('region', { name: 'Unset' })).toBeVisible();
  });

  it('moves a card to another column from its menu and writes the grouping property', async () => {
    const user = userEvent.setup();
    const onWrite = vi.fn();

    renderAt(
      boardWith({
        items: [DOING],
        view: viewOf({ groupOrder: ['Doing', 'Done'] }),
        onWrite,
      }),
    );

    await moveViaMenu(user, 'Search ranking', 'Done');

    expect(onWrite).toHaveBeenCalledWith('i1', { status: 'Done' });

    const done = screen.getByRole('region', { name: 'Done' });
    const moved = within(done).getByRole('button', { name: /^search ranking$/i });
    expect(moved).toBeVisible();
    // Focus follows the card to its new column rather than falling to the document.
    expect(moved).toHaveFocus();
  });

  it('offers a visible per-card move button for touch and assistive technology', async () => {
    const user = userEvent.setup();
    const onWrite = vi.fn();

    renderAt(
      boardWith({ items: [DOING], view: viewOf({ groupOrder: ['Doing', 'Done'] }), onWrite }),
    );

    await user.click(screen.getByRole('button', { name: 'Move Search ranking to column' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move to Done' }));

    expect(onWrite).toHaveBeenCalledWith('i1', { status: 'Done' });
    // Let the card's refocus frame run in this test rather than the next one.
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

  it('clears the property when a card is moved to the unset column', async () => {
    const user = userEvent.setup();
    const onWrite = vi.fn();

    renderAt(
      boardWith({ items: [DOING], view: viewOf({ groupOrder: ['Doing', 'Done'] }), onWrite }),
    );

    await moveViaMenu(user, 'Search ranking', 'Unset');

    // Null, not the empty string: the property is being cleared, and an empty string is a value.
    expect(onWrite).toHaveBeenCalledWith('i1', { status: null });
  });

  it('reports a refused move and leaves the card in the column it started in', async () => {
    const user = userEvent.setup();

    renderAt(
      boardWith({
        items: [DOING],
        view: viewOf({ groupOrder: ['Doing', 'Done'] }),
        refuse: 'You do not have permission to change this item.',
      }),
    );

    await moveViaMenu(user, 'Search ranking', 'Done');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/do not have permission/i);

    const doing = screen.getByRole('region', { name: 'Doing' });
    expect(within(doing).getByRole('button', { name: /^search ranking$/i })).toBeVisible();
  });

  it('moves a card when it is dragged into another column', () => {
    const onWrite = vi.fn();

    renderAt(
      boardWith({ items: [DOING], view: viewOf({ groupOrder: ['Doing', 'Done'] }), onWrite }),
    );

    // A weaker assertion than the keyboard test above, and deliberately so: jsdom implements no
    // drag-and-drop, so this fires the events the browser would fire rather than performing a
    // drag. It proves the handlers are wired to the same write; it cannot prove the gesture works.
    const card = screen
      .getByRole('button', { name: /^search ranking$/i })
      .closest('[draggable="true"]');

    if (card === null) {
      throw new Error('The card is not draggable.');
    }

    fireEvent.dragStart(card, { dataTransfer: { effectAllowed: '', setData: vi.fn() } });
    const done = screen.getByRole('region', { name: 'Done' });
    fireEvent.dragOver(done);
    fireEvent.drop(done);

    expect(onWrite).toHaveBeenCalledWith('i1', { status: 'Done' });
  });

  it('opens the item when its card is clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();

    renderAt(boardWith({ items: [DOING], view: viewOf({ groupOrder: ['Doing'] }), onOpen }));

    await user.click(screen.getByRole('button', { name: /^search ranking$/i }));

    expect(onOpen).toHaveBeenCalledWith('i1');
  });

  it('explains itself when the grouping property is not in the schema', () => {
    renderAt(
      boardWith({
        items: [DOING],
        view: viewOf({ groupBy: 'stage' }),
        schema: schemaOf(OWNER),
      }),
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/no longer exists/i);
    expect(alert).toHaveTextContent(/items are all still here/i);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('explains itself when the grouping property is not a select', () => {
    renderAt(
      boardWith({
        items: [DOING],
        view: viewOf({ groupBy: 'owner' }),
      }),
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/cannot make columns/i);
    expect(alert).toHaveTextContent(/text property/i);
  });

  it('explains itself when the view names no grouping property at all', () => {
    renderAt(boardWith({ items: [DOING], view: viewOf({ groupBy: null }) }));

    expect(screen.getByRole('alert')).toHaveTextContent(/no grouping property/i);
  });

  it('says the folder is empty when it holds nothing', () => {
    renderAt(boardWith({ items: [] }));

    expect(screen.getByRole('status')).toHaveTextContent(/nothing in here yet/i);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('says the filters are hiding items, which is not the same as an empty folder', async () => {
    const user = userEvent.setup();

    renderAt(
      boardWith({ items: [DOING, DONE], view: viewOf({ groupOrder: ['Doing', 'Done'] }) }),
      '/?f.status=Blocked',
    );

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/no items match the filters/i);
    expect(status).toHaveTextContent(/holds 2 items/i);
    expect(status).not.toHaveTextContent(/nothing in here yet/i);

    // And the way out is on screen, rather than in the address bar the person cannot see.
    await user.click(screen.getByRole('button', { name: /clear filters/i }));

    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Doing' })).toBeVisible();
    });
  });

  it('shows only the items the filters allow through', () => {
    renderAt(
      boardWith({ items: [DOING, DONE], view: viewOf({ groupOrder: ['Doing', 'Done'] }) }),
      '/?f.status=Doing',
    );

    expect(screen.getByRole('button', { name: /^search ranking$/i })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^export to csv$/i })).not.toBeInTheDocument();
  });

  it('says it is loading rather than showing an empty board', () => {
    renderAt(
      <BoardView
        container={containerOf({ status: 'loading' })}
        view={viewOf()}
        onOpen={() => undefined}
      />,
    );

    expect(screen.getByText(/loading this board/i)).toBeVisible();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('says a failed load failed, and offers the way back', async () => {
    const user = userEvent.setup();
    const reload = vi.fn(() => Promise.resolve());

    renderAt(
      <BoardView
        container={containerOf({ status: 'error', error: 'Core could not be reached.', reload })}
        view={viewOf()}
        onOpen={() => undefined}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/core could not be reached/i);

    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(reload).toHaveBeenCalled();
  });

  it('shows the properties the view asked for on each card', () => {
    renderAt(
      boardWith({
        items: [
          itemOf({ id: 'i9', title: 'Billing', properties: { status: 'Doing', owner: 'Ada' } }),
        ],
        view: viewOf({ groupOrder: ['Doing'], columns: ['owner', 'status'] }),
      }),
    );

    // A button naming its field, not a form control: nothing is editable until it is tapped.
    expect(screen.queryByDisplayValue('Ada')).toBeNull();
    const owner = screen.getByRole('button', { name: /Owner for Billing/ });
    expect(owner).toHaveTextContent('Owner');
    expect(owner).toHaveTextContent('Ada');
  });

  it('edits a card value in a popover and writes it once', async () => {
    const user = userEvent.setup();
    const onWrite = vi.fn();
    renderAt(
      boardWith({
        items: [
          itemOf({ id: 'i9', title: 'Billing', properties: { status: 'Doing', owner: 'Ada' } }),
        ],
        view: viewOf({ groupOrder: ['Doing'], columns: ['owner', 'status'] }),
        onWrite,
      }),
    );

    await user.click(screen.getByRole('button', { name: /Owner for Billing/ }));
    const field = within(screen.getByRole('dialog', { name: /Owner for Billing/ })).getByRole(
      'textbox',
      { name: /Owner for Billing/ },
    );
    await user.clear(field);
    await user.type(field, 'Bo');
    fireEvent.blur(field);

    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onWrite).toHaveBeenCalledWith('i9', { owner: 'Bo' });
  });

  it('names the one visible column once on a phone, keeping its heading for screen readers', () => {
    stubViewport(390);
    renderAt(boardWith({ items: [DOING], view: viewOf({ groupOrder: ['Doing', 'Done'] }) }));

    expect(screen.getByRole('heading', { name: 'Doing' }).parentElement).toHaveClass('sr-only');
  });

  it('creates a card already in the column it was added to', async () => {
    const user = userEvent.setup();
    const create = vi.fn(() => Promise.resolve(null));

    renderAt(
      <BoardView
        container={aContainer({
          schema: schemaOf(STATUS, OWNER),
          views: views([viewOf()]),
          children: [itemOf({ id: 'a', title: 'Existing', properties: { status: 'Todo' } })],
          create,
        })}
        view={viewOf()}
        onOpen={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Add an item to Doing' }));
    await user.type(screen.getByRole('textbox', { name: 'Add an item to Doing' }), 'Search{Enter}');

    // The same write a drag makes. A card added to a column and a card dragged to it must end up
    // holding the same value, or the two gestures mean different things.
    expect(create).toHaveBeenCalledWith('Search', { status: 'Doing' });
  });

  it('creates without a value in the unset column', async () => {
    const user = userEvent.setup();
    const create = vi.fn(() => Promise.resolve(null));

    renderAt(
      <BoardView
        container={aContainer({
          schema: schemaOf(STATUS, OWNER),
          views: views([viewOf()]),
          children: [itemOf({ id: 'a', title: 'Existing', properties: { status: 'Todo' } })],
          create,
        })}
        view={viewOf()}
        onOpen={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /add an item without a status/i }));
    await user.type(screen.getByRole('textbox'), 'Unsorted{Enter}');

    // Null, not the empty string - the same distinction the drag path makes.
    expect(create).toHaveBeenCalledWith('Unsorted', { status: null });
  });
});
