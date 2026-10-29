import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryStorage } from '../../testing/memory-storage';

import {
  RECENT_ITEMS_PER_WORKSPACE,
  clearRecentItems,
  recentItems,
  recordRecentItem,
} from '../../lib/recent-items';

const ids = (workspaceId: string): string[] =>
  recentItems(workspaceId).map((entry) => entry.itemId);

// The suite's jsdom leaves `localStorage` without methods; a real in-memory store is stubbed in.
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

describe('recent items', () => {
  it('lists the most recently viewed first and moves a revisited item to the front', () => {
    recordRecentItem('w1', 'a', 'A');
    recordRecentItem('w1', 'b', 'B');
    recordRecentItem('w1', 'a', 'A renamed');
    expect(recentItems('w1')).toEqual([
      { workspaceId: 'w1', itemId: 'a', title: 'A renamed' },
      { workspaceId: 'w1', itemId: 'b', title: 'B' },
    ]);
  });

  it('keeps each workspace to its own list and its own cap', () => {
    for (let index = 0; index < RECENT_ITEMS_PER_WORKSPACE + 2; index += 1) {
      recordRecentItem('w1', `item-${String(index)}`, '');
    }
    recordRecentItem('w2', 'other', 'Other');
    expect(ids('w1')).toHaveLength(RECENT_ITEMS_PER_WORKSPACE);
    expect(ids('w1')[0]).toBe(`item-${String(RECENT_ITEMS_PER_WORKSPACE + 1)}`);
    expect(ids('w2')).toEqual(['other']);
  });

  it('reads a damaged store as empty and forgets everything on clear', () => {
    localStorage.setItem('nix.recent-items', '{not json');
    expect(recentItems('w1')).toEqual([]);
    recordRecentItem('w1', 'a', 'A');
    clearRecentItems();
    expect(recentItems('w1')).toEqual([]);
  });
});
