import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { aContainer } from '@nix/web-collections/testing/container-fixture';
import { aView, item, property, schemaOf } from '@nix/web-collections/testing/view-fixture';
import type { EffectiveSchema, Item, View } from '@nix/web-collections/core/container-model';
import type { ContainerData } from '@nix/web-collections/core/use-container';
import { SpreadsheetView } from '../../../views/spreadsheet/spreadsheet-view';

/**
 * The spreadsheet view, driven the way a person drives it: one focused scroller, arrows, typing,
 * and the clipboard. Cells stay windowed with `aria-activedescendant` naming the active one. Only the active property
 * mounts its typed editor, so these tests assert on cell labels, controls and the writes they make.
 */

const SCHEMA = schemaOf(property('status', 'Status', 'text'), property('count', 'Count', 'number'));

const writes: { itemId: string; bag: Record<string, unknown> }[] = [];

beforeEach(() => {
  writes.length = 0;
  // jsdom has no ResizeObserver; the grid only uses it to track viewport size, which stays 0x0
  // here - the first rows and columns still render through the overscan.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

/**
 * A spreadsheet wired to a stand-in for `useContainer`: the write is optimistic, and a refusal
 * puts the value back and answers with the reason - the same real round trip the list's harness
 * makes, because a rollback only is one if the optimistic value reached the screen first.
 */
function sheetWith(options: {
  readonly items: readonly Item[];
  readonly schema?: EffectiveSchema;
  readonly view?: View;
  readonly refuse?: string;
  readonly truncated?: boolean;
  readonly onOpen?: (itemId: string) => void;
}): ReactElement {
  function Harness(): ReactNode {
    const [children, setChildren] = useState<readonly Item[]>(options.items);

    function applyBag(itemId: string, properties: Record<string, unknown>): void {
      setChildren((current) =>
        current.map((entry) =>
          entry.id === itemId
            ? { ...entry, properties: { ...entry.properties, ...properties } }
            : entry,
        ),
      );
    }

    const container: ContainerData = aContainer({
      schema: options.schema ?? SCHEMA,
      children,
      truncated: options.truncated ?? false,
      setProperties: async (itemId, properties) => {
        writes.push({ itemId, bag: properties });
        applyBag(itemId, properties);

        await new Promise((resolve) => setTimeout(resolve, 0));

        if (options.refuse === undefined) {
          return null;
        }

        setChildren(options.items);
        return options.refuse;
      },
      // The bulk channel paste, fill and clear use: same optimistic-then-answer round trip, with
      // the whole gesture answered at once the way the real hook answers it.
      setPropertiesMany: async (planWrites) => {
        for (const write of planWrites) {
          writes.push({ itemId: write.itemId, bag: write.properties });
          applyBag(write.itemId, write.properties);
        }

        await new Promise((resolve) => setTimeout(resolve, 0));

        if (options.refuse === undefined) {
          return { saved: planWrites.length, refused: [] };
        }

        setChildren(options.items);
        return {
          saved: 0,
          refused: planWrites.map((write) => ({
            label: write.label,
            reason: options.refuse ?? '',
          })),
        };
      },
    });

    return (
      <SpreadsheetView
        container={container}
        view={options.view ?? aView({ kind: 'sheet' })}
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

const ALPHA = item('item-a', 'Alpha', 1, { status: 'open', count: 3 });
const BETA = item('item-b', 'Beta', 2, { status: 'done' });

function grid(): HTMLElement {
  return screen.getByRole('grid');
}

function pressOnGrid(key: string, init: Record<string, unknown> = {}): void {
  fireEvent.keyDown(grid(), { key, ...init });
}

describe('the grid', () => {
  it('carries the full extent in aria counts while mounting only the window', () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      item(`item-${String(index)}`, `Item ${String(index)}`, index + 1),
    );
    renderAt(sheetWith({ items: many }));

    expect(grid()).toHaveAttribute('aria-rowcount', '200');
    expect(grid()).toHaveAttribute('aria-colcount', '3');
    // The viewport is 0x0 in jsdom, so what is mounted is exactly the overscan - far fewer rows
    // than the container holds, which is the windowing working.
    expect(screen.getAllByRole('row').length).toBeLessThan(30);
  });

  it('names each cell after its column and its row, with the value read out', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    expect(screen.getByRole('gridcell', { name: 'Status for Alpha, open' })).toBeInTheDocument();
    expect(screen.getByRole('gridcell', { name: 'Count for Alpha, 3' })).toBeInTheDocument();
    // An empty cell is named without a value rather than with a dangling comma.
    expect(screen.getByRole('gridcell', { name: 'Count for Beta' })).toBeInTheDocument();
  });

  it('opens an item from its title cell, which is the row header affordance of this grid', () => {
    const onOpen = vi.fn();
    renderAt(sheetWith({ items: [ALPHA, BETA], onOpen }));

    grid().focus();
    pressOnGrid('Enter');

    expect(onOpen).toHaveBeenCalledWith('item-a');
  });
});

describe('editing a cell', () => {
  it('types into a cell, commits on Enter, and writes the coerced value once', async () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    grid().focus();
    pressOnGrid('ArrowRight');
    pressOnGrid('ArrowRight'); // Count for Alpha
    pressOnGrid('4');

    const editor = screen.getByRole('textbox', { name: 'Edit Count for Alpha' });
    fireEvent.change(editor, { target: { value: '42' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(writes).toEqual([{ itemId: 'item-a', bag: { count: 42 } }]);
    // The overlay is gone and focus is back on the scroller for the next keystroke.
    expect(screen.queryByRole('textbox', { name: 'Edit Count for Alpha' })).toBeNull();
    await Promise.resolve();
  });

  it('keeps a value that is not storable in the editor and says why, rather than writing a guess', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    grid().focus();
    pressOnGrid('ArrowRight');
    pressOnGrid('ArrowRight');
    pressOnGrid('x');

    const editor = screen.getByRole('textbox', { name: 'Edit Count for Alpha' });
    fireEvent.change(editor, { target: { value: 'twelve' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(writes).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'Edit Count for Alpha' })).toBeInTheDocument();
    expect(screen.getByText('Count for Alpha: "twelve" is not a number.')).toBeInTheDocument();
  });

  it('surfaces the server refusal beside the grid after the optimistic value is rolled back', async () => {
    renderAt(sheetWith({ items: [ALPHA], refuse: 'Not one of the options.' }));

    grid().focus();
    pressOnGrid('ArrowRight');
    pressOnGrid('b');

    const editor = screen.getByRole('textbox', { name: 'Edit Status for Alpha' });
    fireEvent.change(editor, { target: { value: 'blocked' } });
    fireEvent.keyDown(editor, { key: 'Enter' });

    expect(
      await screen.findByText('Status for Alpha: Not one of the options.'),
    ).toBeInTheDocument();
    // Rolled back: the cell shows what is really stored.
    expect(screen.getByRole('gridcell', { name: 'Status for Alpha, open' })).toBeInTheDocument();
  });

  it('escapes an edit without writing, and Escape in nav mode is the exit from the grid', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    grid().focus();
    pressOnGrid('ArrowRight');
    pressOnGrid('z');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit Status for Alpha' }), {
      key: 'Escape',
    });

    expect(writes).toEqual([]);
    expect(screen.queryByRole('textbox', { name: 'Edit Status for Alpha' })).toBeNull();
  });
});

