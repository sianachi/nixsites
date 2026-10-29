import { describe, expect, it } from 'vitest';

import { parseTsv, rangeToTsv } from '../../../collections/sheet/clipboard';

describe('copying a range', () => {
  it('serializes raw text row by row, empty cells as empty fields', () => {
    const cells = new Map([
      ['A1', '1'],
      ['B1', '=A1*2'],
      ['A2', 'label'],
    ]);
    const tsv = rangeToTsv(cells, { startRow: 0, endRow: 1, startCol: 0, endCol: 1 });
    expect(tsv).toBe('1\t=A1*2\nlabel\t');
  });
});

describe('pasting text', () => {
  it('splits rows on newlines and fields on tabs', () => {
    expect(parseTsv('1\t2\n3\t4')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('treats a trailing newline as a terminator, not an empty row', () => {
    expect(parseTsv('a\tb\n')).toEqual([['a', 'b']]);
  });

  it('accepts Windows line endings', () => {
    expect(parseTsv('a\r\nb')).toEqual([['a'], ['b']]);
  });

  it('reads a single value as one cell', () => {
    expect(parseTsv('42')).toEqual([['42']]);
  });

  it('round-trips what the copy serialized', () => {
    const cells = new Map([
      ['A1', 'x'],
      ['B2', '=SUM(A1:A2)'],
    ]);
    const tsv = rangeToTsv(cells, { startRow: 0, endRow: 1, startCol: 0, endCol: 1 });
    expect(parseTsv(tsv)).toEqual([
      ['x', ''],
      ['', '=SUM(A1:A2)'],
    ]);
  });
});

describe('values with tabs, line breaks or quotes', () => {
  it('quotes them on copy and reads them back as one cell', () => {
    const cells = new Map([
      ['A1', 'first line\nsecond line'],
      ['B1', 'say "hi"'],
      ['A2', 'tab\there'],
      ['B2', 'plain'],
    ]);
    const tsv = rangeToTsv(cells, { startRow: 0, endRow: 1, startCol: 0, endCol: 1 });

    expect(tsv).toBe('"first line\nsecond line"\t"say ""hi"""\n"tab\there"\tplain');
    expect(parseTsv(tsv)).toEqual([
      ['first line\nsecond line', 'say "hi"'],
      ['tab\there', 'plain'],
    ]);
  });

  it('reads a multi-line cell quoted by another spreadsheet, with Windows line endings', () => {
    expect(parseTsv('"a\r\nb"\tc\r\nd\te\r\n')).toEqual([
      ['a\r\nb', 'c'],
      ['d', 'e'],
    ]);
  });

  it('takes a quote that does not close a field as written', () => {
    expect(parseTsv('"Hi" there\tx')).toEqual([['"Hi" there', 'x']]);
    expect(parseTsv('"unclosed\nnext')).toEqual([['"unclosed'], ['next']]);
  });
});
