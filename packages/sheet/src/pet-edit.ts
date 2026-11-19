import type * as Y from 'yjs';

import { evaluateSheet } from './engine.js';
import { SHEET_LIMITS } from './limits.js';
import {
  DEFAULT_SHEET_META,
  SHEET_COLUMN_WIDTH,
  readCells,
  readMeta,
  sheetCellsMap,
  sheetMetaMap,
} from './model.js';
import { cellKey, isInBounds, parseCellKey } from './refs.js';

type Extent = 'rows' | 'cols';

export interface SheetEditPlan {
  readonly cells: readonly { readonly cell: string; readonly value: string | null }[];
  readonly rows?: number | undefined;
  readonly columns?: number | undefined;
  readonly columnWidths: readonly { readonly column: string; readonly width: number | null }[];
}

export type SheetEditChange =
  | { kind: 'cell'; cell: string; before: string | null; after: string | null }
  | { kind: 'extent'; axis: Extent; before: number | null; after: number | null }
  | { kind: 'width'; column: string; before: number | null; after: number | null };

export const MAX_SHEET_EDITS = 128;

export class SheetEditError extends Error {}

function checkedCell(cell: string) {
  const ref = parseCellKey(cell);
  if (
    ref === null ||
    cellKey(ref) !== cell ||
    !isInBounds(ref, SHEET_LIMITS.maxRows, SHEET_LIMITS.maxCols)
  ) {
    throw new SheetEditError(`Cell ${cell} is outside the sheet grid.`);
  }
  return ref;
}

function checkedValue(value: string | null) {
  if (value !== null && (value.length === 0 || value.length > SHEET_LIMITS.maxRawLength)) {
    throw new SheetEditError(
      'Enter a cell value within the sheet text limit or use null to clear it.',
    );
  }
}

function checkedExtent(axis: Extent, value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const max = axis === 'rows' ? SHEET_LIMITS.maxRows : SHEET_LIMITS.maxCols;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new SheetEditError('The sheet dimensions are outside the supported grid.');
  }
  return value;
}

function checkedWidth(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < SHEET_COLUMN_WIDTH.min ||
    value > SHEET_COLUMN_WIDTH.max
  ) {
    throw new SheetEditError('The column width is outside the supported range.');
  }
  return value;
}

function readWidths(doc: Y.Doc): Map<string, unknown> {
  const widths = sheetMetaMap(doc).get('colWidths');
  if (widths === undefined) return new Map();
  if (typeof widths !== 'object' || widths === null || Array.isArray(widths)) {
    throw new SheetEditError('The stored column widths could not be read.');
  }
  return new Map<string, unknown>(Object.entries(widths));
}

function assertCount(count: number) {
  if (count > MAX_SHEET_EDITS)
    throw new SheetEditError('Split the sheet edit into smaller batches.');
}

function addTarget(targets: Set<string>, target: string) {
  if (targets.has(target))
    throw new SheetEditError(`The edit contains duplicate target ${target}.`);
  targets.add(target);
}

/** The smallest native cell and metadata changes that realize the requested edits. */
export function previewSheetEdit(doc: Y.Doc, plan: SheetEditPlan): SheetEditChange[] {
  assertCount(plan.cells.length + plan.columnWidths.length + 2);
  const meta = readMeta(doc);
  const storedMeta = sheetMetaMap(doc);
  const requestedRows = checkedExtent('rows', plan.rows) ?? meta.rows;
  const requestedCols = checkedExtent('cols', plan.columns) ?? meta.cols;
  if (requestedRows < meta.rows || requestedCols < meta.cols) {
    throw new SheetEditError(
      'Sheet dimensions can grow. Clear specific cells to remove their values.',
    );
  }
  let rows = requestedRows;
  let cols = requestedCols;
  const cells = readCells(doc);
  const widths = plan.columnWidths.length === 0 ? undefined : readWidths(doc);
  const changes: SheetEditChange[] = [];
  const targets = new Set<string>();
  for (const { cell, value } of plan.cells) {
    addTarget(targets, cell);
    const ref = checkedCell(cell);
    checkedValue(value);
    const before = cells.get(cell) ?? null;
    if (before === value) continue;
    changes.push({ kind: 'cell', cell, before, after: value });
    if (value !== null) {
      rows = Math.max(rows, ref.row + 1);
      cols = Math.max(cols, ref.col + 1);
    }
  }
  for (const { column, width } of plan.columnWidths) {
    addTarget(targets, column);
    const ref = checkedCell(`${column}1`);
    const after = checkedWidth(width);
    const before = checkedWidth(widths?.get(column));
    if (before === after) continue;
    changes.push({ kind: 'width', column, before, after });
    if (after !== null) cols = Math.max(cols, ref.col + 1);
  }
  for (const [axis, after] of [
    ['rows', rows],
    ['cols', cols],
  ] as const) {
    if (after !== meta[axis]) {
      changes.push({
        kind: 'extent',
        axis,
        before: checkedExtent(axis, storedMeta.get(axis)),
        after,
      });
    }
  }
  return changes;
}

