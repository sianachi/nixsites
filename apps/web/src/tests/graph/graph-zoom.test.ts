import { describe, expect, it } from 'vitest';

import { stepIn, stepOut } from '../../graph/graph-zoom';

/** The zoom ladder, tested as arithmetic: a step that runs off either end is the defect to rule out. */
describe('stepping the zoom', () => {
  it('steps in and back out to the same place', () => {
    expect(stepOut(stepIn(1))).toBe(1);
  });

  it('lands on a named step from between steps', () => {
    expect(stepIn(1.37)).toBe(1.5);
    expect(stepOut(1.37)).toBe(1);
  });

  it('saturates at the ceiling and the floor', () => {
    expect(stepIn(3)).toBe(3);
    expect(stepOut(0.25)).toBe(0.25);
  });
});
