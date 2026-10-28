import { nixSchema, parseDocument } from '@nix/editor-schema';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import {
  COLUMN_WIDTH_STEP,
  DEFAULT_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  changeColumnWidthTr,
} from '@nix/web-editor/editor/column-width';
import { tableContext } from '@nix/web-editor/editor/table-controls';
import { paragraph } from '../paragraph-fixture';

/**
 * `changeColumnWidthTr`'s transform, at the layer that has no DOM - the counterpart to
 * `move-block.test.ts` for the resize handle's menu alternative.
 *
 * What this checks is the arithmetic the table menu's and the toolbar's "Narrower"/"Wider"/
 * "Reset" all call: that a step moves every cell of the current column by the same amount and no
 * other column's, that the floor holds, that a spanning cell's own `colwidth` entry is the one
 * that changes and not its neighbour's, and that "Reset" actually clears the attribute rather
 * than writing a zero that would render the same as never having been touched but read back
 * differently.
 */

function cell(
  kind: 'tableCell' | 'tableHeader',
  text: string,
  attrs: { colspan?: number; rowspan?: number; colwidth?: (number | null)[] | null } = {},
): unknown {
  return {
    type: kind,
    attrs: {
      colspan: attrs.colspan ?? 1,
      rowspan: attrs.rowspan ?? 1,
      colwidth: attrs.colwidth ?? null,
      align: null,
    },
    content: [paragraph(text)],
  };
}

/** A plain 2x2 table: a header row, then a row of cells - the shape `fixtures.ts` uses. */
function twoByTwoTable(): unknown {
  return {
    type: 'table',
    content: [
      { type: 'tableRow', content: [cell('tableHeader', 'Name'), cell('tableHeader', 'Value')] },
      { type: 'tableRow', content: [cell('tableCell', 'Answer'), cell('tableCell', '42')] },
    ],
  };
}

/** A table whose header spans both columns, so the row beneath it has the only per-column cells. */
function spanningHeaderTable(): unknown {
  return {
    type: 'table',
    content: [
      { type: 'tableRow', content: [cell('tableHeader', 'Both', { colspan: 2 })] },
      { type: 'tableRow', content: [cell('tableCell', 'Left'), cell('tableCell', 'Right')] },
    ],
  };
}

function stateOf(content: readonly unknown[]): EditorState {
  const parsed = parseDocument({ type: 'doc', content });
  if (!parsed.ok) {
    throw new Error(`The fixture does not parse: ${parsed.error}`);
  }
  return EditorState.create({ schema: nixSchema, doc: parsed.document });
}

/** Puts the caret at the first position inside the text block that reads `text`. */
function withCaretIn(state: EditorState, text: string): EditorState {
  const found: number[] = [];
  state.doc.descendants((node, pos) => {
    if (found.length === 0 && node.isText && node.text === text) {
      found.push(pos);
    }
    return found.length === 0;
  });
  const at = found[0];
  if (at === undefined) {
    throw new Error(`No text node reads "${text}".`);
  }
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
}

function applied(state: EditorState, transform: (tr: Transaction) => boolean): EditorState {
  const tr = state.tr;
  transform(tr);
  return state.apply(tr);
}

/** The `colwidth` attribute of the cell whose text is `text`, or `undefined` if none is found. */
function colwidthOf(state: EditorState, text: string): (number | null)[] | null | undefined {
  let found: (number | null)[] | null | undefined;
  state.doc.descendants((node) => {
    if (found !== undefined) {
      return false;
    }
    if (
      (node.type.name === 'tableCell' || node.type.name === 'tableHeader') &&
      node.textContent === text
    ) {
      found = node.attrs.colwidth as (number | null)[] | null;
    }
    return found === undefined;
  });
  return found;
}

/** Runs one `changeColumnWidthTr` from wherever the caret in `text` currently sits. */
function changeFrom(
  state: EditorState,
  text: string,
  action: 'narrower' | 'wider' | 'reset',
): EditorState {
  const caretState = withCaretIn(state, text);
  const context = tableContext(caretState);
  if (context?.cell === null || context === null) {
    throw new Error(`"${text}" is not inside a table cell.`);
  }
  const cell = context.cell;
  return applied(caretState, (tr) =>
    changeColumnWidthTr(tr, context.table, context.start, cell, action, true),
  );
}

