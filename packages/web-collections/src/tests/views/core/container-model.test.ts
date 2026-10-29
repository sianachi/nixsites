import { describe, expect, it } from 'vitest';

import {
  applyFilters,
  applyTitleSearch,
  readDateValue,
  readPropertyText,
  readSelectValue,
  sortItems,
  type Item,
} from '../../../core/container-model';

/**
 * The model every view reads through.
 *
 * These functions exist so that three views do not each decide what a number looks like, what an
 * empty value sorts as, or which day a date lands on. Getting any of those wrong in one view and
 * right in another is the kind of inconsistency people report as "the board is lying".
 */

function itemOf(properties: Record<string, unknown>, overrides: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    workspaceId: 'w1',
    parentId: null,
    type: 'note',
    title: 'Untitled',
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-07-27T00:00:00Z',
    updatedAt: '2026-07-27T00:00:00Z',
    ...overrides,
  };
}

describe('searching loaded item titles', () => {
  const items = [
    itemOf({}, { title: 'Water plants' }),
    itemOf({ title: 'Water' }, { title: 'Read' }),
  ];

  it('matches title substrings without case or surrounding spaces', () => {
    expect(applyTitleSearch(items, '  PLANTS ')).toEqual([items[0]]);
    expect(applyTitleSearch(items, 'missing')).toEqual([]);
  });

  it('preserves the loaded array when search is blank', () => {
    expect(applyTitleSearch(items, '   ')).toBe(items);
  });

  it('reads only the title and accepts untitled query results', () => {
    expect(applyTitleSearch([{ title: null }, { title: 'Water plants' }], 'Water')).toEqual([
      { title: 'Water plants' },
    ]);
    expect(applyTitleSearch(items, 'Water')).toEqual([items[0]]);
  });
});

describe('reading a property as text', () => {
  it('reads a string straight through', () => {
    expect(readPropertyText(itemOf({ owner: 'Ada' }), 'owner')).toBe('Ada');
  });

  it('reads a number as its digits', () => {
    expect(readPropertyText(itemOf({ estimate: 3 }), 'estimate')).toBe('3');
  });

  it('reads a checkbox as a word rather than as true or false', () => {
    // A column of "true" and "false" reads as a dump of the storage. Yes and No is what the
    // property means.
    expect(readPropertyText(itemOf({ done: true }), 'done')).toBe('Yes');
    expect(readPropertyText(itemOf({ done: false }), 'done')).toBe('No');
  });

  it('joins a multi-select', () => {
    expect(readPropertyText(itemOf({ tags: ['a', 'b'] }), 'tags')).toBe('a, b');
  });

  it('reads an absent or null property as empty rather than as a word', () => {
    // The alternative puts "null" or "undefined" in front of people, which is a bug report.
    expect(readPropertyText(itemOf({}), 'owner')).toBe('');
    expect(readPropertyText(itemOf({ owner: null }), 'owner')).toBe('');
  });

  it('reads a shape it does not recognise as empty rather than as JSON', () => {
    expect(readPropertyText(itemOf({ legacy: { nested: 1 } }), 'legacy')).toBe('');
  });
});

describe('reading a select value', () => {
  it('reads a non-empty string', () => {
    expect(readSelectValue(itemOf({ status: 'Doing' }), 'status')).toBe('Doing');
  });

  it('treats absent, null and the empty string alike', () => {
    // All three mean "this card has no column", and a board that distinguished them would grow an
    // empty-string column nobody chose.
    expect(readSelectValue(itemOf({}), 'status')).toBeNull();
    expect(readSelectValue(itemOf({ status: null }), 'status')).toBeNull();
    expect(readSelectValue(itemOf({ status: '' }), 'status')).toBeNull();
  });
});

describe('reading a date value', () => {
  it('reads a calendar day', () => {
    expect(readDateValue(itemOf({ due: '2026-03-01' }), 'due')).toBe('2026-03-01');
  });

  it('refuses anything carrying a time or a zone', () => {
    // The whole reason dates are stored as yyyy-MM-dd: a property meaning "the 3rd" must not shift
    // to the 2nd for a reader in another zone, and accepting an instant here is how that starts.
    expect(readDateValue(itemOf({ due: '2026-03-01T00:00:00Z' }), 'due')).toBeNull();
    expect(readDateValue(itemOf({ due: '2026-3-1' }), 'due')).toBeNull();
    expect(readDateValue(itemOf({ due: 20260301 }), 'due')).toBeNull();
  });
});

