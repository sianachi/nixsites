import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Where you are in a table, drawn: the table the caret is in, and the row and column of its cell.
 *
 * A cell in a plain grid gives nothing away about which row or column it belongs to once the
 * table is wider than a glance, and every row and column operation in the table menu acts on
 * "the current" one. These decorations are what make "the current row" a thing a person can
 * see before they delete it. They are classes on the existing elements, styled in `prose.ts`
 * next to the cells they tint; nothing is added to the document.
 *
 * A cell selection - several cells dragged or shift-clicked - already draws itself, so under one
 * only the table is marked, or the two tints would fight over the same cells.
 */

export const ACTIVE_TABLE_CLASS = 'is-active-table';
export const ACTIVE_ROW_CLASS = 'is-active-row';
export const ACTIVE_COLUMN_CLASS = 'is-active-column';
export const ACTIVE_CELL_CLASS = 'is-active-cell';

/** The table around the selection head: its node, where it starts, and the cell the head is in. */
export interface TableContext {
  readonly table: PMNode;
  /** The position before the table node. */
  readonly pos: number;
  /** The position of the first child of the table. Cell positions in `TableMap` count from here. */
  readonly start: number;
  /** The cell's position relative to `start`, or `null` when the head is not inside a cell. */
  readonly cell: number | null;
}

export function tableContext(state: EditorState): TableContext | null {
  const $from = state.selection.$from;
  let cellDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (cellDepth < 0 && (name === 'tableCell' || name === 'tableHeader')) {
      cellDepth = depth;
    }
    if (name === 'table') {
      const start = $from.start(depth);
      return {
        table: $from.node(depth),
        pos: $from.before(depth),
        start,
        cell: cellDepth < 0 ? null : $from.before(cellDepth) - start,
      };
    }
  }
  return null;
}

/** The row and column the cell sits in, one-based, for telling a person where they are. */
export function cellCoordinates(
  context: TableContext,
): { readonly row: number; readonly column: number } | null {
  if (context.cell === null) {
    return null;
  }
  const rect = TableMap.get(context.table).findCell(context.cell);
  return { row: rect.top + 1, column: rect.left + 1 };
}

/** Whether every cell in the first row is a header cell. */
export function hasHeaderRow(table: PMNode): boolean {
  const first = table.firstChild;
  if (first === null || first.childCount === 0) {
    return false;
  }
  let all = true;
  first.forEach((cell) => {
    all = all && cell.type.name === 'tableHeader';
  });
  return all;
}

/** Whether the first cell of every row is a header cell. */
export function hasHeaderColumn(table: PMNode): boolean {
  if (table.childCount === 0) {
    return false;
  }
  let all = true;
  table.forEach((row) => {
    all = all && row.firstChild?.type.name === 'tableHeader';
  });
  return all;
}

export function activeTableDecorations(state: EditorState): DecorationSet {
  const context = tableContext(state);
  if (context === null) {
    return DecorationSet.empty;
  }

  const decorations = [
    Decoration.node(context.pos, context.pos + context.table.nodeSize, {
      class: ACTIVE_TABLE_CLASS,
    }),
  ];

  if (context.cell === null || state.selection instanceof CellSelection) {
    return DecorationSet.create(state.doc, decorations);
  }

  const map = TableMap.get(context.table);
  const rect = map.findCell(context.cell);
  // A spanning cell appears once per grid square it covers; each is decorated once.
  const seen = new Set<number>();

  for (let row = 0; row < map.height; row += 1) {
    const inRow = row >= rect.top && row < rect.bottom;
    for (let column = 0; column < map.width; column += 1) {
      const inColumn = column >= rect.left && column < rect.right;
      if (!inRow && !inColumn) {
        continue;
      }
      const cellPos = map.map[row * map.width + column];
      if (cellPos === undefined || seen.has(cellPos)) {
        continue;
      }
      seen.add(cellPos);
      const cell = context.table.nodeAt(cellPos);
      if (cell === null) {
        continue;
      }
      const classes = [
        inRow ? ACTIVE_ROW_CLASS : null,
        inColumn ? ACTIVE_COLUMN_CLASS : null,
        cellPos === context.cell ? ACTIVE_CELL_CLASS : null,
      ].filter((name): name is string => name !== null);
      const from = context.start + cellPos;
      decorations.push(Decoration.node(from, from + cell.nodeSize, { class: classes.join(' ') }));
    }
  }

  return DecorationSet.create(state.doc, decorations);
}

const key = new PluginKey<DecorationSet>('nixTableControls');

export const TableControls = Extension.create({
  name: 'tableControls',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => activeTableDecorations(state),
          apply: (transaction, previous, _old, state) =>
            transaction.docChanged || transaction.selectionSet
              ? activeTableDecorations(state)
              : previous,
        },
        props: {
          decorations: (state) => key.getState(state) ?? DecorationSet.empty,
        },
      }),
    ];
  },
});
