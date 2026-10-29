import { type CellRange, cellKey } from '@nix/sheet';

/**
 * Copy and paste as tab-separated raw text.
 *
 * Raw text in both directions on purpose: a formula copied out is a formula
 * pasted back in, so a round trip through the clipboard loses nothing. The
 * cost is that other applications receive `=SUM(A1:A3)` rather than its
 * value, which is also what the incumbents put on the plain-text clipboard.
 *
 * A value holding a tab, a line break or a double quote is written in double
 * quotes with its quotes doubled, and read back the same way - the convention
 * Excel and Google Sheets use - so a multi-line value stays one cell instead
 * of spilling into the rows below it.
 */

function quoted(value: string): string {
  return /[\t\n\r"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function rangeToTsv(cells: ReadonlyMap<string, string>, range: CellRange): string {
  const lines: string[] = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    const fields: string[] = [];
    for (let col = range.startCol; col <= range.endCol; col += 1) {
      fields.push(quoted(cells.get(cellKey({ row, col })) ?? ''));
    }
    lines.push(fields.join('\t'));
  }
  return lines.join('\n');
}

/**
 * Rows of raw cell texts. A single value is one row of one field. A field that opens with a double
 * quote and closes with one before a tab, a line break or the end is a quoted field; anything else,
 * such as `"Hi" there` from a plain source, is taken as written.
 */
export function parseTsv(text: string): string[][] {
  // A trailing newline is a terminator, not an empty row - every spreadsheet
  // and terminal appends one, and pasting it as a row would clear cells the
  // copier never selected.
  const source = text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n')
      ? text.slice(0, -1)
      : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let at = 0;
  for (;;) {
    let field: string | null = null;
    if (source.charAt(at) === '"') {
      let value = '';
      let index = at + 1;
      for (;;) {
        const close = source.indexOf('"', index);
        if (close === -1) break;
        value += source.slice(index, close);
        if (source.charAt(close + 1) === '"') {
          value += '"';
          index = close + 2;
          continue;
        }
        const after = source.charAt(close + 1);
        if (after === '' || after === '\t' || after === '\n' || after === '\r') {
          field = value;
          at = close + 1;
        }
        break;
      }
    }
    if (field === null) {
      const end = source.slice(at).search(/[\t\r\n]/);
      const stop = end === -1 ? source.length : at + end;
      field = source.slice(at, stop);
      at = stop;
    }
    row.push(field);
    const separator = source.charAt(at);
    if (separator === '\t') {
      at += 1;
      continue;
    }
    rows.push(row);
    if (separator === '') return rows;
    row = [];
    at += source.startsWith('\r\n', at) ? 2 : 1;
  }
}
