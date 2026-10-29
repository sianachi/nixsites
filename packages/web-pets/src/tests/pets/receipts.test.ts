import { describe, expect, it } from 'vitest';
import { receiptSentence } from '../../pets/work-tools/receipts';

describe('receiptSentence', () => {
  it('turns the pet-voice promise into the imperative request', () => {
    expect(receiptSentence('I will mark “Pay rent” done.')).toBe('Mark “Pay rent” done.');
  });

  it('drops the pointer to content a receipt no longer shows', () => {
    expect(
      receiptSentence(
        'I will create a note named “Plan” at the top level of this workspace, with the content shown below.',
      ),
    ).toBe('Create a note named “Plan” at the top level of this workspace.');
    expect(
      receiptSentence(
        'I will update the linked item with the property values shown below, leaving other properties unchanged.',
      ),
    ).toBe('Update the linked item, leaving other properties unchanged.');
    expect(
      receiptSentence(
        'I will add the content below to the end of the linked note, preserving its existing content.',
      ),
    ).toBe('Add content to the end of the linked note, preserving its existing content.');
  });

  it('leaves a refusal as it is', () => {
    expect(receiptSentence('I cannot run this request as written.')).toBe(
      'I cannot run this request as written.',
    );
  });
});
