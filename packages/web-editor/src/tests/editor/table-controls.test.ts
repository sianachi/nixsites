import { nixEditingExtensions, nixExtensions } from '@nix/editor-schema';
import { Editor, getSchema } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACTIVE_CELL_CLASS,
  ACTIVE_COLUMN_CLASS,
  ACTIVE_ROW_CLASS,
  ACTIVE_TABLE_CLASS,
  TableControls,
  activeTableDecorations,
  cellCoordinates,
  hasHeaderColumn,
  hasHeaderRow,
  tableContext,
} from '../../editor/table-controls';

/**
 * Where you are in a table, as decorations.
 *
 * Asserted at the decoration layer, against a real editor over the real schema: which cells
 * carry which class for a caret here. The classes' appearance is `prose.ts`'s business.
 */

const schema = getSchema(nixExtensions);

function cell(text: string, header = false): unknown {
  return {
    type: header ? 'tableHeader' : 'tableCell',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** A three-by-three table with a header row; the text in each cell names its place. */
function table(): unknown {
  return {
    type: 'table',
    content: [
      { type: 'tableRow', content: [cell('a1', true), cell('b1', true), cell('c1', true)] },
      { type: 'tableRow', content: [cell('a2'), cell('b2'), cell('c2')] },
      { type: 'tableRow', content: [cell('a3'), cell('b3'), cell('c3')] },
    ],
  };
}

function docOf(content: readonly unknown[]): PMNode {
  return schema.nodeFromJSON({ type: 'doc', content });
}

/** The table at the top of the document, which every table document here starts with. */
function firstTable(editor: Editor): PMNode {
  const node = editor.state.doc.firstChild;
  if (node?.type.name !== 'table') {
    throw new Error('the document does not start with a table');
  }
  return node;
}

const editors: Editor[] = [];

function makeEditor(content: readonly unknown[]): Editor {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [...nixEditingExtensions, TableControls],
    content: docOf(content).toJSON() as Record<string, unknown>,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy();
  }
  document.body.innerHTML = '';
});

/** The position just inside the cell whose text is `text`. */
function positionIn(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text === text) {
      found = pos;
    }
    return found < 0;
  });
  expect(found, text).toBeGreaterThan(-1);
  return found;
}

function placeCaret(editor: Editor, text: string): void {
  const position = positionIn(editor, text);
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position + 1)),
  );
}

/** The class each decorated cell carries, keyed by the cell's text. */
function decoratedCells(editor: Editor): Record<string, string> {
  const set = activeTableDecorations(editor.state);
  const result: Record<string, string> = {};
  for (const decoration of set.find()) {
    const node = editor.state.doc.nodeAt(decoration.from);
    if (node === null || node.type.name === 'table') {
      continue;
    }
    const spec: unknown = Reflect.get(decoration, 'type');
    const attrs = Reflect.get(spec as object, 'attrs') as Record<string, string> | undefined;
    result[node.textContent] = attrs?.class ?? '';
  }
  return result;
}

describe('the table context', () => {
  it('is nothing outside a table', () => {
    const editor = makeEditor([{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }]);
    placeCaret(editor, 'hello');

    expect(tableContext(editor.state)).toBeNull();
    expect(activeTableDecorations(editor.state).find()).toEqual([]);
  });

  it('names the row and column of the caret, one-based', () => {
    const editor = makeEditor([table()]);
    placeCaret(editor, 'b2');

    const context = tableContext(editor.state);
    if (context === null) {
      throw new Error('the caret is not in a table');
    }
    expect(cellCoordinates(context)).toEqual({
      row: 2,
      column: 2,
    });
  });
});

describe('the decorations', () => {
  it('mark the table, the row, the column and the cell of the caret', () => {
    const editor = makeEditor([table()]);
    placeCaret(editor, 'b2');

    const cells = decoratedCells(editor);
    expect(cells.b2).toBe(`${ACTIVE_ROW_CLASS} ${ACTIVE_COLUMN_CLASS} ${ACTIVE_CELL_CLASS}`);
    expect(cells.a2).toBe(ACTIVE_ROW_CLASS);
    expect(cells.c2).toBe(ACTIVE_ROW_CLASS);
    expect(cells.b1).toBe(ACTIVE_COLUMN_CLASS);
    expect(cells.b3).toBe(ACTIVE_COLUMN_CLASS);
    // The corners are in neither the row nor the column.
    expect(cells.a1).toBeUndefined();
    expect(cells.c3).toBeUndefined();

    const tableDecoration = activeTableDecorations(editor.state)
      .find()
      .find((decoration) => editor.state.doc.nodeAt(decoration.from)?.type.name === 'table');
    expect(tableDecoration).toBeDefined();
  });

  it('are what the view draws', () => {
    const editor = makeEditor([table()]);
    placeCaret(editor, 'c3');

    const active = editor.view.dom.querySelectorAll(`.${ACTIVE_CELL_CLASS}`);
    expect(active).toHaveLength(1);
    expect(active[0]?.textContent).toBe('c3');
    expect(editor.view.dom.querySelector(`.${ACTIVE_TABLE_CLASS}`)).not.toBeNull();
    expect(editor.view.dom.querySelectorAll(`.${ACTIVE_ROW_CLASS}`)).toHaveLength(3);
    expect(editor.view.dom.querySelectorAll(`.${ACTIVE_COLUMN_CLASS}`)).toHaveLength(3);
  });

  it('leave the cells alone under a cell selection, which draws itself', () => {
    const editor = makeEditor([table()]);
    const anchor = editor.state.doc.resolve(positionIn(editor, 'a2'));
    const head = editor.state.doc.resolve(positionIn(editor, 'b3'));
    editor.view.dispatch(
      editor.state.tr.setSelection(
        CellSelection.create(editor.state.doc, anchor.before(-1), head.before(-1)),
      ),
    );

    expect(decoratedCells(editor)).toEqual({});
    expect(editor.view.dom.querySelector(`.${ACTIVE_TABLE_CLASS}`)).not.toBeNull();
  });
});

describe('the header questions', () => {
  it('read the first row and the first column', () => {
    const editor = makeEditor([table()]);
    const node = firstTable(editor);

    expect(hasHeaderRow(node)).toBe(true);
    expect(hasHeaderColumn(node)).toBe(false);

    placeCaret(editor, 'a2');
    editor.commands.toggleHeaderColumn();
    const toggled = firstTable(editor);
    expect(hasHeaderColumn(toggled)).toBe(true);
  });
});
