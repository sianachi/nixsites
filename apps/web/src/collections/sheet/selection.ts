import { type CellRange, type CellRef, normalizeRange } from '@nix/sheet';

/**
 * The grid's keyboard model as a pure reducer, so every movement rule is a
 * unit test rather than an event handler's side effect.
 *
 * Two modes. In `nav`, arrows move the active cell, Shift extends a range
 * from the anchor, and typing starts an edit. In `edit`, the draft belongs
 * to the cell until Enter or Tab commits it or Escape abandons it; the
 * reducer records where focus goes next and the component performs the
 * write, because the document lives outside this file on purpose.
 */

export interface SelectionState {
  readonly active: CellRef;
  /** The far corner of a range selection, or null when one cell is selected. */
  readonly anchor: CellRef | null;
  readonly mode: 'nav' | 'edit';
  readonly draft: string;
  /**
   * How the edit began: typing replaces the cell, Enter or F2 keeps it, and
   * 'bar' means the formula bar itself is where the draft is being typed -
   * the grid's overlay input must not steal focus back from it.
   */
  readonly editSource: 'typing' | 'open' | 'bar';
}

export interface GridBounds {
  readonly rows: number;
  readonly cols: number;
}

export type SelectionAction =
  | {
      readonly type: 'move';
      readonly dRow: number;
      readonly dCol: number;
      readonly extend: boolean;
      readonly bounds: GridBounds;
    }
  | { readonly type: 'moveTo'; readonly ref: CellRef; readonly extend: boolean }
  | {
      readonly type: 'jump';
      readonly dRow: number;
      readonly dCol: number;
      readonly extend: boolean;
      readonly bounds: GridBounds;
      readonly isOccupied: (ref: CellRef) => boolean;
    }
  | {
      readonly type: 'startEdit';
      readonly draft: string;
      readonly source: 'typing' | 'open' | 'bar';
    }
  | { readonly type: 'setDraft'; readonly draft: string }
  | {
      readonly type: 'commit';
      readonly then: 'down' | 'right' | 'stay';
      readonly bounds: GridBounds;
    }
  | { readonly type: 'cancel' };

export const INITIAL_SELECTION: SelectionState = {
  active: { row: 0, col: 0 },
  anchor: null,
  mode: 'nav',
  draft: '',
  editSource: 'open',
};

/** A ref forced inside the bounds. Exported for hosts whose bounds move under the selection. */
export function clamp(ref: CellRef, bounds: GridBounds): CellRef {
  return {
    row: Math.max(0, Math.min(bounds.rows - 1, ref.row)),
    col: Math.max(0, Math.min(bounds.cols - 1, ref.col)),
  };
}

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'move': {
      if (state.mode === 'edit') {
        return state;
      }
      const target = clamp(
        { row: state.active.row + action.dRow, col: state.active.col + action.dCol },
        action.bounds,
      );
      return {
        ...state,
        active: action.extend ? state.active : target,
        anchor: action.extend ? clampAnchor(state, action.bounds, action.dRow, action.dCol) : null,
      };
    }
    case 'moveTo':
      return {
        ...state,
        mode: 'nav',
        draft: '',
        active: action.extend ? state.active : action.ref,
        anchor: action.extend ? action.ref : null,
      };
    case 'jump': {
      if (state.mode === 'edit') {
        return state;
      }
      const from = action.extend ? (state.anchor ?? state.active) : state.active;
      const target = jumpTarget(from, action, action.bounds);
      return {
        ...state,
        active: action.extend ? state.active : target,
        anchor: action.extend ? target : null,
      };
    }
    case 'startEdit':
      return {
        ...state,
        mode: 'edit',
        draft: action.draft,
        editSource: action.source,
        anchor: null,
      };
    case 'setDraft':
      return state.mode === 'edit' ? { ...state, draft: action.draft } : state;
    case 'commit': {
      if (state.mode !== 'edit') {
        return state;
      }
      const step =
        action.then === 'down'
          ? { row: state.active.row + 1, col: state.active.col }
          : action.then === 'right'
            ? { row: state.active.row, col: state.active.col + 1 }
            : state.active;
      return {
        ...state,
        mode: 'nav',
        draft: '',
        active: clamp(step, action.bounds),
        anchor: null,
      };
    }
    case 'cancel':
      return state.mode === 'edit' ? { ...state, mode: 'nav', draft: '' } : state;
  }
}

/** Shift+arrow moves the anchor corner, starting one from the active cell. */
function clampAnchor(
  state: SelectionState,
  bounds: GridBounds,
  dRow: number,
  dCol: number,
): CellRef {
  const from = state.anchor ?? state.active;
  return clamp({ row: from.row + dRow, col: from.col + dCol }, bounds);
}

/**
 * Ctrl/Cmd+arrow: to the edge of the occupied block, or to the grid edge
 * when the path is empty - the incumbents' rule, which is what fingers
 * expect.
 */
function jumpTarget(
  from: CellRef,
  action: { dRow: number; dCol: number; isOccupied: (ref: CellRef) => boolean },
  bounds: GridBounds,
): CellRef {
  const step = (ref: CellRef): CellRef => ({
    row: ref.row + action.dRow,
    col: ref.col + action.dCol,
  });
  const inBounds = (ref: CellRef): boolean =>
    ref.row >= 0 && ref.row < bounds.rows && ref.col >= 0 && ref.col < bounds.cols;

  let current = from;
  const next = step(current);
  if (!inBounds(next)) {
    return current;
  }
  // Standing on content and the neighbor has content: run to the end of the
  // block. Otherwise: run to the next content, or the edge.
  const runningThroughContent = action.isOccupied(current) && action.isOccupied(next);
  current = next;
  while (inBounds(step(current))) {
    const ahead = step(current);
    if (runningThroughContent) {
      if (!action.isOccupied(ahead)) {
        return current;
      }
    } else if (action.isOccupied(current)) {
      return current;
    }
    current = ahead;
  }
  return current;
}

/** The selected rectangle: the active cell alone, or active-to-anchor. */
export function selectedRange(state: SelectionState): CellRange {
  return normalizeRange(state.active, state.anchor ?? state.active);
}
