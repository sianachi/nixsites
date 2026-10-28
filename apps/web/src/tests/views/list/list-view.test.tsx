import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '../../render-with-router';
import { stubViewport } from '../../stub-viewport';
import { aView, property, schemaOf } from '../../view-fixture';
import type {
  EffectiveSchema,
  Item,
  PropertyDefinition,
  View,
} from '../../../views/core/container-model';
import { setColumnWidth } from '../../../views/core/column-widths';
import { ListView } from '../../../views/list/list-view';
import { aContainer } from '../../container-fixture';
import type { ContainerData } from '../../../views/core/use-container';

/**
 * The list view, driven the way a person drives it: through the address bar and the pointer.
 *
 * Every test renders at a URL rather than setting up state, because the URL *is* the state - a
 * test that reached past it would be testing a component this application does not have.
 */

function item(
  id: string,
  title: string,
  seq: number,
  properties: Record<string, unknown> = {},
): Item {
  return {
    id,
    workspaceId: 'workspace-1',
    parentId: 'folder-1',
    type: 'note',
    title,
    hasChildren: false,
    seq,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function viewOf(overrides: Partial<View> = {}): View {
  return aView(overrides);
}

function containerData(overrides: Partial<ContainerData> = {}): ContainerData {
  return aContainer(overrides);
}

/**
 * A list wired to a stand-in for `useContainer`: the write is optimistic, and a refusal puts the
 * value back and answers with the reason.
 *
 * The round trip is a real one rather than a resolved promise, because the rollback only *is* a
 * rollback if the optimistic value reached the screen first - which is exactly the sequence a cell
 * has to survive.
 */
function listWith(options: {
  readonly items: readonly Item[];
  readonly schema: EffectiveSchema;
  readonly refuse?: string;
  readonly writeError?: string;
  readonly view?: View;
  readonly onSet?: (itemId: string, properties: Record<string, unknown>) => void;
  readonly onOpen?: (itemId: string) => void;
}): ReactElement {
  function Harness(): ReactNode {
    const [children, setChildren] = useState<readonly Item[]>(options.items);

    const container = containerData({
      schema: options.schema,
      children,
      ...(options.writeError === undefined ? {} : { writeError: options.writeError }),
      setProperties: async (itemId, properties) => {
        options.onSet?.(itemId, properties);
        setChildren((current) =>
          current.map((entry) =>
            entry.id === itemId
              ? { ...entry, properties: { ...entry.properties, ...properties } }
              : entry,
          ),
        );

        await new Promise((resolve) => setTimeout(resolve, 0));

        if (options.refuse === undefined) {
          return null;
        }

        setChildren(options.items);
        return options.refuse;
      },
    });

    return (
      <ListView
        container={container}
        view={options.view ?? null}
        onOpen={options.onOpen ?? vi.fn()}
      />
    );
  }

  return <Harness />;
}

/** Reports the address back to the test, so a URL-held sort can be asserted on as a fact. */
function CurrentSearch(): ReactNode {
  const location = useLocation();
  return <p role="status">{location.search}</p>;
}

const ZETA = item('item-z', 'Zeta', 1, { status: 'open' });
const ALPHA = item('item-a', 'Alpha', 2, { status: 'done' });

function headers(): (string | null)[] {
  return screen.getAllByRole('columnheader').map((header) => header.textContent);
}

function titles(): (string | null)[] {
  return screen.getAllByRole('rowheader').map((cell) => cell.textContent);
}

describe('ListView', () => {
  it('keeps a 3,200-item list DOM bounded while exposing the complete row count', () => {
    const many = Array.from({ length: 3_200 }, (_unused, index) =>
      item(`item-${String(index)}`, `Item ${String(index + 1)}`, index),
    );

    renderAt(
      <ListView container={containerData({ children: many })} view={null} onOpen={vi.fn()} />,
    );

    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '3201');
    expect(screen.getAllByRole('rowheader').length).toBeLessThanOrEqual(100);
  });

  it('opens a row from its secondary-click menu', async () => {
    const person = userEvent.setup();
    const onOpen = vi.fn();
    renderAt(
      <ListView container={containerData({ children: [ZETA] })} view={null} onOpen={onOpen} />,
    );

    const row = screen.getAllByRole('row')[1];
    if (row === undefined) throw new Error('The list drew no rows.');
    expect(fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })).toBe(false);
    await person.click(screen.getByRole('menuitem', { name: 'Open' }));

    expect(onOpen).toHaveBeenCalledWith(ZETA.id);
  });

  it('takes its columns from the schema, in the schema order, behind the title', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(
            property('status', 'Status', 'select'),
            property('owner', 'Owner', 'text'),
          ),
          children: [ZETA],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    expect(headers()).toEqual(['Title', 'Status', 'Owner']);
  });

  it('shows the columns the view names, in the order the view names them', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(
            property('status', 'Status', 'select'),
            property('owner', 'Owner', 'text'),
          ),
          children: [ZETA],
        })}
        view={viewOf({ columns: ['owner', 'status'] })}
        onOpen={vi.fn()}
      />,
    );

    expect(headers()).toEqual(['Title', 'Owner', 'Status']);
  });

  it('still lists the items when the container has no schema at all', () => {
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    expect(headers()).toEqual(['Title']);
    expect(titles()).toEqual(['Zeta', 'Alpha']);
  });

  it('heads a column the schema does not describe with the key it was configured under', () => {
    renderAt(
      <ListView
        container={containerData({ schema: schemaOf(), children: [ZETA] })}
        view={viewOf({ columns: ['renamed_property'] })}
        onOpen={vi.fn()}
      />,
    );

    expect(headers()).toEqual(['Title', 'renamed_property']);
  });

  it('leaves the items in the order somebody arranged them until a column is chosen', () => {
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    expect(titles()).toEqual(['Zeta', 'Alpha']);
    expect(screen.getByRole('columnheader', { name: 'Title' })).toHaveAttribute(
      'aria-sort',
      'none',
    );
  });

  it('sorts by the column whose header is clicked', async () => {
    const user = userEvent.setup();
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Title' }));

    expect(titles()).toEqual(['Alpha', 'Zeta']);
    expect(screen.getByRole('columnheader', { name: 'Title' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('reverses the sort when the sorted column is clicked again', async () => {
    const user = userEvent.setup();
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Title' }));
    await user.click(screen.getByRole('button', { name: 'Title' }));

    expect(titles()).toEqual(['Zeta', 'Alpha']);
    expect(screen.getByRole('columnheader', { name: 'Title' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('writes the sort into the address', async () => {
    const user = userEvent.setup();
    renderAt(
      <>
        <ListView
          container={containerData({ children: [ZETA, ALPHA] })}
          view={null}
          onOpen={vi.fn()}
        />
        <CurrentSearch />
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Title' }));

    // The point of the exercise: the sort is linkable, bookmarkable and restorable because it is
    // in the URL and nowhere else.
    expect(screen.getByRole('status')).toHaveTextContent('sort=title');
    expect(screen.getByRole('status')).toHaveTextContent('dir=ascending');
  });

  it('renders the sort the address arrives with, having held none of its own', () => {
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={null}
        onOpen={vi.fn()}
      />,
      '/?sort=title&dir=descending',
    );

    expect(titles()).toEqual(['Zeta', 'Alpha']);
    expect(screen.getByRole('columnheader', { name: 'Title' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('prefers the address over the sort the view was stored with', () => {
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={viewOf({ sortBy: 'title', sortDescending: true })}
        onOpen={vi.fn()}
      />,
      '/?sort=title&dir=ascending',
    );

    expect(titles()).toEqual(['Alpha', 'Zeta']);
  });

  it('applies the filters the address carries', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('status', 'Status', 'select')),
          children: [ZETA, ALPHA],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
      '/?f.status=open',
    );

    expect(titles()).toEqual(['Zeta']);
  });

  it('says the filters are hiding the items rather than saying there is nothing here', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('status', 'Status', 'select')),
          children: [ZETA, ALPHA],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
      '/?f.status=archived',
    );

    // Somebody told "this folder is empty" here goes looking for two notes they think are gone.
    expect(
      screen.getByText('All 2 items in here are hidden by the current filters.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Nothing in here yet.')).not.toBeInTheDocument();
  });

  it('offers a way out of a filter that hides everything', async () => {
    const user = userEvent.setup();
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('status', 'Status', 'select')),
          children: [ZETA, ALPHA],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
      '/?f.status=archived',
    );

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(titles()).toEqual(['Zeta', 'Alpha']);
  });

  it('says there is nothing here when there is nothing here', () => {
    renderAt(<ListView container={containerData()} view={null} onOpen={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Nothing in here yet');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('does not call unanswered contents empty', () => {
    renderAt(
      <ListView container={containerData({ status: 'loading' })} view={null} onOpen={vi.fn()} />,
    );

    expect(screen.queryByText(/nothing in here yet/i)).not.toBeInTheDocument();
    expect(screen.getByText('Loading this list')).toBeInTheDocument();
    // A header row over an unanswered question reads as a folder with nothing in it, which is the
    // one thing we do not yet know.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('reports contents that could not be read instead of drawing an empty table', () => {
    renderAt(
      <ListView
        container={containerData({ status: 'error', error: 'Core could not be reached.' })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Core could not be reached.');
    // A header row over a failure reads as a folder with nothing in it, which is the one thing we
    // know it is not.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('asks the container again when the failure is retried', async () => {
    const user = userEvent.setup();
    const reload = vi.fn(() => Promise.resolve());
    renderAt(
      <ListView
        container={containerData({ status: 'error', error: 'Core could not be reached.', reload })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('opens the item whose title is clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderAt(
      <ListView
        container={containerData({ children: [ZETA, ALPHA] })}
        view={null}
        onOpen={onOpen}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Alpha' }));

    expect(onOpen).toHaveBeenCalledWith('item-a');
  });

  it('commits a cell edit on blur and leaves the other cells alone', async () => {
    const user = userEvent.setup();
    const setProperties = vi.fn(() => Promise.resolve(null));

    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('owner', 'Owner', 'text'), property('note', 'Note', 'text')),
          children: [item('item-1', 'Billing', 1, { owner: 'Ada', note: 'untouched' })],
          setProperties,
        })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    const owner = screen.getByRole('textbox', { name: 'Owner for Billing' });
    await user.clear(owner);
    await user.type(owner, 'Grace');
    await user.tab();

    // One request for one finished edit, carrying only the property that was edited: a control
    // that wrote per keystroke would put five requests behind the word above.
    expect(setProperties).toHaveBeenCalledTimes(1);
    expect(setProperties).toHaveBeenCalledWith('item-1', { owner: 'Grace' });
    expect(screen.getByRole('textbox', { name: 'Note for Billing' })).toHaveValue('untouched');
  });

  it('names each editable cell by its property and its row', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('owner', 'Owner', 'text')),
          children: [ZETA, ALPHA],
        })}
        view={viewOf({ columns: ['owner'] })}
        onOpen={vi.fn()}
      />,
    );

    // A column of controls all called "Owner" is a column neither a screen reader user nor a test
    // can operate: the row has to be part of the name.
    expect(screen.getByRole('textbox', { name: 'Owner for Zeta' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Owner for Alpha' })).toBeInTheDocument();
  });

  it("shows the server's refusal in the cell that caused it, and puts the old value back", async () => {
    const user = userEvent.setup();

    renderAt(
      listWith({
        schema: schemaOf(property('owner', 'Owner', 'text')),
        items: [item('item-1', 'Billing', 1, { owner: 'Ada' })],
        refuse: 'You do not have permission to change this item.',
      }),
    );

    const owner = screen.getByRole('textbox', { name: 'Owner for Billing' });
    await user.clear(owner);
    await user.type(owner, 'Grace{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to change this item.',
    );
    // The stored value is what is really there, so it is what the field shows.
    expect(screen.getByRole('textbox', { name: 'Owner for Billing' })).toHaveValue('Ada');
  });

  it('does not draw a second banner for a refusal a cell has already reported', async () => {
    const user = userEvent.setup();

    renderAt(
      listWith({
        schema: schemaOf(property('owner', 'Owner', 'text')),
        items: [item('item-1', 'Billing', 1, { owner: 'Ada' })],
        refuse: 'That change could not be saved.',
        // The drag channel, which this view does not use. A list that rendered both would say the
        // same thing twice for one failure.
        writeError: 'That change could not be saved.',
      }),
    );

    const owner = screen.getByRole('textbox', { name: 'Owner for Billing' });
    await user.clear(owner);
    await user.type(owner, 'Grace{Enter}');

    expect(await screen.findAllByRole('alert')).toHaveLength(1);
  });

  it('does not offer an edit for a property type this build does not know', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('rating', 'Rating', 'constellation')),
          children: [item('item-r', 'Rated', 1, { rating: 'four of five' })],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    // The value is shown as stored - a type this build cannot draw a control for is a missing
    // presentation, not a missing value - and no control claims it can change it.
    expect(screen.getByRole('cell', { name: 'four of five' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /rating/i })).not.toBeInTheDocument();
  });

  it('renders the value of a property type this build has never heard of', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('rating', 'Rating', 'constellation')),
          children: [item('item-r', 'Rated', 1, { rating: 'four of five' })],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole('cell', { name: 'four of five' })).toBeInTheDocument();
  });

  it('leaves a cell blank rather than printing a placeholder for a value the item has not got', () => {
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('owner', 'Owner', 'text')),
          children: [item('item-n', 'Unassigned', 1)],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole('cell')).toHaveTextContent('');
  });
});

