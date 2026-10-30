import { describe, expect, it } from 'vitest';

import { canChartBy, isDateShaped, PROPERTY_TYPES, valueShapeOf } from './property-types.js';

describe('valueShapeOf', () => {
  const expected: Record<string, string> = {
    text: 'text',
    long_text: 'long_text',
    number: 'number',
    select: 'select',
    multi_select: 'multi_select',
    date: 'date',
    timestamp: 'timestamp',
    datetime: 'datetime',
    checkbox: 'checkbox',
    url: 'url',
    image: 'image',
    due_date: 'date',
    start_date: 'date',
    completion: 'checkbox',
    priority: 'number',
    estimate: 'number',
    assignee: 'text',
    formula: 'formula',
    rollup: 'rollup',
    reminder: 'timestamp',
  };

  it.each(PROPERTY_TYPES.map((entry) => entry.value))('resolves the shape of %s', (type) => {
    expect(valueShapeOf(type)).toBe(expected[type]);
  });
});

describe('isDateShaped', () => {
  it('is true only for date, timestamp, datetime, due_date and start_date', () => {
    const dateShaped = new Set(['date', 'timestamp', 'datetime', 'due_date', 'start_date']);
    for (const entry of PROPERTY_TYPES) {
      expect(isDateShaped(entry.value)).toBe(dateShaped.has(entry.value));
    }
  });
});

describe('canChartBy', () => {
  it.each([
    ['select', true],
    ['priority', true],
    ['checkbox', true],
    ['completion', true],
    ['due_date', true],
    ['multi_select', false],
    ['assignee', false],
    ['number', false],
  ])('%s -> %s', (type, expected) => {
    expect(canChartBy(type)).toBe(expected);
  });
});
