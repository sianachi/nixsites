import { describe, expect, it } from 'vitest';

import {
  sortItems,
  sortItemsBy,
  type Item,
  type PropertyDefinition,
} from '../../../core/container-model';

function item(id: string, seq: number, properties: Record<string, unknown>, title = id): Item {
  return {
    id,
    workspaceId: 'workspace-1',
    parentId: 'folder-1',
    type: 'note',
    title,
    hasChildren: false,
    seq,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function property(key: string, type: string, options: string[] = []): PropertyDefinition {
  return {
    key,
    label: key,
    type,
    options,
    required: false,
    expression: null,
    aggregate: null,
    source: null,
  };
}

const ids = (items: readonly Item[]): string[] => items.map((entry) => entry.id);

describe('type-aware sorting', () => {
  it('orders decimals and negatives numerically, which the text collator never did', () => {
    const values = [1.5, 1.25, 10, -10, -5, 3];
    const items = values.map((value, index) => item(String(value), index, { amount: value }));

    const sorted = sortItems(items, 'amount', false, [property('amount', 'number')]);

    expect(ids(sorted)).toEqual(['-10', '-5', '1.25', '1.5', '3', '10']);
  });

  it('reverses numbers when descending and still puts blanks last', () => {
    const items = [
      item('blank', 0, {}),
      item('two', 1, { amount: 2 }),
      item('minus', 2, { amount: -1 }),
    ];

    expect(ids(sortItems(items, 'amount', true, [property('amount', 'estimate')]))).toEqual([
      'two',
      'minus',
      'blank',
    ]);
    expect(ids(sortItems(items, 'amount', false, [property('amount', 'estimate')]))).toEqual([
      'minus',
      'two',
      'blank',
    ]);
  });

  it('orders a select by its option order rather than alphabetically', () => {
    const status = property('status', 'select', ['To do', 'Doing', 'Done']);
    const items = [
      item('done', 0, { status: 'Done' }),
      item('todo', 1, { status: 'To do' }),
      item('doing', 2, { status: 'Doing' }),
      item('stray', 3, { status: 'Archived' }),
    ];

    expect(ids(sortItems(items, 'status', false, [status]))).toEqual([
      'todo',
      'doing',
      'done',
      'stray',
    ]);
  });

  it('orders timestamps by instant, not by their text in different offsets', () => {
    const at = property('at', 'timestamp');
    const items = [
      // 09:00 in New York is 14:00 UTC, which is after 10:00 in London (UTC in winter).
      item('new-york', 0, { at: '2026-01-05T09:00:00-05:00[America/New_York]' }),
      item('london', 1, { at: '2026-01-05T10:00:00+00:00[Europe/London]' }),
    ];

    expect(ids(sortItems(items, 'at', false, [at]))).toEqual(['london', 'new-york']);
  });

  it('puts unchecked before checked', () => {
    const items = [item('yes', 0, { done: true }), item('no', 1, { done: false })];

    expect(ids(sortItems(items, 'done', false, [property('done', 'checkbox')]))).toEqual([
      'no',
      'yes',
    ]);
  });

  it('orders a formula by its runtime value when that value is a number', () => {
    const total = property('total', 'formula');
    const items = [
      item('nine', 0, { total: 9 }),
      item('ten', 1, { total: 10 }),
      item('half', 2, { total: 0.5 }),
    ];

    expect(ids(sortItems(items, 'total', false, [total]))).toEqual(['half', 'nine', 'ten']);
  });

  it('breaks ties on the second key, then on sibling order', () => {
    const properties = [property('status', 'select', ['Open', 'Closed']), property('due', 'date')];
    const items = [
      item('closed-early', 0, { status: 'Closed', due: '2026-01-01' }),
      item('open-late', 1, { status: 'Open', due: '2026-03-01' }),
      item('open-early-b', 3, { status: 'Open', due: '2026-02-01' }),
      item('open-early-a', 2, { status: 'Open', due: '2026-02-01' }),
    ];

    const sorted = sortItemsBy(
      items,
      [
        { property: 'status', descending: false },
        { property: 'due', descending: false },
      ],
      properties,
    );

    expect(ids(sorted)).toEqual(['open-early-a', 'open-early-b', 'open-late', 'closed-early']);
  });

  it('sorts 3,000 rows by a number property within a generous bound', () => {
    const items = Array.from({ length: 3_000 }, (_, index) =>
      item(`row-${String(index)}`, index, { amount: Math.sin(index) * 1_000 }),
    );
    const start = performance.now();

    sortItems(items, 'amount', false, [property('amount', 'number')]);

    // The previous text sort measured 2.65ms here; this bound only catches a per-comparison parse
    // creeping back in, which costs an order of magnitude more.
    expect(performance.now() - start).toBeLessThan(250);
  });
});
