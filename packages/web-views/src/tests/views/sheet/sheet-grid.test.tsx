import { SHEET_COLUMN_WIDTH, readCells, readMeta, setColumnWidth, writeCell } from '@nix/sheet';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { COLUMN_RESIZE_STEP } from '../../../sheet/column-resize';
import { SheetGrid } from '../../../sheet/sheet-grid';
import { useSheet } from '../../../sheet/use-sheet';

/**
 * The grid over a real Y.Doc, exactly as the sheet editor composes it - the
 * document is the assertion target for anything that claims to be shared
 * state, because "the header changed" without "the document changed" would
 * pass on a resize that only this tab can see.
 *
 * Drags run against the production path: pointer down on the handle, then
 * move and release on the capture overlay that owns them. The overlay is
 * presentational (aria-hidden, no role - it is a capture surface, not a
 * control), so it is the one element these tests locate structurally rather
 * than by role. Pointer capture itself does not exist in jsdom; what it adds
 * in a real browser is nothing here, because the overlay spans the viewport.
 * Drag previews are asserted with waitFor: moves coalesce to one state write
 * per animation frame.
 */

function Harness({ doc }: { readonly doc: Y.Doc }): ReactNode {
  const sheet = useSheet(doc);
  return <SheetGrid sheet={sheet} />;
}

function renderGrid(doc: Y.Doc): void {
  render(<Harness doc={doc} />);
}

function handleFor(letters: string): HTMLElement {
  return screen.getByRole('separator', { name: `Resize column ${letters}` });
}

function dragOverlay(): HTMLElement {
  const overlay = document.querySelector('div.fixed.inset-0[aria-hidden]');
  if (!(overlay instanceof HTMLElement)) {
    throw new Error('The drag overlay is not mounted; did a pointerdown begin the drag?');
  }
  return overlay;
}