describe('typed property controls', () => {
  const typedSchema = schemaOf(
    { ...property('status', 'Status', 'select'), options: ['open', 'done'] },
    property('done', 'Done', 'checkbox'),
    property('date', 'Date', 'date'),
    { ...property('tags', 'Tags', 'multi_select'), options: ['red', 'blue'] },
    property('priority', 'Priority', 'priority'),
    property('count', 'Count', 'number'),
    property('when', 'When', 'timestamp'),
    property('total', 'Total', 'formula'),
  );
  const typedAlpha = item('item-a', 'Alpha', 1, {
    status: 'open',
    done: false,
    date: '2026-10-10',
    count: 3,
    total: 8,
  });

  it('opens declared select options with one click and writes the choice once', async () => {
    const user = userEvent.setup();
    renderAt(sheetWith({ items: [typedAlpha], schema: typedSchema }));
    await user.click(screen.getByRole('gridcell', { name: 'Status for Alpha, open' }));
    const select = screen.getByRole('combobox', { name: 'Status' });
    expect(select).toHaveFocus();
    expect(screen.getByRole('option', { name: 'done' })).toBeInTheDocument();
    await user.selectOptions(select, 'done');
    expect(writes).toEqual([{ itemId: 'item-a', bag: { status: 'done' } }]);
    await user.keyboard('{Escape}');
    await act(async () => {
      await new Promise(requestAnimationFrame);
    });
    expect(grid()).toHaveFocus();
    pressOnGrid('ArrowDown');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stores checkbox and multiple choices as booleans and arrays', async () => {
    const user = userEvent.setup();
    renderAt(
      sheetWith({
        items: [typedAlpha],
        schema: typedSchema,
        view: aView({ kind: 'sheet', columns: ['done', 'tags'] }),
      }),
    );
    await user.click(screen.getByRole('gridcell', { name: 'Done for Alpha, No' }));
    await user.click(screen.getByRole('checkbox', { name: 'Done' }));
    expect(writes.at(-1)).toEqual({ itemId: 'item-a', bag: { done: true } });
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('gridcell', { name: 'Tags for Alpha' }));
    await user.click(screen.getByRole('checkbox', { name: 'red' }));
    await user.click(screen.getByRole('checkbox', { name: 'blue' }));
    expect(writes.at(-1)).toEqual({ itemId: 'item-a', bag: { tags: ['red', 'blue'] } });
  });

  it('offers date, numeric priority and timestamp controls using the property schema', async () => {
    const user = userEvent.setup();
    renderAt(
      sheetWith({
        items: [typedAlpha],
        schema: typedSchema,
        view: aView({ kind: 'sheet', columns: ['date', 'priority', 'when'] }),
      }),
    );
    await user.click(screen.getByRole('gridcell', { name: 'Date for Alpha, 2026-10-10' }));
    const date = screen.getByLabelText('Date');
    expect(date).toHaveAttribute('type', 'date');
    fireEvent.change(date, { target: { value: '2026-10-15' } });
    expect(writes.at(-1)).toEqual({ itemId: 'item-a', bag: { date: '2026-10-15' } });
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('gridcell', { name: 'Priority for Alpha' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), '2');
    expect(writes.at(-1)).toEqual({ itemId: 'item-a', bag: { priority: 2 } });
    await user.keyboard('{Escape}');
    fireEvent.scroll(grid(), { target: { scrollLeft: 400 } });
    fireEvent.mouseDown(screen.getByRole('gridcell', { name: 'When for Alpha' }));
    expect(screen.getByRole('dialog', { name: 'Edit When for Alpha' })).toBeInTheDocument();
    expect(screen.getByLabelText('Date and time')).toHaveAttribute('type', 'datetime-local');
  });

  it('settles a numeric draft on click-away and starts the next row with its own value', async () => {
    const user = userEvent.setup();
    const beta = item('item-b', 'Beta', 2, { count: 3 });
    renderAt(
      sheetWith({
        items: [typedAlpha, beta],
        schema: typedSchema,
        view: aView({ kind: 'sheet', columns: ['count'] }),
      }),
    );
    await user.click(screen.getByRole('gridcell', { name: 'Count for Alpha, 3' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Count' }), {
      target: { value: '7.5' },
    });
    await user.click(screen.getByRole('gridcell', { name: 'Count for Beta, 3' }));
    expect(writes).toEqual([{ itemId: 'item-a', bag: { count: 7.5 } }]);
    expect(screen.getByRole('spinbutton', { name: 'Count' })).toHaveValue(3);
    await user.keyboard('{Escape}');
    expect(writes).toHaveLength(1);
  });

  it('keeps formulas and unknown property types read-only while allowing typed pickers', () => {
    renderAt(
      sheetWith({
        items: [typedAlpha],
        schema: typedSchema,
        view: aView({ kind: 'sheet', columns: ['total'] }),
      }),
    );
    fireEvent.mouseDown(screen.getByRole('gridcell', { name: 'Total for Alpha, 8' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Total for Alpha' })).toBeDisabled();
    expect(writes).toEqual([]);
  });
});

describe('ranges and the clipboard', () => {
  it('copies the selected range as TSV', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    grid().focus();
    pressOnGrid('ArrowDown', { shiftKey: true });
    pressOnGrid('ArrowRight', { shiftKey: true });

    const setData = vi.fn();
    fireEvent.copy(grid(), { clipboardData: { setData } });

    expect(setData).toHaveBeenCalledWith('text/plain', 'Alpha\topen\nBeta\tdone');
    expect(screen.getByRole('status')).toHaveTextContent('Copied 4 cells.');
  });

  it('clears the copy notice on the next key so a repeated copy is announced again', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));
    grid().focus();
    fireEvent.copy(grid(), { clipboardData: { setData: vi.fn() } });
    expect(screen.getByRole('status')).toHaveTextContent('Copied 1 cell.');

    pressOnGrid('c', { ctrlKey: true });

    expect(screen.getByRole('status')).toHaveTextContent(/^$/);
  });

  it('gives the column resize handle a touch-sized target', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));
    expect(screen.getAllByRole('separator')[0]).toHaveClass('any-pointer-coarse:w-(--control-lg)');
  });

  it('pastes a block as one write per row, coerced per column', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    grid().focus();
    pressOnGrid('ArrowRight');

    fireEvent.paste(grid(), {
      clipboardData: { getData: () => 'held\t9\nopen\t8' },
    });

    expect(writes).toEqual([
      { itemId: 'item-a', bag: { status: 'held', count: 9 } },
      { itemId: 'item-b', bag: { status: 'open', count: 8 } },
    ]);
  });

  it('says out loud when a pasted value could not become the column value, and stays quiet about structure', async () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    grid().focus();
    pressOnGrid('ArrowRight');

    // Row one carries a number column value that is not a number; the rest of the block is fine.
    // Only the value is worth a sentence - a paste that brushes read-only ground is not a failure.
    fireEvent.paste(grid(), { clipboardData: { getData: () => 'held\ttwelve\nopen' } });

    expect(writes).toEqual([
      { itemId: 'item-a', bag: { status: 'held' } },
      { itemId: 'item-b', bag: { status: 'open' } },
    ]);
    expect(
      await screen.findByText('One value could not be taken and was left as it was.'),
    ).toBeInTheDocument();
  });

  it('answers a refused batch with one sentence naming the row, not a race of notices', async () => {
    renderAt(sheetWith({ items: [ALPHA, BETA], refuse: 'Not one of the options.' }));

    grid().focus();
    pressOnGrid('ArrowRight');

    fireEvent.paste(grid(), { clipboardData: { getData: () => 'held\nheld' } });

    expect(
      await screen.findByText('2 of 2 rows were refused - Alpha: Not one of the options.'),
    ).toBeInTheDocument();
    // Rolled back: both rows show what is really stored.
    expect(screen.getByRole('gridcell', { name: 'Status for Alpha, open' })).toBeInTheDocument();
    expect(screen.getByRole('gridcell', { name: 'Status for Beta, done' })).toBeInTheDocument();
  });

  it('answers a lone Ctrl+D rather than silently ignoring it', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    grid().focus();
    pressOnGrid('d', { ctrlKey: true });

    expect(writes).toEqual([]);
    expect(
      screen.getByText('Select rows to fill down: the first row of the selection is the pattern.'),
    ).toBeInTheDocument();
  });

  it('fills the range down from its first row on the incumbent shortcut', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    grid().focus();
    pressOnGrid('ArrowRight');
    pressOnGrid('ArrowDown', { shiftKey: true });
    pressOnGrid('d', { ctrlKey: true });

    expect(writes).toEqual([{ itemId: 'item-b', bag: { status: 'open' } }]);
  });

  it('clears the selected range on Delete, leaving the read-only title alone', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    grid().focus();
    pressOnGrid('End'); // whole row to the last column
    pressOnGrid('Home', { shiftKey: true });
    pressOnGrid('Delete');

    expect(writes).toEqual([{ itemId: 'item-a', bag: { status: null, count: null } }]);
  });
});