describe('changeColumnWidthTr', () => {
  it('widens every cell in the current column, from the unset default', () => {
    const widened = changeFrom(stateOf([twoByTwoTable()]), 'Name', 'wider');

    expect(colwidthOf(widened, 'Name')).toEqual([DEFAULT_COLUMN_WIDTH + COLUMN_WIDTH_STEP]);
    expect(colwidthOf(widened, 'Answer')).toEqual([DEFAULT_COLUMN_WIDTH + COLUMN_WIDTH_STEP]);
  });

  it('leaves the other column alone', () => {
    const widened = changeFrom(stateOf([twoByTwoTable()]), 'Name', 'wider');

    expect(colwidthOf(widened, 'Value')).toBeNull();
    expect(colwidthOf(widened, '42')).toBeNull();
  });

  it('narrows a column that was just widened, by one step', () => {
    const widened = changeFrom(stateOf([twoByTwoTable()]), 'Name', 'wider');
    const narrowed = changeFrom(widened, 'Name', 'narrower');

    expect(colwidthOf(narrowed, 'Name')).toEqual([DEFAULT_COLUMN_WIDTH]);
  });

  it('refuses to narrow a column past the floor', () => {
    let state = stateOf([twoByTwoTable()]);
    for (let i = 0; i < 5; i += 1) {
      state = changeFrom(state, 'Name', 'narrower');
    }

    expect(colwidthOf(state, 'Name')).toEqual([MIN_COLUMN_WIDTH]);
  });

  it('clears the width back to unset on reset, not to a zero', () => {
    const widened = changeFrom(stateOf([twoByTwoTable()]), 'Name', 'wider');
    const reset = changeFrom(widened, 'Name', 'reset');

    expect(colwidthOf(reset, 'Name')).toBeNull();
  });

  it('changes every row of the column, not only the cell the caret sits in', () => {
    const widened = changeFrom(stateOf([twoByTwoTable()]), 'Answer', 'wider');

    // "Answer" is the second row; the header above it shares its column and should move too.
    expect(colwidthOf(widened, 'Name')).toEqual([DEFAULT_COLUMN_WIDTH + COLUMN_WIDTH_STEP]);
  });

  it('resizes only the spanned column of a cell that covers more than one', () => {
    const widened = changeFrom(stateOf([spanningHeaderTable()]), 'Right', 'wider');

    // "Right" is the second column; the spanning header's second `colwidth` entry is the one
    // that moves, and its first entry - the column "Left" is in - stays the unset `0` that
    // marks an untouched entry inside an otherwise-set array (prosemirror-tables' own reading
    // of the attribute treats it the same as `null` either way).
    expect(colwidthOf(widened, 'Both')).toEqual([0, DEFAULT_COLUMN_WIDTH + COLUMN_WIDTH_STEP]);
    expect(colwidthOf(widened, 'Left')).toBeNull();
    expect(colwidthOf(widened, 'Right')).toEqual([DEFAULT_COLUMN_WIDTH + COLUMN_WIDTH_STEP]);
  });

  it('refuses when the position given names no cell', () => {
    const state = withCaretIn(stateOf([twoByTwoTable()]), 'Name');
    const context = tableContext(state);
    if (context === null) {
      throw new Error('expected a table context');
    }

    const tr = state.tr;
    const changed = changeColumnWidthTr(tr, context.table, context.start, 9999, 'wider', true);

    expect(changed).toBe(false);
    expect(tr.docChanged).toBe(false);
  });

  it('reports whether a resize is possible without writing anything, when apply is false', () => {
    const state = withCaretIn(stateOf([twoByTwoTable()]), 'Name');
    const context = tableContext(state);
    if (context?.cell === null || context === null) {
      throw new Error('expected a table context with a cell');
    }

    const tr = state.tr;
    const possible = changeColumnWidthTr(
      tr,
      context.table,
      context.start,
      context.cell,
      'wider',
      false,
    );

    expect(possible).toBe(true);
    expect(tr.docChanged).toBe(false);
    expect(colwidthOf(state, 'Name')).toBeNull();
  });
});
