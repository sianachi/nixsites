import { describe, expect, it, vi } from 'vitest';

import {
  describeBulkDelete,
  describeDeleteConfirm,
  executeBulkDelete,
  planBulkDelete,
} from '../../items/bulk-delete';
import type { TreeItem } from '../../items/use-workspace-tree';

function node(id: string, parentId: string | null, extra: Partial<TreeItem> = {}): TreeItem {
  return {
    id,
    title: id,
    type: 'note',
    parentId,
    hasChildren: false,
    seq: 0,
    lifecycleState: 'active',
    ...extra,
  };
}

// a -> b -> c, a -> b2, and root-level d, e. Only a and b carry children.
const items = [
  node('a', null, { hasChildren: true }),
  node('b', 'a', { hasChildren: true }),
  node('c', 'b'),
  node('b2', 'a'),
  node('d', null),
  node('e', null, { noDelete: true, title: 'Ledger' }),
  node('f', null, { hasChildren: true }),
];
const tree = (locked: readonly string[] = []) => ({
  find: (id: string) => items.find((entry) => entry.id === id) ?? null,
  childrenOf: (parentId: string | null) => items.filter((entry) => entry.parentId === parentId),
  isLocked: (id: string) => locked.includes(id),
});

describe('planBulkDelete', () => {
  it('deletes top-level items only and counts what sits inside them', () => {
    const plan = planBulkDelete(['c', 'a', 'd'], tree());
    expect(plan.items.map((item) => item.id)).toEqual(['a', 'd']);
    expect(plan.carried).toEqual(['c']);
    expect(plan.descendants).toBe(3);
  });

  it('leaves out protected items and items under a closed lock, and names them', () => {
    const plan = planBulkDelete(['d', 'e', 'c'], tree(['a']));
    expect(plan.items.map((item) => item.id)).toEqual(['d']);
    expect(plan.blocked).toEqual([
      { id: 'e', title: 'Ledger', reason: 'protected' },
      { id: 'c', title: 'c', reason: 'locked' },
    ]);
  });

  it('does not count what the tree has not loaded', () => {
    expect(planBulkDelete(['f'], tree()).descendants).toBeNull();
  });
});

describe('describeDeleteConfirm', () => {
  it('says plural and singular, with the count of what goes along', () => {
    const many = describeDeleteConfirm(planBulkDelete(['a', 'd', 'e'], tree()));
    expect(many.title).toBe('Delete 2 items?');
    expect(many.confirm).toBe('Delete 2 items');
    expect(many.body).toEqual([
      'This also deletes 3 items inside them. You can restore them from Trash.',
      `1 item can't be deleted: "Ledger" is protected.`,
    ]);
    const one = describeDeleteConfirm(planBulkDelete(['d'], tree()));
    expect(one.title).toBe('Delete 1 item?');
    expect(one.body).toEqual([]);
  });

  it('leaves the number out when it cannot be counted, and offers no delete when nothing can go', () => {
    expect(describeDeleteConfirm(planBulkDelete(['f'], tree())).body).toEqual([
      'This also deletes the items inside it. You can restore them from Trash.',
    ]);
    const none = describeDeleteConfirm(planBulkDelete(['e'], tree()));
    expect(none.confirm).toBeNull();
    expect(none.title).toBe('Nothing to delete');
  });
});

describe('executeBulkDelete and describeBulkDelete', () => {
  it('reports every delete, and names the first failure with its reason', async () => {
    const remove = vi.fn((id: string) =>
      Promise.resolve({ refusal: id === 'b2' ? 'The item is locked.' : null }),
    );
    const chosen = ['d', 'b2', 'f'].flatMap((id) => items.filter((entry) => entry.id === id));
    const outcome = await executeBulkDelete({ remove }, chosen);
    expect(outcome.deleted.map((item) => item.id)).toEqual(['d', 'f']);
    expect(describeBulkDelete(outcome)).toBe(
      'Deleted 2 of 3 items. "b2" could not be deleted: The item is locked.',
    );
    expect(describeBulkDelete({ deleted: chosen, failed: [] })).toBe('Deleted 3 items');
  });
});
