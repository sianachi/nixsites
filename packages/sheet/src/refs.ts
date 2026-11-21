/**
 * A1 notation, in one place. Row and column are 0-based everywhere inside the
 * engine; the 1-based arithmetic lives only in these two codecs. A cell key
 * (the Y.Map key and the engine's node identity) is the canonical uppercase
 * A1 form with no dollar signs: "B7", never "b7" or "$B$7".
 */

export interface CellRef {
  readonly row: number;
  readonly col: number;
}

/** A reference as written in a formula, with its $-anchors preserved. */
export interface A1Ref extends CellRef {
  readonly absRow: boolean;
  readonly absCol: boolean;
}

export interface CellRange {
  readonly startRow: number;
  readonly endRow: number;
  readonly startCol: number;
  readonly endCol: number;
}

const CELL_KEY_PATTERN = /^([A-Z]+)([1-9][0-9]*)$/;
const A1_PATTERN = /^(\$?)([A-Za-z]+)(\$?)([1-9][0-9]*)$/;

/** 0-based column index to letters: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetters(col: number): string {
  let n = col;
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) {
      return out;
    }
  }
}

/** Letters to 0-based column index: A -> 0, Z -> 25, AA -> 26. */
export function lettersToColumn(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i += 1) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1;
}

/** The canonical key for a cell: uppercase A1, no anchors. */
export function cellKey(ref: CellRef): string {
  return columnLetters(ref.col) + String(ref.row + 1);
}

/** Strict parse of a canonical key. Returns null for anything else. */
export function parseCellKey(key: string): CellRef | null {
  const match = CELL_KEY_PATTERN.exec(key);
  if (match === null) {
    return null;
  }
  const letters = match[1];
  const digits = match[2];
  if (letters === undefined || digits === undefined || letters.length > 3) {
    return null;
  }
  return { row: Number(digits) - 1, col: lettersToColumn(letters) };
}

/** Lenient parse of a formula-text reference: case-insensitive, $-anchors. */
export function parseA1(text: string): A1Ref | null {
  const match = A1_PATTERN.exec(text);
  if (match === null) {
    return null;
  }
  const letters = match[2];
  const digits = match[4];
  if (letters === undefined || digits === undefined || letters.length > 3) {
    return null;
  }
  return {
    row: Number(digits) - 1,
    col: lettersToColumn(letters.toUpperCase()),
    absCol: match[1] === '$',
    absRow: match[3] === '$',
  };
}

/** A range between two corners, normalized so start <= end on both axes. */
export function normalizeRange(a: CellRef, b: CellRef): CellRange {
  return {
    startRow: Math.min(a.row, b.row),
    endRow: Math.max(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endCol: Math.max(a.col, b.col),
  };
}

export function rangeContains(range: CellRange, ref: CellRef): boolean {
  return (
    ref.row >= range.startRow &&
    ref.row <= range.endRow &&
    ref.col >= range.startCol &&
    ref.col <= range.endCol
  );
}

export function isInBounds(ref: CellRef, maxRows: number, maxCols: number): boolean {
  return ref.row >= 0 && ref.row < maxRows && ref.col >= 0 && ref.col < maxCols;
}
