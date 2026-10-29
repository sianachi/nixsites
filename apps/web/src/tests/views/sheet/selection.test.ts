import { describe, expect, it } from 'vitest';

import {
  INITIAL_SELECTION,
  type GridBounds,
  type SelectionState,
  selectedRange,
  selectionReducer,
} from '../../../collections/sheet/selection';

const bounds: GridBounds = { rows: 100, cols: 26 };

function at(row: number, col: number): SelectionState {
  return { ...INITIAL_SELECTION, active: { row, col } };
}

describe('moving the active cell', () => {
  it('moves by arrows and stays inside the grid', () => {
    let state = INITIAL_SELECTION;
    state = selectionReducer(state, { type: 'move', dRow: -1, dCol: 0, extend: false, bounds });
    expect(state.active).toEqual({ row: 0, col: 0 });
    state = selectionReducer(state, { type: 'move', dRow: 1, dCol: 1, extend: false, bounds });
    expect(state.active).toEqual({ row: 1, col: 1 });
  });

  it('collapses any range when moving without Shift', () => {
    let state: SelectionState = { ...at(2, 2), anchor: { row: 5, col: 5 } };
    state = selectionReducer(state, { type: 'move', dRow: 1, dCol: 0, extend: false, bounds });
    expect(state.anchor).toBeNull();
  });

  it('extends a range from the anchor with Shift, active cell unmoved', () => {
    let state = at(2, 2);
    state = selectionReducer(state, { type: 'move', dRow: 1, dCol: 0, extend: true, bounds });
    state = selectionReducer(state, { type: 'move', dRow: 1, dCol: 1, extend: true, bounds });
    expect(state.active).toEqual({ row: 2, col: 2 });
    expect(state.anchor).toEqual({ row: 4, col: 3 });
    expect(selectedRange(state)).toEqual({ startRow: 2, endRow: 4, startCol: 2, endCol: 3 });
  });

  it('does not move while an edit is open', () => {
    const editing: SelectionState = { ...at(1, 1), mode: 'edit', draft: 'x' };
    const state = selectionReducer(editing, {
      type: 'move',
      dRow: 1,
      dCol: 0,
      extend: false,
      bounds,
    });
    expect(state.active).toEqual({ row: 1, col: 1 });
  });
});

describe('jumping to edges', () => {
  const occupied = new Set(['1:0', '2:0', '3:0', '7:0']);
  const isOccupied = (ref: { row: number; col: number }): boolean =>
    occupied.has(`${String(ref.row)}:${String(ref.col)}`);

  it('runs to the end of a contiguous block', () => {
    const state = selectionReducer(at(1, 0), {
      type: 'jump',
      dRow: 1,
      dCol: 0,
      extend: false,
      bounds,
      isOccupied,
    });
    expect(state.active).toEqual({ row: 3, col: 0 });
  });

  it('runs from a gap to the next occupied cell', () => {
    const state = selectionReducer(at(4, 0), {
      type: 'jump',
      dRow: 1,
      dCol: 0,
      extend: false,
      bounds,
      isOccupied,
    });
    expect(state.active).toEqual({ row: 7, col: 0 });
  });

  it('runs to the grid edge when nothing lies ahead', () => {
    const state = selectionReducer(at(8, 0), {
      type: 'jump',
      dRow: 1,
      dCol: 0,
      extend: false,
      bounds,
      isOccupied,
    });
    expect(state.active).toEqual({ row: 99, col: 0 });
  });
});

describe('the edit lifecycle', () => {
  it('opens, drafts, and commits downward', () => {
    let state = at(3, 3);
    state = selectionReducer(state, { type: 'startEdit', draft: '=1', source: 'typing' });
    expect(state.mode).toBe('edit');
    state = selectionReducer(state, { type: 'setDraft', draft: '=1+2' });
    expect(state.draft).toBe('=1+2');
    state = selectionReducer(state, { type: 'commit', then: 'down', bounds });
    expect(state.mode).toBe('nav');
    expect(state.active).toEqual({ row: 4, col: 3 });
  });

  it('commits rightward on Tab and stays on blur', () => {
    let state = selectionReducer(at(3, 3), { type: 'startEdit', draft: 'x', source: 'open' });
    state = selectionReducer(state, { type: 'commit', then: 'right', bounds });
    expect(state.active).toEqual({ row: 3, col: 4 });

    let stayed = selectionReducer(at(5, 5), { type: 'startEdit', draft: 'y', source: 'open' });
    stayed = selectionReducer(stayed, { type: 'commit', then: 'stay', bounds });
    expect(stayed.active).toEqual({ row: 5, col: 5 });
  });

  it('abandons the draft on cancel', () => {
    let state = selectionReducer(at(3, 3), { type: 'startEdit', draft: 'oops', source: 'typing' });
    state = selectionReducer(state, { type: 'cancel' });
    expect(state.mode).toBe('nav');
    expect(state.draft).toBe('');
    expect(state.active).toEqual({ row: 3, col: 3 });
  });
});
