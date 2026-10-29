import { describe, expect, it, vi } from 'vitest';

import {
  describeBulkMove,
  dropRefusal,
  executeBulkMove,
  isInsideSelection,
  planBulkMove,
} from '../../items/bulk-move';
import type { TreeItem } from '../../items/use-workspace-tree';

function node(id: string, parentId: string | null): TreeItem {
  return {
    id,
    title: id,
    type: 'note',
    parentId,
    hasChildren: false,
    seq: 0,
    lifecycleState: 'active',
  };
}

// root -> a -> b -> c, and a sibling d at the root.
const items = new Map<string, TreeItem>([
  ['a', node('a', null)],
  ['b', node('b', 'a')],
  ['c', node('c', 'b')],
  ['d', node('d', null)],
]);
const find = (id: string): TreeItem | null => items.get(id) ?? null;

describe('planBulkMove', () => {
  it('drops a selected descendant of a selected ancestor, so nothing moves twice', () => {
    const plan = planBulkMove(['c', 'a', 'd'], find);
    expect(plan.ids).toEqual(['a', 'd']);
    expect(plan.carried).toEqual(['c']);
  });

  it('keeps an id the tree has not loaded, leaving the server to judge it', () => {
    expect(planBulkMove(['zz'], find).ids).toEqual(['zz']);
  });
});

describe('isInsideSelection', () => {
  it('refuses the selection itself and anything under it, and allows the root', () => {
    const selected = new Set(['b']);
    expect(isInsideSelection('b', selected, find)).toBe(true);
    expect(isInsideSelection('c', selected, find)).toBe(true);
    expect(isInsideSelection('a', selected, find)).toBe(false);
    expect(isInsideSelection(null, selected, find)).toBe(false);
  });
});

describe('executeBulkMove', () => {
  it('moves one at a time and reports every refusal rather than a blanket success', async () => {
    const move = vi
      .fn<
        (
          id: string,
          parentId: string | null,
          afterId: string | null,
        ) => Promise<{ refusal: string | null }>
      >()
      .mockImplementation((id) =>
        Promise.resolve({ refusal: id === 'd' ? 'That would make a cycle.' : null }),
      );
    const outcome = await executeBulkMove({ move }, ['a', 'd'], 'x');
    expect(move).toHaveBeenCalledTimes(2);
    expect(move).toHaveBeenNthCalledWith(1, 'a', 'x', null);
    expect(outcome.moved).toEqual(['a']);
    expect(outcome.refused).toEqual([{ id: 'd', reason: 'That would make a cycle.' }]);
    expect(describeBulkMove(outcome, 1)).toBe(
      '1 of 2 items moved; 1 refused: That would make a cycle. 1 selected item moved with their parent.',
    );
    expect(describeBulkMove({ moved: ['a'], refused: [] }, 0)).toBe('1 item moved.');
  });
});

describe('dropRefusal', () => {
  it('refuses a drop onto the dragged item or anything beneath it', () => {
    expect(dropRefusal(['a'], 'a', find)).toBe('An item cannot be moved inside itself.');
    expect(dropRefusal(['a'], 'c', find)).toBe('An item cannot be moved inside itself.');
  });

  it('allows a sibling and refuses a target that takes no children', () => {
    expect(dropRefusal(['a'], 'd', find)).toBeNull();
    items.set('d', { ...node('d', null), noChildren: true });
    expect(dropRefusal(['a'], 'd', find)).toBe('d does not accept new children.');
    items.set('d', node('d', null));
  });
});
