import { describe, expect, it } from 'vitest';
import atlas from '../../pets/owl-atlas.json';
import { petAtlases } from '../../pets/pet-avatar';
import { petAnimationStates } from '../../pets/pet-avatar';

describe('owl atlas geometry', () => {
  it('provides a bounded, non-overlapping source region for every state', () => {
    expect(atlas.states).toEqual(petAnimationStates);
    expect(atlas.columns * atlas.cellWidth).toBe(atlas.imageWidth);
    expect(atlas.rowStarts).toHaveLength(petAnimationStates.length);
    expect(atlas.rowHeights).toHaveLength(petAnimationStates.length);
    expect(atlas.rowBaselines).toHaveLength(petAnimationStates.length);
    for (const [row, top] of atlas.rowStarts.entries()) {
      const height = atlas.rowHeights[row] ?? 0;
      const baseline = atlas.rowBaselines[row] ?? 0;
      expect(top).toBeGreaterThanOrEqual(0);
      expect(height).toBeGreaterThan(0);
      expect(top + height).toBeLessThanOrEqual(atlas.rowStarts[row + 1] ?? atlas.imageHeight);
      expect(baseline).toBeGreaterThan(0);
      expect(baseline).toBeLessThanOrEqual(height);
    }
  });
});

describe.each(Object.entries(petAtlases))('%s atlas geometry', (_appearance, spriteAtlas) => {
  it('uses the v2 grid and maps every runtime state to a populated animation row', () => {
    expect(spriteAtlas.version).toBe(2);
    expect(spriteAtlas.columns * spriteAtlas.cellWidth).toBe(spriteAtlas.imageWidth);
    expect(spriteAtlas.rows * spriteAtlas.cellHeight).toBe(spriteAtlas.imageHeight);
    expect(Object.keys(spriteAtlas.stateRows)).toEqual(petAnimationStates);
    for (const row of Object.values(spriteAtlas.stateRows)) {
      expect(spriteAtlas.frameCounts[row]).toBeGreaterThan(0);
    }
  });
});