describe('filtering', () => {
  const items = [
    itemOf({ status: 'Todo' }, { id: 'a' }),
    itemOf({ status: 'Doing' }, { id: 'b' }),
    itemOf({ tags: ['urgent', 'q3'] }, { id: 'c' }),
  ];

  it('returns everything when nothing is filtered', () => {
    expect(applyFilters(items, [])).toHaveLength(3);
  });

  it('keeps only items whose property matches', () => {
    const filtered = applyFilters(items, [{ propertyKey: 'status', values: ['Doing'] }]);

    expect(filtered.map((item) => item.id)).toEqual(['b']);
  });

  it('treats several values on one property as any-of', () => {
    const filtered = applyFilters(items, [{ propertyKey: 'status', values: ['Todo', 'Doing'] }]);

    expect(filtered.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('matches a multi-select when any member matches', () => {
    const filtered = applyFilters(items, [{ propertyKey: 'tags', values: ['q3'] }]);

    expect(filtered.map((item) => item.id)).toEqual(['c']);
  });

  it('treats several properties as all-of', () => {
    const filtered = applyFilters(
      [itemOf({ status: 'Doing', owner: 'Ada' }, { id: 'x' })],
      [
        { propertyKey: 'status', values: ['Doing'] },
        { propertyKey: 'owner', values: ['Grace'] },
      ],
    );

    expect(filtered).toHaveLength(0);
  });

  it('ignores a filter with no values rather than hiding everything', () => {
    expect(applyFilters(items, [{ propertyKey: 'status', values: [] }])).toHaveLength(3);
  });
});

describe('sorting', () => {
  it('falls back to sibling order when no property is named', () => {
    const items = [itemOf({}, { id: 'second', seq: 2000 }), itemOf({}, { id: 'first', seq: 1000 })];

    // Sibling order is the order somebody arranged by hand, and replacing it with an arbitrary
    // alphabetisation is the sort of helpfulness people undo.
    expect(sortItems(items, null, false).map((item) => item.id)).toEqual(['first', 'second']);
  });

  it('sorts by a property', () => {
    const items = [itemOf({ owner: 'Grace' }, { id: 'g' }), itemOf({ owner: 'Ada' }, { id: 'a' })];

    expect(sortItems(items, 'owner', false).map((item) => item.id)).toEqual(['a', 'g']);
    expect(sortItems(items, 'owner', true).map((item) => item.id)).toEqual(['g', 'a']);
  });

  it('sorts by title, which is not in the property bag as far as a column is concerned', () => {
    const items = [itemOf({}, { id: 'b', title: 'Beta' }), itemOf({}, { id: 'a', title: 'Alpha' })];

    expect(sortItems(items, 'title', false).map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('sorts numbers by value rather than by digit', () => {
    const items = [
      itemOf({ estimate: 10 }, { id: 'ten' }),
      itemOf({ estimate: 9 }, { id: 'nine' }),
    ];

    // Lexicographically "10" precedes "9", which is the classic wrong answer.
    expect(sortItems(items, 'estimate', false).map((item) => item.id)).toEqual(['nine', 'ten']);
  });

  it('puts empty values last whichever way the sort runs', () => {
    const items = [
      itemOf({}, { id: 'blank' }),
      itemOf({ owner: 'Ada' }, { id: 'ada' }),
      itemOf({ owner: 'Grace' }, { id: 'grace' }),
    ];

    // A column of blanks at the top tells nobody anything, and reversing the sort should not make
    // the blanks the headline.
    expect(sortItems(items, 'owner', false).map((item) => item.id)).toEqual([
      'ada',
      'grace',
      'blank',
    ]);
    expect(sortItems(items, 'owner', true).map((item) => item.id)).toEqual([
      'grace',
      'ada',
      'blank',
    ]);
  });

  it('does not disturb the array it was given', () => {
    const items = [itemOf({}, { id: 'b', seq: 2000 }), itemOf({}, { id: 'a', seq: 1000 })];

    sortItems(items, null, false);

    expect(items.map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('sorts string seqs that differ only past Number.MAX_SAFE_INTEGER correctly', () => {
    // Number(seq) - Number(seq) rounds both of these to the same double and would report them
    // equal (or order them by luck of comparator stability), which is exactly the bug bigint
    // comparison exists to avoid.
    const items = [
      itemOf({}, { id: 'higher', seq: '9007199254740993' }),
      itemOf({}, { id: 'lower', seq: '9007199254740992' }),
    ];

    expect(sortItems(items, null, false).map((item) => item.id)).toEqual(['lower', 'higher']);
  });

  it('sorts a mixed number and string seq pair correctly', () => {
    const items = [
      itemOf({}, { id: 'string', seq: '2000' }),
      itemOf({}, { id: 'number', seq: 1000 }),
    ];

    expect(sortItems(items, null, false).map((item) => item.id)).toEqual(['number', 'string']);
  });

  it('preserves input order for equal seqs', () => {
    const items = [
      itemOf({}, { id: 'first', seq: 1000 }),
      itemOf({}, { id: 'second', seq: 1000 }),
      itemOf({}, { id: 'third', seq: 1000 }),
    ];

    expect(sortItems(items, null, false).map((item) => item.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('sorts a negative seq before a positive one', () => {
    const items = [
      itemOf({}, { id: 'positive', seq: 1000 }),
      itemOf({}, { id: 'negative', seq: -1000 }),
    ];

    expect(sortItems(items, null, false).map((item) => item.id)).toEqual(['negative', 'positive']);
  });
});