describe('sorting', () => {
  it('writes a header click to the URL, where the sort lives', () => {
    renderAt(
      <>
        {sheetWith({ items: [ALPHA, BETA] })}
        <CurrentSearch />
      </>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Count' }));

    // Two status regions exist by design - the grid's own notice and this probe - so the address
    // is read from whichever of them carries it.
    const addresses = screen.getAllByRole('status').map((region) => region.textContent);
    expect(addresses.some((text) => text.includes('sort=count'))).toBe(true);
  });

  it('orders rows by the view sort when the URL says nothing', () => {
    // Both rows carry a value, so the assertion can only pass through the sort itself - with one
    // blank the empties-last rule would put Alpha first under either direction.
    renderAt(
      sheetWith({
        items: [item('item-a', 'Alpha', 1, { count: 3 }), item('item-b', 'Beta', 2, { count: 9 })],
        view: aView({ kind: 'sheet', sortBy: 'count', sortDescending: true }),
      }),
    );

    const rows = screen.getAllByRole('row');
    expect(rows[0]?.textContent).toContain('Beta');
    expect(rows[1]?.textContent).toContain('Alpha');
  });
});

describe('honesty around the edges', () => {
  it('answers typing over a title instead of swallowing the keystroke', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    grid().focus();
    pressOnGrid('n');

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(
      screen.getByText('A row’s name is changed in the item itself - press Enter to open it.'),
    ).toBeInTheDocument();
  });

  it('commits a click-away edit exactly once', async () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));

    grid().focus();
    pressOnGrid('ArrowRight');
    pressOnGrid('b');

    const editor = screen.getByRole('textbox', { name: 'Edit Status for Alpha' });
    fireEvent.change(editor, { target: { value: 'blocked' } });

    // Clicking another cell: the focus transfer fires the editor's blur first, then the cell's
    // own handler runs - the settled flag is what keeps that from being two commits.
    fireEvent.mouseDown(screen.getByRole('gridcell', { name: 'Status for Beta, done' }));

    expect(writes).toEqual([{ itemId: 'item-a', bag: { status: 'blocked' } }]);
    expect(screen.queryByRole('textbox')).toBeNull();
    await Promise.resolve();
  });

  it('says the list is partial when the container was truncated by paging', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA], truncated: true }));

    expect(screen.getByText(/Only the first 2 items in here are loaded\./)).toBeInTheDocument();
  });

  it('offers the keyboard model somewhere a sighted visitor can find it', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    expect(screen.getByText('Keyboard')).toBeInTheDocument();
    // Twice by design: once in the sr-only hint, once in the visible disclosure.
    expect(screen.getAllByText(/fills down/).length).toBeGreaterThanOrEqual(2);
  });
});

