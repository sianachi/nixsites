import { describe, expect, it } from 'vitest';

import { columnOffsets, columnWindow, rowWindow } from '../../../collections/sheet/windowing';

describe('row windows', () => {
  it('starts at the top with overscan below the viewport', () => {
    const window = rowWindow({ scrollTop: 0, viewportHeight: 320, rowHeight: 32, totalRows: 1000 });
    expect(window.first).toBe(0);
    expect(window.last).toBe(20);
  });

  it('slides with scroll and keeps overscan on both sides', () => {
    const window = rowWindow({
      scrollTop: 3200,
      viewportHeight: 320,
      rowHeight: 32,
      totalRows: 1000,
    });
    expect(window.first).toBe(95);
    expect(window.last).toBe(115);
  });

  it('clamps to the last row near the bottom', () => {
    const window = rowWindow({
      scrollTop: 31_600,
      viewportHeight: 320,
      rowHeight: 32,
      totalRows: 1000,
    });
    expect(window.last).toBe(999);
  });

  it('answers an empty grid without producing a range', () => {
    const window = rowWindow({ scrollTop: 0, viewportHeight: 320, rowHeight: 32, totalRows: 0 });
    expect(window.last).toBeLessThan(window.first);
  });
});

describe('column windows', () => {
  it('accumulates offsets with a closing total', () => {
    expect(columnOffsets([100, 50, 200])).toEqual([0, 100, 150, 350]);
  });

  it('finds the visible span across uneven widths', () => {
    const offsets = columnOffsets([100, 100, 300, 100, 100, 100]);
    const window = columnWindow({ scrollLeft: 250, viewportWidth: 300, offsets, overscan: 0 });
    expect(window.first).toBe(2);
    expect(window.last).toBe(3);
  });

  it('clamps overscan at both ends', () => {
    const offsets = columnOffsets([100, 100, 100]);
    const window = columnWindow({ scrollLeft: 0, viewportWidth: 1000, offsets, overscan: 3 });
    expect(window.first).toBe(0);
    expect(window.last).toBe(2);
  });
});