function checkChanges(doc: Y.Doc, changes: readonly SheetEditChange[]) {
  assertCount(changes.length);
  const storedMeta = sheetMetaMap(doc);
  const meta = readMeta(doc);
  const cells = readCells(doc);
  const targets = new Set<string>();
  let hasCellChanges = false;
  let rows = meta.rows;
  let cols = meta.cols;
  let widths: Map<string, unknown> | undefined;
  for (const change of changes) {
    switch (change.kind) {
      case 'cell':
        addTarget(targets, change.cell);
        checkedCell(change.cell);
        checkedValue(change.after);
        requireUnchanged(cells.get(change.cell) ?? null, change.before);
        if (change.after === null) cells.delete(change.cell);
        else cells.set(change.cell, change.after);
        hasCellChanges = true;
        break;
      case 'extent': {
        addTarget(targets, change.axis);
        requireUnchanged(checkedExtent(change.axis, storedMeta.get(change.axis)), change.before);
        const after = checkedExtent(change.axis, change.after);
        if (change.axis === 'rows') rows = after ?? DEFAULT_SHEET_META.rows;
        else cols = after ?? DEFAULT_SHEET_META.cols;
        break;
      }
      case 'width': {
        addTarget(targets, change.column);
        checkedCell(`${change.column}1`);
        widths ??= readWidths(doc);
        requireUnchanged(checkedWidth(widths.get(change.column)), change.before);
        const after = checkedWidth(change.after);
        if (after === null) widths.delete(change.column);
        else widths.set(change.column, after);
        break;
      }
    }
  }

  if (rows < meta.rows || cols < meta.cols) {
    // An undo may shrink extents only while everything that still exists remains visible.
    for (const key of cells.keys()) {
      if (!isInBounds(checkedCell(key), rows, cols)) {
        throw new SheetEditError('Undo would hide another cell. Review the current sheet first.');
      }
    }
    for (const column of (widths ?? readWidths(doc)).keys()) {
      if (!isInBounds(checkedCell(`${column}1`), rows, cols)) {
        throw new SheetEditError('Undo would hide another column. Review the current sheet first.');
      }
    }
  }
  for (const change of changes) {
    if (
      (change.kind === 'cell' &&
        change.after !== null &&
        !isInBounds(checkedCell(change.cell), rows, cols)) ||
      (change.kind === 'width' &&
        change.after !== null &&
        !isInBounds(checkedCell(`${change.column}1`), rows, cols))
    ) {
      throw new SheetEditError('The edit would place content outside the sheet dimensions.');
    }
  }
  if (cells.size > SHEET_LIMITS.maxCells)
    throw new SheetEditError('The sheet cell limit would be exceeded.');
  if (hasCellChanges && evaluateSheet({ cells }).budget.exceeded) {
    throw new SheetEditError('The sheet cannot be recalculated within its operation budget.');
  }
  return widths;
}

function requireUnchanged(actual: string | number | null, expected: string | number | null) {
  if (actual !== expected)
    throw new SheetEditError('The sheet changed. Review its current values first.');
}

/** Apply only the reviewed changes, after the complete batch passes its guards. */
export function applySheetEdit(doc: Y.Doc, changes: readonly SheetEditChange[]): void {
  const widths = checkChanges(doc, changes);
  const cells = sheetCellsMap(doc);
  const meta = sheetMetaMap(doc);
  doc.transact(() => {
    for (const change of changes) {
      if (change.kind === 'cell') {
        if (change.after === null) cells.delete(change.cell);
        else cells.set(change.cell, { raw: change.after });
      } else if (change.kind === 'extent') {
        if (change.after === null) meta.delete(change.axis);
        else meta.set(change.axis, change.after);
      }
    }
    if (widths !== undefined) meta.set('colWidths', Object.fromEntries(widths));
  });
}

export function invertSheetEdit(changes: readonly SheetEditChange[]): SheetEditChange[] {
  return changes.map((change) => {
    switch (change.kind) {
      case 'cell':
        return { ...change, before: change.after, after: change.before };
      case 'extent':
        return { ...change, before: change.after, after: change.before };
      case 'width':
        return { ...change, before: change.after, after: change.before };
    }
  });
}
