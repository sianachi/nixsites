import { describe, expect, it } from 'vitest';

import { decorateItem, decorateItems, toCellValue } from '../../collections/properties/computed';
import { readPropertyText } from '../../collections/core/container-model';
import type { PropertyDefinition, PropertyOwner } from '../../collections/core/container-model';

/**
 * The read-side decoration that gives an item the values it never stored.
 *
 * The engine's own behaviour is held by `packages/sheet/src/properties.test.ts`; what is checked
 * here is the two conversions this layer owns and the promise it makes to everything downstream -
 * that a computed value arrives in the property bag every view already reads.
 */

function property(over: Partial<PropertyDefinition>): PropertyDefinition {
  return { key: 'k', label: 'K', type: 'text', options: [], required: false, ...over };
}

function formula(key: string, expression: string): PropertyDefinition {
  return property({ key, label: key, type: 'formula', expression });
}

function owner(
  properties: Record<string, unknown>,
  computed: Record<string, unknown> | null = null,
): PropertyOwner {
  return { title: 'An item', properties, computed };
}

function rollup(key: string, aggregate: string, source: string | null): PropertyDefinition {
  return property({ key, label: key, type: 'rollup', aggregate, source });
}

describe('computing a property from an item', () => {
  it('puts the computed value in the bag under the property key', () => {
    const [item] = decorateItems(
      [owner({ price: 12.5, quantity: 4 })],
      [property({ key: 'price', type: 'number' }), formula('total', '[price] * [quantity]')],
    );

    expect(item?.properties.total).toBe(50);
  });

  it('leaves the stored properties exactly as they were', () => {
    const [item] = decorateItems([owner({ price: 3 })], [formula('double', '[price] * 2')]);

    expect(item?.properties.price).toBe(3);
  });

  it('renders through the reader every view already uses', () => {
    // The whole point of merging into the bag: a list cell, a board column and a sort read a
    // computed value without any of them learning what a formula is.
    const [item] = decorateItems([owner({ a: 2, b: 3 })], [formula('sum', '[a] + [b]')]);

    expect(readPropertyText(item ?? owner({}), 'sum')).toBe('5');
  });

  it('shows an error as the code that says what went wrong', () => {
    const [item] = decorateItems(
      [owner({ done: 1, total: 0 })],
      [formula('rate', '[done] / [total]')],
    );

    expect(item?.properties.rate).toBe('#DIV/0!');
  });

  it('returns the very same array when the schema declares no formula', () => {
    // Identity, not just equality: this sits between the loader and every view's memoised
    // derivation of the children, so a container with no formulas must not invalidate them.
    const items = [owner({ a: 1 })];

    expect(decorateItems(items, [property({ key: 'a', type: 'number' })])).toBe(items);
    expect(decorateItems(items, undefined)).toBe(items);
  });

  it('reads a declared property nobody has filled in as empty, not as a misspelling', () => {
    // The first ordinary use of the feature: declare the formula, then fill the property in on
    // some children and not others. Reading the bag alone would answer #NAME? on every row
    // somebody had not got to yet, which says the property does not exist when it plainly does.
    const [item] = decorateItems(
      [owner({})],
      [property({ key: 'price', type: 'number' }), formula('total', '[price] * 2')],
    );

    expect(item?.properties.total).toBe(0);
  });

  it('still answers unknown for a key nothing declares', () => {
    // The distinction the empty case must not swallow: a misspelled reference is the mistake this
    // exists to make visible.
    const [item] = decorateItems(
      [owner({ price: 3 })],
      [property({ key: 'price', type: 'number' }), formula('total', '[prise] * 2')],
    );

    expect(item?.properties.total).toBe('#NAME?');
  });

  it('reports a property holding a value of the wrong kind as a wrong-kind error', () => {
    // Not #NAME?: the property exists and holds something. It is the value that cannot be used.
    const [item] = decorateItems(
      [owner({ note: { nested: true } })],
      [property({ key: 'note', type: 'text' }), formula('length', 'LEN([note])')],
    );

    expect(item?.properties.length).toBe('#VALUE!');
  });

  it('ignores a formula property whose declaration carries no expression', () => {
    const [item] = decorateItems([owner({ a: 1 })], [property({ key: 'broken', type: 'formula' })]);

    expect(item?.properties.broken).toBeUndefined();
  });

  it('computes one item the same way it computes a page of them', () => {
    const item = decorateItem(owner({ a: 4 }), [formula('double', '[a] * 2')]);

    expect(item.properties.double).toBe(8);
  });
});

describe('reading a stored property as the engine sees it', () => {
  it('passes numbers, text and booleans through', () => {
    expect(toCellValue(4)).toBe(4);
    expect(toCellValue('four')).toBe('four');
    expect(toCellValue(true)).toBe(true);
  });

  it('tells an empty property apart from an absent one', () => {
    // The engine answers #NAME? for absent and coerces empty to zero, which is what makes a
    // misspelled key visible instead of silently arithmetic.
    expect(toCellValue(null)).toBeNull();
    expect(toCellValue(undefined)).toBeUndefined();
  });

  it('reads a multi-select the way a table cell reads it', () => {
    expect(toCellValue(['red', 'blue'])).toBe('red, blue');
  });

  it('reports a value with no scalar reading as the wrong kind rather than stringifying it', () => {
    expect(toCellValue({ nested: true })).toEqual({ error: '#VALUE!' });
  });
});

describe('the rollups the server folded', () => {
  it('reach the property bag every view already reads', () => {
    const [item] = decorateItems([owner({}, { tasks: 4 })], [rollup('tasks', 'count', null)]);

    expect(item?.properties.tasks).toBe(4);
  });

  it('are readable by a formula, so a percentage is a formula over a rollup', () => {
    // The composition ADR-0044 is built for: the fold arrives from the server and the expression
    // is evaluated here, and neither has to know about the other.
    const [item] = decorateItems(
      [owner({}, { done: 3, tasks: 4 })],
      [
        rollup('done', 'count', 'completion'),
        rollup('tasks', 'count', null),
        formula('progress', 'ROUND([done] / [tasks] * 100, 0)'),
      ],
    );

    expect(item?.properties.progress).toBe(75);
  });

  it('are merged even when the schema declares no formula at all', () => {
    const [item] = decorateItems(
      [owner({}, { tasks: 4 })],
      [property({ key: 'a', type: 'number' })],
    );

    expect(item?.properties.tasks).toBe(4);
  });

  it('leave the array identical when a page carries none', () => {
    // A page that folded nothing must not invalidate every downstream memo for the sake of a
    // merge with nothing to merge.
    const items = [owner({ a: 1 })];

    expect(decorateItems(items, [property({ key: 'a', type: 'number' })])).toBe(items);
  });

  it('are not invented for an item that arrived without them', () => {
    // Null means "this read did not fold children", which a write response never does. Drawing a
    // zero there would report an empty container after every edit.
    const [item] = decorateItems([owner({}, null)], [rollup('tasks', 'count', null)]);

    expect(item?.properties.tasks).toBeUndefined();
  });
});
