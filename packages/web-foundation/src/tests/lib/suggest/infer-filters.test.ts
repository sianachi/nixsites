import { describe, expect, it } from 'vitest';

import { inferFilters, type ExampleRecord } from '../../../lib/suggest/infer-filters';

function record(id: string, properties: Record<string, unknown>): ExampleRecord {
  return { id, properties };
}

const POOL: readonly ExampleRecord[] = [
  record('a', { title: 'Rent', category: 'Bills', done: false, due: '2026-03-01' }),
  record('b', { title: 'Water', category: 'Bills', done: false, due: '2026-03-10' }),
  record('c', { title: 'Phone', category: 'Bills', done: true, due: '2026-02-01' }),
  record('d', { title: 'Groceries', category: 'Errands', done: false, due: '2026-03-05' }),
  record('e', { title: 'Dentist', category: 'Health', done: false }),
  record('f', { title: 'Library', category: 'Errands', done: true, tags: ['town'] }),
];

describe('inferring filters from examples', () => {
  it('finds the equality every example shares and the fewest others do', () => {
    const examples = POOL.filter((entry) => entry.id === 'a' || entry.id === 'b');
    const inferred = inferFilters(examples, POOL);

    expect(inferred.rules[0]).toEqual({
      property: 'category',
      operator: 'equals',
      value: 'Bills',
      remaining: 3,
    });
    // Then something separating the two unticked-but-open bills from the paid one.
    expect(inferred.rules.length).toBeGreaterThanOrEqual(2);
    expect(inferred.matching).toBe(2);
    expect(inferred.considered).toBe(6);
  });

  it('only proposes rules true of every example', () => {
    const examples = POOL.filter((entry) => ['a', 'b', 'd'].includes(entry.id));
    const inferred = inferFilters(examples, POOL);
    for (const rule of inferred.rules) {
      expect(rule.property).not.toBe('category');
    }
    expect(inferred.matching).toBeGreaterThanOrEqual(3);
  });

  it('proposes a day range from date-shaped values, in the compiler operators', () => {
    const examples = POOL.filter((entry) => ['a', 'b', 'd'].includes(entry.id));
    const { rules } = inferFilters(examples, POOL);
    const operators = rules.map((rule) => `${rule.property} ${rule.operator} ${rule.value}`);
    // Every example falls between 2026-03-01 and 2026-03-10; "before" takes the day after.
    expect(
      operators.some(
        (text) => text === 'due on-or-after 2026-03-01' || text === 'due before 2026-03-11',
      ),
    ).toBe(true);
  });

  it('proposes not-equals for a value only the non-examples hold, matching absence too', () => {
    const examples = [
      record('x', { title: 'Open' }),
      record('y', { title: 'Also open', done: false }),
    ];
    const pool = [...examples, record('z', { title: 'Closed', done: true })];
    const { rules } = inferFilters(examples, pool);
    expect(rules).toContainEqual({
      property: 'done',
      operator: 'not-equals',
      value: 'true',
      remaining: 2,
    });
  });

  it('never proposes the title, and never an equality over a list', () => {
    const examples = POOL.filter((entry) => entry.id === 'f');
    const { rules } = inferFilters(examples, POOL);
    expect(rules.some((rule) => rule.property === 'title')).toBe(false);
    expect(rules.some((rule) => rule.property === 'tags' && rule.operator === 'equals')).toBe(
      false,
    );
  });

  it('stops at three rules', () => {
    const examples = [record('a', { p: '1', q: '1', r: '1', s: '1' })];
    const pool = [
      ...examples,
      record('b', { p: '2', q: '1', r: '1', s: '1' }),
      record('c', { p: '1', q: '2', r: '1', s: '1' }),
      record('d', { p: '1', q: '1', r: '2', s: '1' }),
      record('e', { p: '1', q: '1', r: '1', s: '2' }),
    ];
    expect(inferFilters(examples, pool).rules).toHaveLength(3);
  });

  it('proposes nothing without examples, and nothing when nothing narrows', () => {
    expect(inferFilters([], POOL).rules).toEqual([]);
    const same = [record('a', { k: 'v' }), record('b', { k: 'v' })];
    expect(inferFilters(same, same).rules).toEqual([]);
  });

  it('reads numbers and booleans the way the server text-compares them', () => {
    const examples = [record('a', { priority: 1, done: true })];
    const pool = [...examples, record('b', { priority: 2, done: true })];
    expect(inferFilters(examples, pool).rules[0]).toMatchObject({
      property: 'priority',
      operator: 'equals',
      value: '1',
    });
  });
});
