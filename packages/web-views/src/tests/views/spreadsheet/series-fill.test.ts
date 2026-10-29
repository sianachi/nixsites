import { describe, expect, it } from 'vitest';

import { resolveColumns, seriesFillOffer, seriesFillPlan } from '../../../spreadsheet/grid-model';
import type { EffectiveSchema } from '@nix/web-collections/core/container-model';
import { aView } from '@nix/web-collections/testing/view-fixture';
import { anItem } from '../../../testing/suggest-fixtures';

const SCHEMA: EffectiveSchema = {
  properties: [
    { key: 'week', label: 'Week', type: 'text', options: [], required: false },
    { key: 'points', label: 'Points', type: 'number', options: [], required: false },
    { key: 'due', label: 'Due', type: 'date', options: [], required: false },
  ],
  declared: [],
  inherit: true,
};

const COLUMNS = resolveColumns(aView({ columns: ['week', 'points', 'due'] }), SCHEMA);

function range(startRow: number, startCol: number, endRow: number, endCol: number) {
  return { startRow, startCol, endRow, endCol };
}

describe('the series fill plan', () => {
  const items = [
    anItem('One', { week: 'Week 1', points: 10, due: '2026-03-02' }),
    anItem('Two', { week: 'Week 2', points: 20, due: '2026-03-09' }),
    anItem('Three'),
    anItem('Four'),
  ];

  it('continues each selected column below its seed, coerced to the column type', () => {
    const fill = seriesFillPlan(range(0, 1, 3, 3), items, COLUMNS);
    expect(fill?.patterned).toBe(true);
    expect(fill?.rows).toBe(2);
    expect(fill?.plan.writes.map((write) => write.bag)).toEqual([
      { week: 'Week 3', points: 30, due: '2026-03-16' },
      { week: 'Week 4', points: 40, due: '2026-03-23' },
    ]);
    expect(fill?.columns.map((column) => column.describe)).toEqual(['+1', '+10', 'weekly']);
  });

  it('repeats a single seed and says it found no pattern', () => {
    const fill = seriesFillPlan(range(1, 1, 3, 1), items, COLUMNS);
    expect(fill?.patterned).toBe(false);
    expect(fill?.plan.writes.map((write) => write.bag)).toEqual([
      { week: 'Week 2' },
      { week: 'Week 2' },
    ]);
  });

  it('skips the read-only title column and an empty seed', () => {
    expect(seriesFillPlan(range(2, 0, 3, 1), items, COLUMNS)).toBeNull();
  });
});

describe('the series fill offer', () => {
  const items = [
    anItem('One', { week: 'Week 1', points: 10 }),
    anItem('Two', { week: 'Week 2', points: 20 }),
    anItem('Three'),
    anItem('Four'),
    anItem('Five'),
    anItem('Six'),
  ];

  it('describes the pattern with a short preview and the target row count', () => {
    const offer = seriesFillOffer(range(0, 1, 5, 2), items, COLUMNS);
    expect(offer?.rows).toBe(4);
    expect(offer?.patterned).toBe(true);
    expect(offer?.columns.map((column) => column.describe)).toEqual(['+1', '+10']);
    expect(offer?.columns[0]?.preview).toEqual(['Week 3', 'Week 4', 'Week 5']);
    expect(offer?.columns[0]?.seed).toEqual(['Week 1', 'Week 2']);
  });

  it('is not offered when any target cell already holds a value', () => {
    const filled = [...items.slice(0, 4), anItem('Five', { points: 99 }), anItem('Six')];
    expect(seriesFillOffer(range(0, 1, 5, 2), filled, COLUMNS)).toBeNull();
  });

  it('is not offered when the selection has nothing to fill', () => {
    expect(seriesFillOffer(range(2, 0, 3, 1), items, COLUMNS)).toBeNull();
  });
});
