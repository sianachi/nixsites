import { describe, expect, it } from 'vitest';

import { suggestProperties, trainPropertyModels } from '../../../suggest/property-suggestions';
import { CATEGORY, NOTES, TAGS, anItem, billsAndErrands } from '../../../testing/suggest-fixtures';

describe('property suggestions from siblings', () => {
  it('learns only the category-like properties', () => {
    const models = trainPropertyModels(billsAndErrands(), [CATEGORY, TAGS, NOTES]);
    expect(models.map((model) => model.property.key)).toEqual(['category', 'tags']);
  });

  it('suggests a select value with its stored form and reason', () => {
    const models = trainPropertyModels(billsAndErrands(), [CATEGORY]);
    const [suggestion] = suggestProperties(models, 'Gas invoice', new Set());
    expect(suggestion).toMatchObject({
      value: 'Bills',
      stored: 'Bills',
      evidence: { word: 'invoice', withValue: 3, withWord: 3 },
    });
  });

  it('stores a multi-select suggestion as a one-option list', () => {
    // Five children carry a tag, three of them "money" with "invoice" in the title.
    const [suggestion] = suggestProperties(
      trainPropertyModels(billsAndErrands(), [TAGS]),
      'Gas invoice',
      new Set(),
    );
    expect(suggestion?.stored).toEqual(['money']);
  });

  it('never second-guesses a property the caller is setting', () => {
    const models = trainPropertyModels(billsAndErrands(), [CATEGORY]);
    expect(suggestProperties(models, 'Gas invoice', new Set(['category']))).toEqual([]);
  });

  it('ignores values the schema no longer declares', () => {
    const children = billsAndErrands().map((child) =>
      child.properties.category === 'Bills'
        ? { ...child, properties: { category: 'Old bills' } }
        : child,
    );
    const models = trainPropertyModels(children, [CATEGORY]);
    // Only the four Errands remain labelled - too few, and only one value.
    expect(suggestProperties(models, 'Gas invoice', new Set())).toEqual([]);
  });

  it('learns an assignee from stored identifiers', () => {
    const who = { key: 'who', label: 'Assignee', type: 'assignee', options: [], required: false };
    const children = [
      ...['Invoice one', 'Invoice two', 'Invoice three'].map((title) =>
        anItem(title, { who: 'p-1' }),
      ),
      ...['Garden', 'Garden again', 'Garden more'].map((title) => anItem(title, { who: 'p-2' })),
    ];
    const [suggestion] = suggestProperties(
      trainPropertyModels(children, [who]),
      'Invoice four',
      new Set(),
    );
    expect(suggestion?.stored).toBe('p-1');
  });
});