describe('ListView on a phone', () => {
  const select = (key: string, label: string, options: string[]): PropertyDefinition => ({
    key,
    label,
    type: 'select',
    options,
    required: false,
  });
  const schema = schemaOf(
    select('status', 'Status', ['open', 'done']),
    property('owner', 'Owner', 'text'),
    property('notes', 'Notes', 'text'),
  );
  const row = item('item-p', 'Pay rent', 1, { status: 'open', owner: 'Sam', notes: 'late' });

  it('shows the title and the first two fields as values, with no Fields disclosure', () => {
    stubViewport(false);
    renderAt(listWith({ items: [row], schema }));

    expect(screen.getByRole('button', { name: 'Pay rent' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Status for Pay rent/ })).toHaveTextContent('open');
    expect(screen.getByRole('button', { name: /Owner for Pay rent/ })).toHaveTextContent('Sam');
    expect(screen.queryByRole('button', { name: /Notes for/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Fields')).not.toBeInTheDocument();
    // Values are read, not live controls, until a person opens one.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('names an empty field in place of a blank', () => {
    stubViewport(false);
    renderAt(listWith({ items: [item('item-e', 'Empty', 1)], schema }));

    const button = screen.getByRole('button', { name: /Owner for Empty/ });
    expect(within(button).getByText('Owner')).toBeInTheDocument();
    expect(button).not.toHaveTextContent('\u2014');
  });

  it('edits one field in a popover through the normal write path', async () => {
    stubViewport(false);
    const user = userEvent.setup();
    const onSet = vi.fn();
    renderAt(listWith({ items: [row], schema, onSet }));

    await user.click(screen.getByRole('button', { name: /Status for Pay rent/ }));
    const dialog = screen.getByRole('dialog', { name: 'Status for Pay rent' });
    await user.selectOptions(within(dialog).getByRole('combobox'), 'done');

    expect(onSet).toHaveBeenCalledExactlyOnceWith('item-p', { status: 'done' });
    // A single choice is the whole edit: the popover closes and focus returns to the value.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Status for Pay rent/ })).toHaveFocus();
  });

  it('stores a typed value on Enter and closes the popover', async () => {
    stubViewport(false);
    const user = userEvent.setup();
    const onSet = vi.fn();
    renderAt(listWith({ items: [row], schema, onSet }));

    await user.click(screen.getByRole('button', { name: /Owner for Pay rent/ }));
    const dialog = screen.getByRole('dialog', { name: 'Owner for Pay rent' });
    await user.type(within(dialog).getByRole('textbox'), 'Kim{Enter}');

    await waitFor(() => {
      expect(onSet).toHaveBeenCalled();
    });
    expect(screen.queryByRole('dialog', { name: 'Owner for Pay rent' })).not.toBeInTheDocument();
  });

  it('shows a refused write inside the popover', async () => {
    stubViewport(false);
    const user = userEvent.setup();
    renderAt(listWith({ items: [row], schema, refuse: 'You cannot edit this.' }));

    await user.click(screen.getByRole('button', { name: /Status for Pay rent/ }));
    const dialog = screen.getByRole('dialog', { name: 'Status for Pay rent' });
    await user.selectOptions(within(dialog).getByRole('combobox'), 'done');

    expect(await within(dialog).findByText('You cannot edit this.')).toBeVisible();
    expect(screen.getByRole('dialog', { name: 'Status for Pay rent' })).toBeInTheDocument();
  });

  it('closes the popover on Escape and returns focus to the value', async () => {
    stubViewport(false);
    const user = userEvent.setup();
    renderAt(listWith({ items: [row], schema }));

    await user.click(screen.getByRole('button', { name: /Status for Pay rent/ }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Status for Pay rent/ })).toHaveFocus();
  });

  it('draws only the title for a view with no property columns, and opens on a tap', async () => {
    stubViewport(false);
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderAt(listWith({ items: [row], schema: schemaOf(), onOpen }));

    expect(screen.queryByRole('button', { name: / for Pay rent/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pay rent' }));
    expect(onOpen).toHaveBeenCalled();
  });
});

describe('ListView on a wide screen', () => {
  it('keeps a stored column width once the list is virtualized', () => {
    stubViewport(true);
    setColumnWidth('view-wide', 'title', 321);
    const many = Array.from({ length: 150 }, (_unused, index) =>
      item(`item-${String(index)}`, `Item ${String(index)}`, index),
    );
    renderAt(
      <ListView
        container={containerData({ children: many })}
        view={viewOf({ id: 'view-wide' })}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('columnheader')[0]).toHaveStyle({ width: '321px' });
  });

  it('names the table by its caption without drawing it', () => {
    stubViewport(true);
    renderAt(listWith({ items: [ZETA], schema: schemaOf(property('status', 'Status', 'select')) }));

    expect(screen.getByRole('table', { name: 'Items in this one' })).toBeInTheDocument();
    expect(screen.getByText('Items in this one')).toHaveClass('sr-only');
  });
});
