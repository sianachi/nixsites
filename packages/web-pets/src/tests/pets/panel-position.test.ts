import { describe, expect, it } from 'vitest';
import { openPanelPosition } from '../../pets/panel-position';
describe('panel placement', () => {
  it.each([
    [0, 0],
    [950, 0],
    [0, 740],
    [950, 740],
    [480, 390],
  ])('keeps the conversation reachable from %i,%i', (left, top) => {
    const pos = openPanelPosition(
      { left, top, width: 48, height: 48 },
      { width: 360, height: 500 },
      { width: 1000, height: 800 },
      12,
      60,
    );
    expect(pos.left).toBeGreaterThanOrEqual(12);
    expect(pos.left + 360).toBeLessThanOrEqual(988);
    expect(pos.top).toBeGreaterThanOrEqual(12);
    expect(pos.top + 500).toBeLessThanOrEqual(728);
  });
  it('keeps the header reachable when a resize makes the viewport smaller than the panel', () => {
    expect(
      openPanelPosition(
        { left: 200, top: 200, width: 48, height: 48 },
        { width: 360, height: 500 },
        { width: 250, height: 300 },
        12,
        0,
      ),
    ).toEqual({ left: 12, top: 12 });
  });
});
