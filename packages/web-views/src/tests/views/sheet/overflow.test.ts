import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fitCellText } from '../../../sheet/overflow';

beforeEach(() => {
  // jsdom logs "Not implemented" for canvas getContext; the 9px fallback
  // glyph width is the path under test here, so answer null quietly.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

describe('fitCellText', () => {
  it('leaves a number that fits its column alone', () => {
    expect(fitCellText('123', true, 128)).toBe('123');
  });

  it('replaces a number too wide for its column with hash marks, never a digit prefix', () => {
    const shown = fitCellText('1234567890123', true, 64);
    expect(shown).toMatch(/^#+$/);
    expect(shown).not.toContain('1');
  });

  it('fills the width with hashes rather than always showing a fixed count', () => {
    const narrow = fitCellText('1234567890123', true, 64);
    const wider = fitCellText('12345678901234567890', true, 110);
    expect(wider.length).toBeGreaterThan(narrow.length);
  });

  it('shows at least one hash even in a column narrower than one character', () => {
    expect(fitCellText('12345', true, 16)).toBe('#');
  });

  it('never hashes text, which clips visibly instead of reading as a different value', () => {
    expect(fitCellText('a sentence much wider than the column', false, 48)).toBe(
      'a sentence much wider than the column',
    );
  });

  it('leaves an empty cell empty', () => {
    expect(fitCellText('', true, 48)).toBe('');
  });
});
