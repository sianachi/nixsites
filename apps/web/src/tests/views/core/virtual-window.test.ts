import { describe, expect, it } from 'vitest';

import {
  localViewport,
  variableOffsets,
  variableWindow,
  virtualIndexes,
  virtualSegments,
  virtualSpacers,
} from '../../../collections/core/virtual-window';

describe('variable view windowing', () => {
  it('uses measured replacements without losing total geometry', () => {
    const offsets = variableOffsets(
      ['a', 'b', 'c'],
      40,
      new Map([
        ['a', 30],
        ['c', 70],
      ]),
    );

    expect(offsets).toEqual([0, 30, 70, 140]);
    expect(variableWindow({ offsets, viewportTop: 35, viewportHeight: 30, overscan: 0 })).toEqual({
      first: 1,
      last: 1,
    });
  });

  it('keeps measurements attached to item identity after a reorder', () => {
    const measured = new Map([
      ['a', 30],
      ['c', 70],
    ]);

    expect(variableOffsets(['c', 'b', 'a'], 40, measured)).toEqual([0, 70, 110, 140]);
  });

  it('translates a below companion through its slot offset', () => {
    expect(
      localViewport({
        rootTop: 900,
        contentOrigin: 0,
        viewportTop: 1_000,
        viewportBottom: 1_600,
        totalSize: 4_000,
      }),
    ).toEqual({ top: 100, height: 600 });
  });

  it('clips a beside slot at the end of its own content', () => {
    expect(
      localViewport({
        rootTop: 200,
        contentOrigin: 24,
        viewportTop: 100,
        viewportBottom: 1_000,
        totalSize: 500,
      }),
    ).toEqual({ top: 0, height: 500 });
  });

  it('keeps a distant focused row as a separate bounded segment', () => {
    const indexes = virtualIndexes({ first: 80, last: 89 }, 3_200, 2);

    expect(indexes).toHaveLength(11);
    expect(indexes).toEqual([2, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89]);
    expect(virtualSegments(indexes)).toEqual([
      { first: 2, last: 2 },
      { first: 80, last: 89 },
    ]);
  });

  it('keeps an active dragged Board card mounted beyond the overscan window', () => {
    const indexes = virtualIndexes({ first: 80, last: 89 }, 3_200, null, [2]);

    expect(indexes).toHaveLength(11);
    expect(indexes).toEqual([2, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89]);
    expect(virtualSegments(indexes)).toEqual([
      { first: 2, last: 2 },
      { first: 80, last: 89 },
    ]);
  });

  it('creates spacers around sparse table rows', () => {
    const offsets = variableOffsets(['a', 'b', 'c', 'd'], 40, new Map());
    expect(virtualSpacers(offsets, [0, 3])).toEqual([0, 80, 0]);
  });
});
