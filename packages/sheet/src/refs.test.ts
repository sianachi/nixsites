import { describe, expect, it } from 'vitest';

import {
  cellKey,
  columnLetters,
  lettersToColumn,
  normalizeRange,
  parseA1,
  parseCellKey,
  rangeContains,
} from './refs.js';

describe('column letters', () => {
  it('maps the first column to A and the twenty-sixth to Z', () => {
    expect(columnLetters(0)).toBe('A');
    expect(columnLetters(25)).toBe('Z');
  });

  it('rolls over to two letters after Z', () => {
    expect(columnLetters(26)).toBe('AA');
    expect(columnLetters(27)).toBe('AB');
    expect(columnLetters(51)).toBe('AZ');
    expect(columnLetters(52)).toBe('BA');
    expect(columnLetters(701)).toBe('ZZ');
  });

  it('round-trips every column in the address space', () => {
    for (let col = 0; col < 702; col += 1) {
      expect(lettersToColumn(columnLetters(col))).toBe(col);
    }
  });
});

describe('cell keys', () => {
  it('round-trips across the corners of the address space', () => {
    for (const ref of [
      { row: 0, col: 0 },
      { row: 9_999, col: 0 },
      { row: 0, col: 701 },
      { row: 9_999, col: 701 },
      { row: 41, col: 27 },
    ]) {
      expect(parseCellKey(cellKey(ref))).toEqual(ref);
    }
  });

  it('refuses lowercase, anchors, zero rows, and trailing text', () => {
    expect(parseCellKey('b7')).toBeNull();
    expect(parseCellKey('$B$7')).toBeNull();
    expect(parseCellKey('B0')).toBeNull();
    expect(parseCellKey('B7x')).toBeNull();
    expect(parseCellKey('B')).toBeNull();
    expect(parseCellKey('7')).toBeNull();
    expect(parseCellKey('')).toBeNull();
  });
});

describe('formula references', () => {
  it('parses case-insensitively and preserves anchors', () => {
    expect(parseA1('b7')).toEqual({ row: 6, col: 1, absRow: false, absCol: false });
    expect(parseA1('$B7')).toEqual({ row: 6, col: 1, absRow: false, absCol: true });
    expect(parseA1('B$7')).toEqual({ row: 6, col: 1, absRow: true, absCol: false });
    expect(parseA1('$B$7')).toEqual({ row: 6, col: 1, absRow: true, absCol: true });
  });

  it('refuses text that is not a reference', () => {
    expect(parseA1('SUM')).toBeNull();
    expect(parseA1('B0')).toBeNull();
    expect(parseA1('$$B7')).toBeNull();
    expect(parseA1('ABCD1')).toBeNull();
  });
});

describe('ranges', () => {
  it('normalizes corners given in any order', () => {
    const range = normalizeRange({ row: 5, col: 3 }, { row: 1, col: 7 });
    expect(range).toEqual({ startRow: 1, endRow: 5, startCol: 3, endCol: 7 });
  });

  it('answers containment', () => {
    const range = normalizeRange({ row: 0, col: 0 }, { row: 2, col: 1 });
    expect(rangeContains(range, { row: 1, col: 1 })).toBe(true);
    expect(rangeContains(range, { row: 3, col: 0 })).toBe(false);
  });
});