describe('reaching editing and opening by pointer alone', () => {
  it('applies a numeric property edit with a visible control and writes once', async () => {
    const user = userEvent.setup();
    renderAt(sheetWith({ items: [ALPHA] }));
    await user.click(screen.getByRole('gridcell', { name: 'Count for Alpha, 3' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Count' }), {
      target: { value: '7' },
    });
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(writes).toEqual([{ itemId: 'item-a', bag: { count: 7 } }]);
  });

  it('cancels an unsent numeric draft with Escape without blur committing', async () => {
    const user = userEvent.setup();
    renderAt(sheetWith({ items: [ALPHA] }));
    await user.click(screen.getByRole('gridcell', { name: 'Count for Alpha, 3' }));
    const editor = screen.getByRole('spinbutton', { name: 'Count' });
    fireEvent.change(editor, { target: { value: '7' } });
    await user.keyboard('{Escape}');
    expect(writes).toEqual([]);
    expect(screen.queryByRole('spinbutton', { name: 'Count' })).toBeNull();
  });

  it('opens the held row without selecting or opening a different row', () => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn();
      renderAt(sheetWith({ items: [ALPHA, BETA], onOpen }));
      fireEvent.pointerDown(screen.getByRole('gridcell', { name: 'Status for Beta, done' }), {
        pointerType: 'touch',
        isPrimary: true,
        clientX: 20,
        clientY: 20,
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.click(screen.getByRole('menuitem', { name: 'Open Beta' }));
      expect(onOpen).toHaveBeenCalledExactlyOnceWith('item-b');
      expect(writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('edits the requested property through its context menu and preserves editor focus', async () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));
    grid().focus();
    fireEvent.contextMenu(screen.getByRole('gridcell', { name: 'Status for Beta, done' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit Status' }));
    const editor = screen.getByRole('textbox', { name: 'Edit Status for Beta' });
    await act(async () => {
      await new Promise(requestAnimationFrame);
    });
    expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: 'open' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(writes).toEqual([{ itemId: 'item-b', bag: { status: 'open' } }]);
  });

  it('clears the requested property through the existing bulk-write path', () => {
    renderAt(sheetWith({ items: [ALPHA, BETA] }));
    fireEvent.contextMenu(screen.getByRole('gridcell', { name: 'Count for Alpha, 3' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear Count' }));
    expect(writes).toEqual([{ itemId: 'item-a', bag: { count: null } }]);
  });

  it('keeps computed properties read-only in the context menu', () => {
    const computed = item('item-a', 'Alpha', 1, { total: 8 });
    renderAt(
      sheetWith({ items: [computed], schema: schemaOf(property('total', 'Total', 'formula')) }),
    );
    fireEvent.contextMenu(screen.getByRole('gridcell', { name: 'Total for Alpha, 8' }));
    expect(screen.getByRole('menuitem', { name: 'Edit Total' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Clear Total' })).toBeDisabled();
    expect(writes).toEqual([]);
  });

  it('turns a second tap on the already-active cell into an edit; the first only selects it', () => {
    renderAt(sheetWith({ items: [ALPHA] }));

    const statusCell = screen.getByRole('gridcell', { name: 'Status for Alpha, open' });

    // The first tap brings the grid into focus and selects the cell - no editor yet, the same
    // as a first click always did.
    fireEvent.mouseDown(statusCell);
    expect(screen.queryByRole('textbox', { name: 'Edit Status for Alpha' })).toBeNull();

    // The second tap lands on the cell that is already active: with no double-click and no
    // keyboard involved, that alone is enough to start editing it.
    fireEvent.mouseDown(statusCell);
    expect(screen.getByRole('textbox', { name: 'Edit Status for Alpha' })).toBeInTheDocument();
  });

  it('opens the active row from a visible control, with no double-click or keyboard needed', () => {
    const onOpen = vi.fn();
    renderAt(sheetWith({ items: [ALPHA, BETA], onOpen }));

    fireEvent.click(screen.getByRole('button', { name: 'Open Alpha' }));

    expect(onOpen).toHaveBeenCalledWith('item-a');
  });
});
