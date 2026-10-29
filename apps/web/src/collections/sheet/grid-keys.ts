import type { CellRef } from '@nix/sheet';

import type { GridBounds, SelectionAction } from './selection';

/**
 * The keyboard ladder both grids share, as a pure function.
 *
 * The spreadsheet body and the spreadsheet view carry the same navigation model on purpose - the
 * arrows, the jumps, Tab-as-cell-movement, Enter and F2, the page keys, printable-starts-an-edit
 * with the IME guard. It began as two near-verbatim copies of one handler, which meant the next
 * Shift+Home fix or IME correction had to be found and made twice with nothing holding the copies
 * in step. This function is the one copy; each host handles only the keys that are genuinely its
 * own (undo/redo in the body, fill-down in the view, Escape's focus behaviour in both) and passes
 * the rest through here.
 *
 * Escape and the modifier chords are deliberately not handled: what Escape does to focus is host
 * policy, and a chord like Ctrl+D or Ctrl+Z acts on the host's document, not on the selection.
 */

export interface GridKey {
  readonly key: string;
  readonly shiftKey: boolean;

  /** Cmd or Ctrl - the jump modifier. */
  readonly meta: boolean;

  /** Whether an IME composition is in flight, in which case a printable key is not a keystroke. */
  readonly isComposing: boolean;
}

export interface GridKeyContext {
  readonly active: CellRef;
  readonly bounds: GridBounds;

  /** How many rows one PageUp or PageDown moves. */
  readonly pageRows: number;

  readonly isOccupied: (ref: CellRef) => boolean;
}

export type GridKeyResult =
  /** Dispatch this to the selection reducer. */
  | { readonly kind: 'action'; readonly action: SelectionAction }

  /**
   * Begin an edit. For `typing` the draft is the keystroke; for `open` (Enter, F2) the draft is
   * empty and the host substitutes the active cell's own text - only the host knows what that is.
   */
  | { readonly kind: 'edit'; readonly source: 'typing' | 'open'; readonly draft: string }

  /** Clear the selected range, whatever clearing means to the host. */
  | { readonly kind: 'clear' }

  /** Not a key this ladder knows; the host decides, including doing nothing. */
  | null;

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

export function gridKeyAction(event: GridKey, context: GridKeyContext): GridKeyResult {
  const { key, shiftKey, meta, isComposing } = event;
  const { active, bounds, pageRows, isOccupied } = context;

  const arrow = ARROWS[key];
  if (arrow !== undefined) {
    const [dRow, dCol] = arrow;
    return {
      kind: 'action',
      action: meta
        ? { type: 'jump', dRow, dCol, extend: shiftKey, bounds, isOccupied }
        : { type: 'move', dRow, dCol, extend: shiftKey, bounds },
    };
  }

  if (key === 'Tab') {
    return {
      kind: 'action',
      action: { type: 'move', dRow: 0, dCol: shiftKey ? -1 : 1, extend: false, bounds },
    };
  }

  if (key === 'Enter' || key === 'F2') {
    return { kind: 'edit', source: 'open', draft: '' };
  }

  if (key === 'Delete' || key === 'Backspace') {
    return { kind: 'clear' };
  }

  if (key === 'Home') {
    return {
      kind: 'action',
      action: {
        type: 'moveTo',
        ref: { row: meta ? 0 : active.row, col: 0 },
        extend: shiftKey,
      },
    };
  }

  if (key === 'End') {
    return {
      kind: 'action',
      action: {
        type: 'moveTo',
        ref: { row: meta ? bounds.rows - 1 : active.row, col: bounds.cols - 1 },
        extend: shiftKey,
      },
    };
  }

  if (key === 'PageDown' || key === 'PageUp') {
    return {
      kind: 'action',
      action: {
        type: 'move',
        dRow: key === 'PageDown' ? pageRows : -pageRows,
        dCol: 0,
        extend: shiftKey,
        bounds,
      },
    };
  }

  // A printable character starts an edit that replaces the cell. Copy and paste arrive as
  // clipboard events, not here. isComposing so an IME's first keystroke (Japanese, Chinese,
  // Korean) does not open an edit with a stray character already in it.
  if (!meta && !isComposing && key.length === 1) {
    return { kind: 'edit', source: 'typing', draft: key };
  }

  return null;
}
