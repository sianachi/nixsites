import type * as Y from 'yjs';

import { type CellRef, cellKey, parseCellKey } from './refs.js';

/**
 * The sheet body's shape inside the shared Y.Doc, defined once for the editor
 * and the collaboration service. Two definitions of the same shape is the
 * failure this module exists to prevent: sheets that save on one side and
 * refuse to open on the other.
 *
 * - 'sheet-cells': Y.Map, canonical A1 key to a plain { raw } object. A cell
 *   edit replaces the whole object, so concurrent edits to one cell resolve
 *   last-write-wins - the granularity a spreadsheet user expects. An empty
 *   cell is an absent key, never a stored empty string.
 * - 'sheet-meta': Y.Map with the used extents ('rows', 'cols'), grown
 *   monotonically so the grid knows how far to scroll, and 'colWidths', a
 *   nested plain object of column letter to width in pixels, bounded by
 *   SHEET_COLUMN_WIDTH.
 *
 * The note body lives in the XmlFragment named 'default'; these keys do not
 * collide with it. A document is only ever one kind, chosen by item.type.
 */

export const SHEET_CELLS_KEY = 'sheet-cells';
export const SHEET_META_KEY = 'sheet-meta';

/**
 * The bounds a stored column width must sit inside, in pixels, shared by the
 * editor's resize handle and the reader that interprets what a colleague's
 * document says. `min` keeps a column wide enough to grab and to hold one
 * character; `max` keeps one column from swallowing the viewport; `default`
 * is what an unset column renders at. The keyboard resize increment is not
 * here on purpose: it is editor policy, owned by the resize handle, not a
 * property of the stored document.
 */
export const SHEET_COLUMN_WIDTH = {
  min: 48,
  max: 800,
  default: 128,
} as const;

/** A width forced into the stored range, as a whole number of pixels. */
export function clampColumnWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return SHEET_COLUMN_WIDTH.default;
  }
  return Math.min(SHEET_COLUMN_WIDTH.max, Math.max(SHEET_COLUMN_WIDTH.min, Math.round(width)));
}

export interface SheetCell {
  readonly raw: string;
}

export interface SheetMeta {
  readonly rows: number;
  readonly cols: number;
  /** A clamped, renderable view of the stored widths - see readMeta. */
  readonly colWidths: Readonly<Record<string, number>>;
}

export const DEFAULT_SHEET_META: SheetMeta = { rows: 100, cols: 26, colWidths: {} };

export function sheetCellsMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(SHEET_CELLS_KEY);
}

export function sheetMetaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(SHEET_META_KEY);
}

/** A raw cell entry if it has the stored shape, null for anything else. */
export function readCellEntry(value: unknown): SheetCell | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = (value as Record<string, unknown>).raw;
  return typeof raw === 'string' ? { raw } : null;
}

/** Every well-formed cell as canonical key to raw text. */
export function readCells(doc: Y.Doc): Map<string, string> {
  const cells = new Map<string, string>();
  sheetCellsMap(doc).forEach((value, key) => {
    const entry = readCellEntry(value);
    if (entry !== null && parseCellKey(key) !== null) {
      cells.set(key, entry.raw);
    }
  });
  return cells;
}

/**
 * The meta map as a *renderable view*, not the stored values: extents fall
 * back to defaults and column widths are clamped into SHEET_COLUMN_WIDTH.
 * The collaboration service validates cells but does not yet police this map
 * (tracked as server-side meta validation debt), so the read side is where a
 * peer's out-of-range width becomes harmless. Anything that must compare
 * against what is genuinely stored - as setColumnWidth's no-op guard does -
 * reads the map directly rather than through this view.
 */
export function readMeta(doc: Y.Doc): SheetMeta {
  const meta = sheetMetaMap(doc);
  const rows = meta.get('rows');
  const cols = meta.get('cols');
  const widths = meta.get('colWidths');
  const colWidths: Record<string, number> = {};
  if (typeof widths === 'object' && widths !== null && !Array.isArray(widths)) {
    for (const [letters, width] of Object.entries(widths as Record<string, unknown>)) {
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
        // Clamped on read, not just on write: whatever a peer's document
        // stores, this side never renders a sliver column or one wider than
        // the range the resize handle can express.
        colWidths[letters] = clampColumnWidth(width);
      }
    }
  }
  return {
    rows:
      typeof rows === 'number' && Number.isInteger(rows) && rows > 0
        ? rows
        : DEFAULT_SHEET_META.rows,
    cols:
      typeof cols === 'number' && Number.isInteger(cols) && cols > 0
        ? cols
        : DEFAULT_SHEET_META.cols,
    colWidths,
  };
}

/**
 * Write one cell inside a transaction: text sets, empty clears, and the used
 * extents grow to keep the edited cell on the grid.
 */
export function writeCell(doc: Y.Doc, ref: CellRef, raw: string, origin?: unknown): void {
  const key = cellKey(ref);
  doc.transact(() => {
    const cells = sheetCellsMap(doc);
    if (raw.length === 0) {
      if (cells.has(key)) {
        cells.delete(key);
      }
    } else {
      cells.set(key, { raw });
    }
    growExtents(doc, ref);
  }, origin);
}

export function growExtents(doc: Y.Doc, ref: CellRef): void {
  const meta = sheetMetaMap(doc);
  const current = readMeta(doc);
  if (ref.row + 1 > current.rows) {
    meta.set('rows', ref.row + 1);
  }
  if (ref.col + 1 > current.cols) {
    meta.set('cols', ref.col + 1);
  }
}

/**
 * Store one column's width, clamped into `SHEET_COLUMN_WIDTH`, inside a
 * transaction under `origin` so local resizes are undoable the way cell
 * edits are. A width the column already *stores* writes nothing - the guard
 * compares against the raw stored entry, not the clamped view readMeta
 * returns, so a hostile out-of-range stored width is healed by the first
 * resize that lands on its clamped value instead of being kept forever.
 * The rewrite goes through the clamped view, so it heals every column it
 * carries, not just the one being set - and, the honest flip side, it
 * discards every entry `readMeta` rejects.
 *
 * Widths are written as one whole map under a single key, so concurrent
 * resizes of *different* columns are last-writer-wins: one of the two widths
 * is silently lost on merge. A nested Y.Map keyed by column letters would
 * merge them per column and is the fix when this is felt; the data shape
 * predates this function and changing it is its own goal.
 */
export function setColumnWidth(doc: Y.Doc, letters: string, width: number, origin?: unknown): void {
  const clamped = clampColumnWidth(width);
  doc.transact(() => {
    const meta = sheetMetaMap(doc);
    const stored = meta.get('colWidths');
    const entry =
      typeof stored === 'object' && stored !== null && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)[letters]
        : undefined;
    if (entry === clamped) {
      return;
    }
    meta.set('colWidths', { ...readMeta(doc).colWidths, [letters]: clamped });
  }, origin);
}
