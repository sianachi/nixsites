import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rememberSubmission, usualValue, usualValues } from '../../../views/form/form-memory';
import { CATEGORY, NOTES, TAGS } from '../suggest/suggest-fixtures';
import { memoryStorage } from '../../memory-storage';

const PRIORITY = {
  key: 'priority',
  label: 'Priority',
  type: 'priority',
  options: [],
  required: false,
};

describe('form memory', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers the usual value only after it was submitted at least twice', () => {
    rememberSubmission('w', 'form', [CATEGORY], { category: 'Bills' });
    expect(usualValues('w', 'form', [CATEGORY]).size).toBe(0);

    rememberSubmission('w', 'form', [CATEGORY], { category: 'Bills' });
    expect(usualValues('w', 'form', [CATEGORY]).get('category')).toEqual({
      key: 'Bills',
      stored: 'Bills',
    });
  });

  it('keeps forms and workspaces apart', () => {
    rememberSubmission('w', 'form', [CATEGORY], { category: 'Bills' });
    rememberSubmission('w', 'form', [CATEGORY], { category: 'Bills' });
    expect(usualValues('w', 'other-form', [CATEGORY]).size).toBe(0);
    expect(usualValues('elsewhere', 'form', [CATEGORY]).size).toBe(0);
  });

  it('never persists custom values from dynamic choice fields', () => {
    const dynamic = { ...CATEGORY, choiceSource: { itemId: null, field: CATEGORY.key } };
    rememberSubmission('w', 'form', [dynamic], { [dynamic.key]: 'A private name' });
    rememberSubmission('w', 'form', [dynamic], { [dynamic.key]: 'A private name' });
    expect(usualValues('w', 'form', [dynamic]).size).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it('never remembers free text', () => {
    rememberSubmission('w', 'form', [NOTES], { notes: 'private thought' });
    rememberSubmission('w', 'form', [NOTES], { notes: 'private thought' });
    expect(usualValues('w', 'form', [NOTES]).size).toBe(0);
    expect(JSON.stringify(localStorage.getItem('nix.frecency.form:w:form:notes'))).not.toContain(
      'private',
    );
  });

  it('remembers each option of a multi-select and a priority step', () => {
    for (let index = 0; index < 2; index += 1) {
      rememberSubmission('w', 'form', [TAGS, PRIORITY], { tags: ['home'], priority: 2 });
    }
    const usual = usualValues('w', 'form', [TAGS, PRIORITY]);
    expect(usual.get('tags')?.stored).toEqual(['home']);
    expect(usual.get('priority')?.stored).toBe(2);
  });

  it('offers nothing when the habit is split or no longer valid', () => {
    expect(
      usualValue(
        new Map([
          ['Bills', 2],
          ['Errands', 2.5],
          ['Health', 2],
        ]),
        CATEGORY,
      ),
    ).toBeNull();
    expect(usualValue(new Map([['Retired option', 5]]), CATEGORY)).toBeNull();
    expect(usualValue(new Map([['9', 5]]), PRIORITY)).toBeNull();
  });
});
