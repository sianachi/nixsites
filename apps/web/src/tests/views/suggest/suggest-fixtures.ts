import type { Item, PropertyDefinition } from '../../../views/core/container-model';
import { memoryStorage } from '../../memory-storage';

/** Shared fixtures for the suggestion suites: a small container of bills and errands. */

export const WORKSPACE_ID = 'a1000000-0000-4000-8000-000000000001';

export const CATEGORY: PropertyDefinition = {
  key: 'category',
  label: 'Category',
  type: 'select',
  options: ['Bills', 'Errands', 'Health'],
  required: false,
};

export const TAGS: PropertyDefinition = {
  key: 'tags',
  label: 'Tags',
  type: 'multi_select',
  options: ['home', 'money'],
  required: false,
};

export const NOTES: PropertyDefinition = {
  key: 'notes',
  label: 'Notes',
  type: 'text',
  options: [],
  required: false,
};

let counter = 0;

/** An item with a fresh id, a title and a property bag. */
export function anItem(
  title: string,
  properties: Record<string, unknown> = {},
  overrides: Partial<Item> = {},
): Item {
  counter += 1;
  return {
    id: `b1000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    workspaceId: WORKSPACE_ID,
    parentId: 'c1000000-0000-4000-8000-000000000001',
    type: 'note',
    hasChildren: false,
    seq: counter,
    lifecycleState: 'active',
    title,
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Eight labelled bills and errands, enough for the classifier to speak. */
export function billsAndErrands(): Item[] {
  return [
    anItem('Electricity invoice March', { category: 'Bills', tags: ['money'] }),
    anItem('Water invoice', { category: 'Bills', tags: ['money'] }),
    anItem('Internet invoice April', { category: 'Bills', tags: ['money'] }),
    anItem('Phone bill', { category: 'Bills' }),
    anItem('Buy groceries', { category: 'Errands', tags: ['home'] }),
    anItem('Pick up dry cleaning', { category: 'Errands' }),
    anItem('Return library books', { category: 'Errands' }),
    anItem('Groceries for the weekend', { category: 'Errands', tags: ['home'] }),
  ];
}

/** An in-memory `Storage`: the test environment's global is not a usable one. */

export { memoryStorage };
