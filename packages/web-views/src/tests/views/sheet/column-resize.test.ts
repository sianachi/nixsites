import { SHEET_COLUMN_WIDTH } from '@nix/sheet';
import { describe, expect, it } from 'vitest';

import { beginColumnResize, moveColumnResize } from '../../../sheet/column-resize';

const begin = (): ReturnType<typeof beginColumnResize> =>
  beginColumnResize({ col: 0, pointerId: 1, clientX: 200, width: 128 });

describe('column resize drag arithmetic', () => {
  it('starts at the width the column already has', () => {
    expect(begin().width).toBe(128);
  });

  it('moves the width by exactly the pointer travel', () => {
    expect(moveColumnResize(begin(), 240).width).toBe(168);
    expect(moveColumnResize(begin(), 160).width).toBe(88);
  });

  it('clamps travel past the rails to the bounds instead of following it', () => {
    expect(moveColumnResize(begin(), -5000).width).toBe(SHEET_COLUMN_WIDTH.min);
    expect(moveColumnResize(begin(), 5000).width).toBe(SHEET_COLUMN_WIDTH.max);
  });

  it('returns the same drag instance when the clamped width is unchanged', () => {
    const drag = moveColumnResize(begin(), -5000);
    expect(moveColumnResize(drag, -6000)).toBe(drag);
  });

  it('measures travel from where the drag began, not from the last move', () => {
    const drag = moveColumnResize(begin(), 300);
    expect(moveColumnResize(drag, 210).width).toBe(138);
  });
});