beforeEach(() => {
  // jsdom logs "Not implemented" for canvas getContext; the overflow module's
  // 9px fallback glyph width is what these tests exercise, so answer null
  // quietly.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  // jsdom has no ResizeObserver; the grid only uses it to track viewport
  // size, which stays 0x0 here - the first few rows and columns still render
  // through the overscan.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});

describe('row height', () => {
  const rowHeightOf = (): string => screen.getByRole('gridcell', { name: 'A2' }).style.height;

  it('is 32px for a fine pointer and 44px for a coarse one', () => {
    renderGrid(new Y.Doc());
    expect(rowHeightOf()).toBe('32px');
    cleanup();

    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }));
    try {
      renderGrid(new Y.Doc());
      expect(rowHeightOf()).toBe('44px');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('touch cell actions', () => {
  it('opens actions for the held cell and clears that cell without changing another', () => {
    vi.useFakeTimers();
    try {
      const doc = new Y.Doc();
      writeCell(doc, { row: 0, col: 0 }, 'Keep');
      writeCell(doc, { row: 1, col: 1 }, 'Clear');
      renderGrid(doc);
      fireEvent.pointerDown(screen.getByRole('gridcell', { name: 'B2, Clear' }), {
        pointerType: 'touch',
        isPrimary: true,
        clientX: 20,
        clientY: 20,
      });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByRole('menu', { name: 'Spreadsheet cell actions' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Clear B2' }));
      expect(readCells(doc).get('B2')).toBeUndefined();
      expect(readCells(doc).get('A1')).toBe('Keep');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps focus in the cell editor opened through the context menu', async () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    screen.getByRole('grid').focus();
    fireEvent.contextMenu(screen.getByRole('gridcell', { name: 'B2' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit B2' }));
    const editor = screen.getByRole('textbox', { name: 'Edit cell B2' });
    await act(async () => {
      await new Promise(requestAnimationFrame);
    });
    expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: 'Edited on touch' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(readCells(doc).get('B2')).toBe('Edited on touch');
  });

  it('applies a formula-bar edit from its visible button', async () => {
    const user = userEvent.setup();
    const doc = new Y.Doc();
    renderGrid(doc);
    const formula = screen.getByRole('textbox', { name: 'Formula' });
    await user.click(formula);
    await user.type(formula, '=2+3');
    await user.click(screen.getByRole('button', { name: 'Apply cell edit' }));
    expect(readCells(doc).get('A1')).toBe('=2+3');
    expect(screen.getByRole('gridcell', { name: 'A1, 5' })).toBeInTheDocument();
  });

  it('cancels an inline edit without blur saving the discarded draft', async () => {
    const user = userEvent.setup();
    const doc = new Y.Doc();
    writeCell(doc, { row: 0, col: 0 }, 'Original');
    renderGrid(doc);
    fireEvent.doubleClick(screen.getByRole('gridcell', { name: 'A1, Original' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit cell A1' }), {
      target: { value: 'Discard this' },
    });
    await user.click(screen.getByRole('button', { name: 'Cancel cell edit' }));
    expect(readCells(doc).get('A1')).toBe('Original');
    expect(screen.queryByRole('textbox', { name: 'Edit cell A1' })).toBeNull();
  });
});

describe('column resize handle', () => {
  it('exposes each column edge as a separator carrying the width and its bounds', () => {
    renderGrid(new Y.Doc());
    const handle = handleFor('A');
    expect(handle).toHaveAttribute('aria-valuenow', String(SHEET_COLUMN_WIDTH.default));
    expect(handle).toHaveAttribute('aria-valuemin', String(SHEET_COLUMN_WIDTH.min));
    expect(handle).toHaveAttribute('aria-valuemax', String(SHEET_COLUMN_WIDTH.max));
    expect(handle).toHaveAttribute(
      'aria-valuetext',
      `${String(SHEET_COLUMN_WIDTH.default)} pixels`,
    );
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAccessibleDescription(/arrow keys resize/i);
  });

  it('draws the one hairline weight every drag handle in the product shares', () => {
    // `w-px`, not `w-0.5`, which this used to be: two drag handles of different weights on one
    // screen read as two different kinds of object, and the pane divider beside it draws a
    // hairline. The states come from `dragHandleLineStates`; the weight is the part that constant
    // cannot carry, because the axis differs per handle - so it is pinned here instead.
    renderGrid(new Y.Doc());

    const line = handleFor('A').querySelector('[aria-hidden="true"]');
    expect(line).toBeInstanceOf(HTMLElement);
    expect(line).toHaveClass('w-px');
    expect(line?.className).not.toContain('w-0.5');
  });

  it("puts only the active column's handle in the tab order", () => {
    renderGrid(new Y.Doc());
    expect(handleFor('A')).toHaveAttribute('tabindex', '0');
    expect(handleFor('B')).toHaveAttribute('tabindex', '-1');
    expect(handleFor('C')).toHaveAttribute('tabindex', '-1');
  });

  it('widens the column by one step on ArrowRight and writes it to the shared document', () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    fireEvent.keyDown(handleFor('A'), { key: 'ArrowRight' });
    const expected = SHEET_COLUMN_WIDTH.default + COLUMN_RESIZE_STEP;
    expect(readMeta(doc).colWidths).toEqual({ A: expected });
    expect(handleFor('A')).toHaveAttribute('aria-valuenow', String(expected));
  });

  it('narrows the column by one step on ArrowLeft', () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    fireEvent.keyDown(handleFor('A'), { key: 'ArrowLeft' });
    expect(readMeta(doc).colWidths).toEqual({
      A: SHEET_COLUMN_WIDTH.default - COLUMN_RESIZE_STEP,
    });
  });

  it('treats ArrowUp as widen and ArrowDown as narrow, matching the vertical separator', () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    fireEvent.keyDown(handleFor('A'), { key: 'ArrowUp' });
    expect(readMeta(doc).colWidths).toEqual({
      A: SHEET_COLUMN_WIDTH.default + COLUMN_RESIZE_STEP,
    });
    fireEvent.keyDown(handleFor('A'), { key: 'ArrowDown' });
    expect(readMeta(doc).colWidths).toEqual({ A: SHEET_COLUMN_WIDTH.default });
  });

  it('stops narrowing at the minimum instead of vanishing', () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    fireEvent.keyDown(handleFor('A'), { key: 'Home' });
    expect(readMeta(doc).colWidths).toEqual({ A: SHEET_COLUMN_WIDTH.min });
    fireEvent.keyDown(handleFor('A'), { key: 'ArrowLeft' });
    expect(readMeta(doc).colWidths).toEqual({ A: SHEET_COLUMN_WIDTH.min });
  });

  it('stops widening at the maximum', () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    fireEvent.keyDown(handleFor('B'), { key: 'End' });
    fireEvent.keyDown(handleFor('B'), { key: 'ArrowRight' });
    expect(readMeta(doc).colWidths).toEqual({ B: SHEET_COLUMN_WIDTH.max });
  });

  it('resizes only its own column, leaving neighbours at their stored widths', () => {
    const doc = new Y.Doc();
    setColumnWidth(doc, 'B', 200);
    renderGrid(doc);
    fireEvent.keyDown(handleFor('A'), { key: 'ArrowRight' });
    expect(readMeta(doc).colWidths).toEqual({
      A: SHEET_COLUMN_WIDTH.default + COLUMN_RESIZE_STEP,
      B: 200,
    });
  });

  it('undoes a keyboard resize from the handle itself', () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    fireEvent.keyDown(handleFor('A'), { key: 'ArrowRight' });
    fireEvent.keyDown(handleFor('A'), { key: 'z', ctrlKey: true });
    expect(readMeta(doc).colWidths).toEqual({});
  });

  it('previews a drag live but writes the shared document only on release', async () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    fireEvent.pointerDown(handleFor('A'), { pointerId: 1, clientX: 128 });
    const overlay = dragOverlay();
    fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 168, buttons: 1 });
    await waitFor(() => {
      expect(handleFor('A')).toHaveAttribute(
        'aria-valuenow',
        String(SHEET_COLUMN_WIDTH.default + 40),
      );
    });
    expect(readMeta(doc).colWidths).toEqual({});
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 168, buttons: 1 });
    expect(readMeta(doc).colWidths).toEqual({ A: SHEET_COLUMN_WIDTH.default + 40 });
  });

  it('commits from the release position even when no preview frame has painted it', () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    fireEvent.pointerDown(handleFor('A'), { pointerId: 1, clientX: 128 });
    fireEvent.pointerUp(dragOverlay(), { pointerId: 1, clientX: 152 });
    expect(readMeta(doc).colWidths).toEqual({ A: SHEET_COLUMN_WIDTH.default + 24 });
  });

  it('clamps a drag past the minimum instead of collapsing the column', () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    fireEvent.pointerDown(handleFor('A'), { pointerId: 1, clientX: 500 });
    fireEvent.pointerUp(dragOverlay(), { pointerId: 1, clientX: 0 });
    expect(readMeta(doc).colWidths).toEqual({ A: SHEET_COLUMN_WIDTH.min });
  });

  it('reverts a cancelled drag rather than committing the width it reached', async () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    fireEvent.pointerDown(handleFor('A'), { pointerId: 1, clientX: 128 });
    const overlay = dragOverlay();
    fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 300, buttons: 1 });
    fireEvent.pointerCancel(overlay, { pointerId: 1 });
    await waitFor(() => {
      expect(handleFor('A')).toHaveAttribute('aria-valuenow', String(SHEET_COLUMN_WIDTH.default));
    });
    expect(readMeta(doc).colWidths).toEqual({});
  });

  it('cancels a live drag on Escape, committing nothing', async () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    const handle = handleFor('A');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 128 });
    fireEvent.pointerMove(dragOverlay(), { pointerId: 1, clientX: 300, buttons: 1 });
    fireEvent.keyDown(handle, { key: 'Escape' });
    await waitFor(() => {
      expect(handleFor('A')).toHaveAttribute('aria-valuenow', String(SHEET_COLUMN_WIDTH.default));
    });
    expect(readMeta(doc).colWidths).toEqual({});
    // The overlay is gone: the drag ended rather than lingering over the app.
    expect(document.querySelector('div.fixed.inset-0[aria-hidden]')).toBeNull();
  });

  it('cancels a drag whose button was released outside the window, committing nothing', async () => {
    // Without pointer capture, a mouse released beyond the window edge sends
    // its pointerup where the overlay cannot hear it; the giveaway is the
    // next move arriving with no button held. The phantom drag must end
    // there - not keep resizing under an unpressed mouse until a click
    // commits it.
    const doc = new Y.Doc();
    renderGrid(doc);
    fireEvent.pointerDown(handleFor('A'), { pointerId: 1, clientX: 128 });
    const overlay = dragOverlay();
    fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 300, buttons: 1 });
    fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 400, buttons: 0 });
    await waitFor(() => {
      expect(handleFor('A')).toHaveAttribute('aria-valuenow', String(SHEET_COLUMN_WIDTH.default));
    });
    expect(readMeta(doc).colWidths).toEqual({});
    expect(document.querySelector('div.fixed.inset-0[aria-hidden]')).toBeNull();
  });

  it('renders a colleague-set width without any local interaction', () => {
    const doc = new Y.Doc();
    setColumnWidth(doc, 'A', 240);
    renderGrid(doc);
    expect(handleFor('A')).toHaveAttribute('aria-valuenow', '240');
  });
});

