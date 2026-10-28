/**
 * The value domain a cell can hold after evaluation, and the coercions the
 * operators and functions agree on. Errors are values: they flow through
 * references and arithmetic instead of throwing, exactly as a spreadsheet
 * user expects.
 */

export const SHEET_ERROR_CODES = [
  '#DIV/0!',
  '#REF!',
  '#CYCLE!',
  '#VALUE!',
  '#NAME?',
  '#LIMIT!',
  '#PARSE!',
] as const;

export type SheetErrorCode = (typeof SHEET_ERROR_CODES)[number];

export interface SheetErrorValue {
  readonly error: SheetErrorCode;
}

/** null is an empty cell. */
export type CellValue = number | string | boolean | null | SheetErrorValue;

export function sheetError(code: SheetErrorCode): SheetErrorValue {
  return { error: code };
}

/**
 * What each error code means, in the words that go next to it. A cell can
 * only show its own code - there is no room for a sentence in a 128px
 * column - but the code alone tells nobody what to do about it, so anywhere
 * the product shows one error at a time (a status line, a tooltip) shows
 * this text beside it.
 */
export const SHEET_ERROR_HELP: Readonly<Record<SheetErrorCode, string>> = {
  '#DIV/0!': 'This formula divides by zero.',
  '#REF!': 'This formula refers to a cell outside the sheet.',
  '#CYCLE!': 'This formula refers to itself, directly or through another cell.',
  '#VALUE!': 'This formula uses a value of the wrong kind, such as text where a number is needed.',
  '#NAME?': "This formula calls a function this build doesn't know.",
  '#LIMIT!': 'This sheet is too large to finish recalculating within its budget.',
  '#PARSE!': "This formula isn't written in a way the parser understands.",
};

export function isSheetError(value: CellValue): value is SheetErrorValue {
  return typeof value === 'object' && value !== null;
}

/**
 * Numeric coercion for operators and scalar function arguments. Empty counts
 * as zero and numeric text counts as its number, both spreadsheet convention;
 * text that is not a number is #VALUE!.
 */
export function toNumber(value: CellValue): number | SheetErrorValue {
  if (isSheetError(value)) {
    return value;
  }
  if (value === null) {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return sheetError('#VALUE!');
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : sheetError('#VALUE!');
}

export function toText(value: CellValue): string | SheetErrorValue {
  if (isSheetError(value)) {
    return value;
  }
  if (value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  return formatNumber(value);
}

export function toBoolean(value: CellValue): boolean | SheetErrorValue {
  if (isSheetError(value)) {
    return value;
  }
  if (value === null) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const upper = value.trim().toUpperCase();
  if (upper === 'TRUE') {
    return true;
  }
  if (upper === 'FALSE') {
    return false;
  }
  return sheetError('#VALUE!');
}

/**
 * Comparison for =, <>, <, <=, >, >=. Numbers compare numerically, text
 * case-insensitively, booleans as TRUE > FALSE; across types the spreadsheet
 * order is number < text < boolean. Empty compares as zero against numbers
 * and as the empty string against text.
 */
export function compareValues(a: CellValue, b: CellValue): number | SheetErrorValue {
  if (isSheetError(a)) {
    return a;
  }
  if (isSheetError(b)) {
    return b;
  }
  const rank = (v: number | string | boolean | null): number => {
    if (typeof v === 'boolean') {
      return 2;
    }
    if (typeof v === 'string') {
      return 1;
    }
    return 0;
  };
  const left = a;
  const right = b;
  const leftRank = rank(left);
  const rightRank = rank(right);
  if (left === null && typeof right === 'string') {
    return ''.localeCompare(right.toLowerCase());
  }
  if (right === null && typeof left === 'string') {
    return left.toLowerCase().localeCompare('');
  }
  if (leftRank !== rightRank && left !== null && right !== null) {
    return leftRank - rightRank;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    const l = left.toLowerCase();
    const r = right.toLowerCase();
    return l < r ? -1 : l > r ? 1 : 0;
  }
  const ln = left === null ? 0 : typeof left === 'boolean' ? (left ? 1 : 0) : Number(left);
  const rn = right === null ? 0 : typeof right === 'boolean' ? (right ? 1 : 0) : Number(right);
  return ln < rn ? -1 : ln > rn ? 1 : 0;
}

/**
 * A number as the grid displays it. Fifteen significant digits, the way
 * spreadsheets hide binary floating point noise: 0.1 + 0.2 renders as 0.3.
 */
function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return String(value);
  }
  const compact = Number(value.toPrecision(15));
  return String(compact);
}

/** A cell value as display text. Empty cells render as the empty string. */
export function formatCellValue(value: CellValue): string {
  if (value === null) {
    return '';
  }
  if (isSheetError(value)) {
    return value.error;
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') {
    return formatNumber(value);
  }
  return value;
}

/**
 * A literal cell's raw text as a value. Numbers and TRUE/FALSE parse to their
 * types; a leading apostrophe forces the rest to be text; everything else is
 * the text itself.
 */
export function literalValue(raw: string): CellValue {
  if (raw.startsWith("'")) {
    return raw.slice(1);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return raw.length === 0 ? null : raw;
  }
  const upper = trimmed.toUpperCase();
  if (upper === 'TRUE') {
    return true;
  }
  if (upper === 'FALSE') {
    return false;
  }
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return raw;
}
