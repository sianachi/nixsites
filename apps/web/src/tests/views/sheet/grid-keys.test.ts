import { describe, expect, it } from 'vitest';

import { gridKeyAction, type GridKey } from '../../../collections/sheet/grid-keys';

/**
 * The keyboard ladder both grids share. The two host suites exercise it end to end; these pin the
 * pure mapping itself, so a change here fails a test naming the key rather than a grid test that
 * happens to walk past it.
 */

const CONTEXT = {
  active: { row: 2, col: 1 },
  bounds: { rows: 10, cols: 4 },
  pageRows: 5,
  isOccupied: () => false,
};

function key(overrides: Partial<GridKey> & { key: string }): GridKey {
  return { shiftKey: false, meta: false, isComposing: false, ...overrides };
}

describe('the shared grid key ladder', () => {
  it('maps a plain arrow to a move and a modified one to a jump', () => {
    expect(gridKeyAction(key({ key: 'ArrowDown' }), CONTEXT)).toMatchObject({
      kind: 'action',
      action: { type: 'move', dRow: 1, dCol: 0, extend: false },
    });
    expect(
      gridKeyAction(key({ key: 'ArrowRight', meta: true, shiftKey: true }), CONTEXT),
    ).toMatchObject({
      kind: 'action',
      action: { type: 'jump', dRow: 0, dCol: 1, extend: true },
    });
  });

  it('keeps Tab as a cell movement, never an edit or an exit', () => {
    expect(gridKeyAction(key({ key: 'Tab', shiftKey: true }), CONTEXT)).toMatchObject({
      action: { type: 'move', dRow: 0, dCol: -1 },
    });
  });

  it('opens an edit on Enter and F2 with the draft left to the host', () => {
    expect(gridKeyAction(key({ key: 'Enter' }), CONTEXT)).toEqual({
      kind: 'edit',
      source: 'open',
      draft: '',
    });
    expect(gridKeyAction(key({ key: 'F2' }), CONTEXT)).toEqual({
      kind: 'edit',
      source: 'open',
      draft: '',
    });
  });

  it('starts a typing edit from a printable key, but never mid-composition', () => {
    expect(gridKeyAction(key({ key: 'x' }), CONTEXT)).toEqual({
      kind: 'edit',
      source: 'typing',
      draft: 'x',
    });
    expect(gridKeyAction(key({ key: 'x', isComposing: true }), CONTEXT)).toBeNull();
    expect(gridKeyAction(key({ key: 'x', meta: true }), CONTEXT)).toBeNull();
  });

  it('answers Delete and Backspace as a clear for the host to interpret', () => {
    expect(gridKeyAction(key({ key: 'Delete' }), CONTEXT)).toEqual({ kind: 'clear' });
    expect(gridKeyAction(key({ key: 'Backspace' }), CONTEXT)).toEqual({ kind: 'clear' });
  });

  it('sends Home and End along the row, and to the corners with the modifier', () => {
    expect(gridKeyAction(key({ key: 'Home' }), CONTEXT)).toMatchObject({
      action: { type: 'moveTo', ref: { row: 2, col: 0 } },
    });
    expect(gridKeyAction(key({ key: 'End', meta: true }), CONTEXT)).toMatchObject({
      action: { type: 'moveTo', ref: { row: 9, col: 3 } },
    });
  });

  it('pages by the viewport, not by a constant', () => {
    expect(gridKeyAction(key({ key: 'PageDown' }), CONTEXT)).toMatchObject({
      action: { type: 'move', dRow: 5 },
    });
    expect(gridKeyAction(key({ key: 'PageUp', shiftKey: true }), CONTEXT)).toMatchObject({
      action: { type: 'move', dRow: -5, extend: true },
    });
  });

  it('declines what is host policy - Escape, and the modifier chords', () => {
    expect(gridKeyAction(key({ key: 'Escape' }), CONTEXT)).toBeNull();
    expect(gridKeyAction(key({ key: 'z', meta: true }), CONTEXT)).toBeNull();
    expect(gridKeyAction(key({ key: 'd', meta: true }), CONTEXT)).toBeNull();
  });
});