describe('numeric overflow', () => {
  it('shows hash marks for a number too wide for its column, keeping the value in the label', () => {
    const doc = new Y.Doc();
    writeCell(doc, { row: 0, col: 0 }, '123456789012345');
    setColumnWidth(doc, 'A', SHEET_COLUMN_WIDTH.min);
    renderGrid(doc);
    const cell = screen.getByRole('gridcell', { name: 'A1, 123456789012345' });
    expect(cell.textContent).toMatch(/^#+$/);
    expect(cell).toHaveAttribute('title', '123456789012345');
  });

  it('shows a hashed formula cell as its value and its formula on hover', () => {
    const doc = new Y.Doc();
    writeCell(doc, { row: 0, col: 0 }, '=111111*111111');
    setColumnWidth(doc, 'A', SHEET_COLUMN_WIDTH.min);
    renderGrid(doc);
    const cell = screen.getByRole('gridcell', { name: 'A1, 12345654321' });
    expect(cell.textContent).toMatch(/^#+$/);
    expect(cell).toHaveAttribute('title', '12345654321 (=111111*111111)');
  });

  it('shows the number itself once the column is wide enough', () => {
    const doc = new Y.Doc();
    writeCell(doc, { row: 0, col: 0 }, '123456789012345');
    setColumnWidth(doc, 'A', SHEET_COLUMN_WIDTH.max);
    renderGrid(doc);
    const cell = screen.getByRole('gridcell', { name: 'A1, 123456789012345' });
    expect(cell.textContent).toBe('123456789012345');
  });

  it('clips text instead of hashing it', () => {
    const doc = new Y.Doc();
    writeCell(doc, { row: 0, col: 0 }, 'a long sentence wider than any narrow column');
    setColumnWidth(doc, 'A', SHEET_COLUMN_WIDTH.min);
    renderGrid(doc);
    const cell = screen.getByRole('gridcell', { name: /^A1,/ });
    expect(cell.textContent).toBe('a long sentence wider than any narrow column');
  });

  it('never hashes an error code, which must stay readable as an error', () => {
    const doc = new Y.Doc();
    writeCell(doc, { row: 0, col: 0 }, '=1/0');
    setColumnWidth(doc, 'A', SHEET_COLUMN_WIDTH.min);
    renderGrid(doc);
    const cell = screen.getByRole('gridcell', { name: 'A1, #DIV/0!' });
    expect(cell.textContent).toBe('#DIV/0!');
    expect(cell.className).toContain('decoration-dotted');
  });
});

describe('reaching an edit by pointer alone', () => {
  it('turns a second tap on the already-active cell into an edit; the first only selects it', () => {
    const doc = new Y.Doc();
    writeCell(doc, { row: 0, col: 0 }, 'hello');
    renderGrid(doc);

    const cell = screen.getByRole('gridcell', { name: 'A1, hello' });

    // The first tap brings the grid into focus and selects the cell - no editor yet, same as
    // any first click.
    fireEvent.mouseDown(cell);
    expect(screen.queryByRole('textbox', { name: 'Edit cell A1' })).toBeNull();

    // The second tap lands on the cell that is already active: no double-click and no keyboard
    // involved, and that alone is enough to start editing it.
    fireEvent.mouseDown(cell);
    expect(screen.getByRole('textbox', { name: 'Edit cell A1' })).toBeInTheDocument();
  });

  it('shows the copy notice even when the active cell is an error', () => {
    const doc = new Y.Doc();
    writeCell(doc, { row: 0, col: 0 }, '=1/0');
    renderGrid(doc);
    fireEvent.copy(screen.getByRole('grid'), { clipboardData: { setData: vi.fn() } });
    expect(screen.getByText('Copied A1')).toBeInTheDocument();
  });

  it('announces what a copy did, and clears it on the next key', () => {
    const doc = new Y.Doc();
    renderGrid(doc);
    const grid = screen.getByRole('grid');
    fireEvent.copy(grid, { clipboardData: { setData: vi.fn() } });
    expect(screen.getByText('Copied A1')).toBeInTheDocument();
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(screen.queryByText('Copied A1')).toBeNull();
  });
});
