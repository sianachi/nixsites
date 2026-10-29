import { describe, expect, it } from 'vitest';

import {
  posteriors,
  suggestValue,
  trainValueModel,
  type LabelledExample,
} from '../../../lib/suggest/naive-bayes';
import { tokens } from '../../../lib/suggest/tokenize';

/**
 * The title-to-value classifier, trained on small hand-built corpora of the kind a container of
 * errands or bills actually is. What is pinned is when it speaks and when it stays quiet, and that
 * the reason it gives is counted from the examples rather than invented.
 */

function example(title: string, ...values: string[]): LabelledExample {
  return { tokens: tokens(title), values };
}

const BILLS = [
  example('Electricity invoice March', 'Bills'),
  example('Water invoice', 'Bills'),
  example('Internet invoice April', 'Bills'),
  example('Phone bill', 'Bills'),
  example('Buy groceries', 'Errands'),
  example('Pick up dry cleaning', 'Errands'),
  example('Return library books', 'Errands'),
  example('Groceries for the weekend', 'Errands'),
  example('Untitled thought'),
];

describe('the value classifier', () => {
  it('suggests the value a shared word points at, and says which word and how often', () => {
    const model = trainValueModel(BILLS);
    const suggestion = suggestValue(model, tokens('Gas invoice May'));

    expect(suggestion).not.toBeNull();
    expect(suggestion?.value).toBe('Bills');
    expect(suggestion?.posterior).toBeGreaterThanOrEqual(0.6);
    // Three of the three labelled titles containing "invoice" are Bills - counted, not estimated.
    expect(suggestion?.evidence).toEqual({ word: 'invoice', withValue: 3, withWord: 3 });
  });

  it('skips examples that carry no value', () => {
    const model = trainValueModel(BILLS);
    expect(model.labelled).toBe(8);
  });

  it('stays quiet when the title shares no word with anything it learned from', () => {
    const model = trainValueModel(BILLS);
    // Otherwise the answer would be the prior - "most items are X" - which is not learned from the
    // title at all.
    expect(suggestValue(model, tokens('Plan the holiday'))).toBeNull();
  });

  it('stays quiet below the minimum number of labelled examples', () => {
    const model = trainValueModel(BILLS.slice(0, 4).concat(BILLS.slice(4, 4)));
    expect(model.labelled).toBe(4);
    expect(suggestValue(model, tokens('Gas invoice'))).toBeNull();
  });

  it('stays quiet when every example carries the same value, which is a default rather than a prediction', () => {
    const model = trainValueModel(BILLS.slice(0, 4).concat([example('Rent invoice', 'Bills')]));
    expect(suggestValue(model, tokens('Gas invoice'))).toBeNull();
  });

  it('stays quiet when the title is split evenly between two categories', () => {
    const model = trainValueModel([
      ...BILLS,
      example('Groceries invoice', 'Errands'),
      example('Groceries invoice again', 'Bills'),
    ]);
    // "groceries" points at Errands and "invoice" at Bills, roughly equally - not confident enough.
    expect(suggestValue(model, tokens('Groceries invoice'))).toBeNull();
  });

  it('needs the explaining word to have been seen with the value more than once', () => {
    const model = trainValueModel([
      example('Dentist appointment', 'Health'),
      example('Buy groceries', 'Errands'),
      example('Groceries again', 'Errands'),
      example('More groceries', 'Errands'),
      example('Groceries list', 'Errands'),
    ]);
    // One dentist example is a coincidence, not a habit.
    expect(suggestValue(model, tokens('Dentist checkup'))).toBeNull();
  });

  it('learns a multi-valued example under each of its values', () => {
    const model = trainValueModel([example('Trip to Lisbon', 'Travel', 'Fun')]);
    expect(model.documents.get('Travel')).toBe(1);
    expect(model.documents.get('Fun')).toBe(1);
  });

  it('never offers a value the caller excludes', () => {
    const model = trainValueModel(BILLS);
    expect(suggestValue(model, tokens('Gas invoice'), undefined, new Set(['Bills']))).toBeNull();
  });

  it('gives posteriors that sum to one, highest first', () => {
    const model = trainValueModel(BILLS);
    const ranked = posteriors(model, tokens('Gas invoice'));
    const total = ranked.reduce((sum, entry) => sum + entry.posterior, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(ranked[0]?.value).toBe('Bills');
  });

  it('answers no posteriors for an empty model', () => {
    expect(posteriors(trainValueModel([]), ['anything'])).toEqual([]);
  });
});
