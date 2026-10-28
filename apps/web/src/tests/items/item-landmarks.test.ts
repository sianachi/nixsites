import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../memory-storage';

import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import {
  itemLandmarksKey,
  readItemLandmarks,
  subscribeItemLandmarks,
  writeItemLandmark,
} from '@nix/web-foundation/lib/item-landmarks';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

describe('browser-local item landmarks', () => {
  it('retains a choice across remounts and isolates people and workspaces', () => {
    const key = itemLandmarksKey('person-a', 'workspace-a');
    const stop = subscribeItemLandmarks(vi.fn());
    expect(writeItemLandmark(key, 'journal', { icon: 'notebook', tone: 'accent' })).toBe(true);
    stop();
    const stopAgain = subscribeItemLandmarks(vi.fn());
    expect(readItemLandmarks(key).journal).toEqual({ icon: 'notebook', tone: 'accent' });
    expect(readItemLandmarks(itemLandmarksKey('person-b', 'workspace-a'))).toEqual({});
    expect(readItemLandmarks(itemLandmarksKey('person-a', 'workspace-b'))).toEqual({});
    expect(writeItemLandmark(key, 'journal', null)).toBe(true);
    expect(browserStorage()?.getItem(key)).toBeNull();
    stopAgain();
  });

  it('rejects unknown icons and malformed stored data', () => {
    const key = itemLandmarksKey('invalid', 'workspace');
    browserStorage()?.setItem(
      key,
      JSON.stringify({ journal: { icon: 'unknown', tone: 'accent' } }),
    );
    expect(readItemLandmarks(key)).toEqual({});
    const brokenKey = itemLandmarksKey('broken', 'workspace');
    browserStorage()?.setItem(brokenKey, '{');
    expect(readItemLandmarks(brokenKey)).toEqual({});
  });

  it('updates subscribers when another browser tab changes an icon', () => {
    const key = itemLandmarksKey('tabs', 'workspace');
    const listener = vi.fn();
    const stop = subscribeItemLandmarks(listener);
    expect(readItemLandmarks(key)).toEqual({});
    browserStorage()?.setItem(key, JSON.stringify({ journal: { icon: 'heart', tone: 'muted' } }));
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(listener).toHaveBeenCalledOnce();
    expect(readItemLandmarks(key).journal).toEqual({ icon: 'heart', tone: 'muted' });
    stop();
  });

  it('reports failed storage while keeping the choice for the current page', () => {
    const key = itemLandmarksKey('no-storage', 'workspace');
    vi.stubGlobal('localStorage', undefined);
    const stop = subscribeItemLandmarks(vi.fn());
    expect(writeItemLandmark(key, 'journal', { icon: 'book', tone: 'foreground' })).toBe(false);
    expect(readItemLandmarks(key).journal).toEqual({ icon: 'book', tone: 'foreground' });
    stop();
  });
});
