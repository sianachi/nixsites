import { describe, expect, it } from 'vitest';

import { isHorizontalIntent, snapsOpen } from '../../layout/use-edge-swipe';

describe('drawer gestures', () => {
  it('snaps by velocity first, then by distance', () => {
    expect(snapsOpen(0.2, 0.6)).toBe(true);
    expect(snapsOpen(0.9, -0.6)).toBe(false);
    expect(snapsOpen(0.6, 0)).toBe(true);
    expect(snapsOpen(0.4, 0.1)).toBe(false);
  });

  it('claims only deliberate, mostly horizontal drags', () => {
    expect(isHorizontalIntent(30, 5)).toBe(true);
    expect(isHorizontalIntent(30, 30)).toBe(false);
    expect(isHorizontalIntent(4, 0)).toBe(false);
  });
});
