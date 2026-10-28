import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';

import { tableContext } from './table-controls';

/**
 * Column width, from a menu rather than a drag.
 *
 * **Why this exists.** The only way to change a column's width was dragging its resize handle,
 * which needs a pointer precise enough to land on a few pixels of hairline - not the input a
 * touchscreen gives, and not a keyboard at all. The three actions here - narrower, wider, reset
 * - are the same underlying change the handle makes, `colwidth` on every cell of a column, run
 * from a button instead of a drag.
 *
 * **Why a step and not a typed number.** The handle itself has no numeric readout either; a
 * column gets *narrower* or *wider* by an amount nobody has to calculate, and repeated presses
 * are how someone reaches whatever width they meant. `COLUMN_WIDTH_STEP` is that amount, chosen
 * to be a visible change on one press without needing many for an ordinary adjustment.
 *
 * **Why `changeColumnWidthTr` is separate from the command.** It is the same shape as
 * `moveTopLevelBlockTr` in `move-block.ts`: a pure function over a transaction and the schema's
 * own tree, so it can be tested against `@nix/editor-schema` directly, with no editor, no DOM
 * and no table menu around it.
 */

/** A press of one of the three menu actions. */
export type ColumnWidthAction = 'narrower' | 'wider' | 'reset';

/** How far one press of "Narrower" or "Wider" moves a column, in pixels. */
export const COLUMN_WIDTH_STEP = 40;

/**
 * The floor a column cannot be pressed narrower than.
 *
 * Below this a column stops being a column of anything - a handful of characters before every
 * word wraps - so "Narrower" refuses rather than producing a width the table view would have to
 * fight `prose.ts`'s own per-cell minimum to honour.
 */
export const MIN_COLUMN_WIDTH = 96;

/**
 * The width a column starts adjusting from when it has never been resized.
 *
 * A column with no stored `colwidth` renders at whatever `prose.ts`'s minimum and the browser's
 * own layout give it - never this number - so it is only ever the base a first "Narrower" or
 * "Wider" press counts from, not a width anybody sees before pressing one.
 */
export const DEFAULT_COLUMN_WIDTH = 160;

/** One cell that carries (or should carry) the resized column's width. */
interface ColumnCell {
  /** The cell's position, relative to the table's own start - same coordinates as `TableMap`. */
  readonly pos: number;
  readonly node: PMNode;
  /** Which entry of the cell's `colwidth` array belongs to the resized column. */
  readonly index: number;
}

/** Every cell that occupies column `col`, one per row - a spanning cell counted once. */
function cellsInColumn(table: PMNode, map: TableMap, col: number): ColumnCell[] {
  const cells: ColumnCell[] = [];
  for (let row = 0; row < map.height; row += 1) {
    const mapIndex = row * map.width + col;
    const pos = map.map[mapIndex];
    if (pos === undefined) {
      continue;
    }
    // A rowspanning cell occupies the same map slot in every row it spans; only its first row
    // is where `pos` first appears at this column, so later rows are skipped rather than
    // recorded again.
    if (row > 0 && map.map[mapIndex - map.width] === pos) {
      continue;
    }
    const node = table.nodeAt(pos);
    if (node === null) {
      continue;
    }
    const colspan = typeof node.attrs.colspan === 'number' ? node.attrs.colspan : 1;
    const index = colspan === 1 ? 0 : col - map.colCount(pos);
    cells.push({ pos, node, index });
  }
  return cells;
}

/**
 * Changes the current column's width by one step, or clears it back to no stored width.
 *
 * `cellPos` is a cell position relative to the table's own start, in `table-controls.ts`'s
 * `TableContext.cell` coordinates - the column resized is whichever one that cell's left edge
 * sits in. `apply` mirrors `moveTopLevelBlockTr`: `false` only asks whether a column is there to
 * resize, which is what a menu action's `enabled` reads before deciding whether to write anything.
 *
 * Returns `false` when `cellPos` names no cell in `table` - the caret is not in a table cell, or
 * the position is stale - and writes nothing in that case either.
 */
export function changeColumnWidthTr(
  tr: Transaction,
  table: PMNode,
  tableStart: number,
  cellPos: number,
  action: ColumnWidthAction,
  apply: boolean,
): boolean {
  const map = TableMap.get(table);
  let col: number;
  try {
    col = map.findCell(cellPos).left;
  } catch {
    return false;
  }

  const cells = cellsInColumn(table, map, col);
  if (cells.length === 0) {
    return false;
  }

  if (!apply) {
    return true;
  }

  const first = cells[0];
  if (first === undefined) {
    return false;
  }
  const storedWidth = first.node.attrs.colwidth as (number | null)[] | null;
  const currentWidth = storedWidth?.[first.index];
  const baseWidth =
    typeof currentWidth === 'number' && currentWidth > 0 ? currentWidth : DEFAULT_COLUMN_WIDTH;
  const nextWidth =
    action === 'reset'
      ? 0
      : Math.max(MIN_COLUMN_WIDTH, baseWidth + (action === 'wider' ? 1 : -1) * COLUMN_WIDTH_STEP);

  for (const { pos, node, index } of cells) {
    const colspan = typeof node.attrs.colspan === 'number' ? node.attrs.colspan : 1;
    const existing =
      (node.attrs.colwidth as (number | null)[] | null) ?? new Array(colspan).fill(0);
    const colwidth = existing.slice();
    colwidth[index] = nextWidth;
    // A column that has never been resized, or one just reset, is `null` rather than an array of
    // zeroes - matching prosemirror-tables' own reading of the attribute, which treats a falsy
    // entry as unset either way but only ever writes `null` for "no width anywhere".
    const stored = colwidth.every((width) => !width) ? null : colwidth;
    tr.setNodeMarkup(tableStart + pos, undefined, { ...node.attrs, colwidth: stored });
  }

  return true;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columnWidth: {
      /** Narrows the current column by `COLUMN_WIDTH_STEP`, no further than `MIN_COLUMN_WIDTH`. */
      columnNarrower: () => ReturnType;
      /** Widens the current column by `COLUMN_WIDTH_STEP`. */
      columnWider: () => ReturnType;
      /** Clears the current column's stored width, back to the table's own default sizing. */
      resetColumnWidth: () => ReturnType;
    };
  }
}

/** The three commands above, run against wherever the selection currently is. */
function runColumnWidthAction(action: ColumnWidthAction) {
  return ({
    state,
    tr,
    dispatch,
  }: {
    readonly state: EditorState;
    readonly tr: Transaction;
    readonly dispatch: unknown;
  }) => {
    const context = tableContext(state);
    if (context?.cell === null || context === null) {
      return false;
    }
    return changeColumnWidthTr(
      tr,
      context.table,
      context.start,
      context.cell,
      action,
      dispatch !== undefined,
    );
  };
}

/** Registers `columnNarrower`, `columnWider` and `resetColumnWidth` on the editor. */
export const ColumnWidthControls = Extension.create({
  name: 'columnWidthControls',

  addCommands() {
    return {
      columnNarrower: () => runColumnWidthAction('narrower'),
      columnWider: () => runColumnWidthAction('wider'),
      resetColumnWidth: () => runColumnWidthAction('reset'),
    };
  },
});
