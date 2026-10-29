import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearFrecency,
  decayedScore,
  frecencyScores,
  HALF_LIFE_MS,
  MAX_CACHED_NAMESPACES,
  MAX_ENTRIES,
  recordPick,
  withPick,
} from '../../lib/frecency';
import { memoryStorage } from '../../testing/memory-storage';

const NOW = 1_800_000_000_000;

/** An in-memory `Storage`: the test environment's global is not a usable one. */
describe('frecency', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });

  afterEach(() => {
    clearFrecency();
    vi.unstubAllGlobals();
  });

  it('halves a score every half-life', () => {
    expect(decayedScore({ key: 'a', score: 4, at: NOW }, NOW + HALF_LIFE_MS)).toBeCloseTo(2);
  });

  it('ranks a recent pick above an older, once-stronger one', () => {
    let entries = withPick([], 'old', NOW);
    entries = withPick(entries, 'old', NOW);
    entries = withPick(entries, 'new', NOW + 3 * HALF_LIFE_MS);
    expect(entries[0]?.key).toBe('new');
  });

  it('keeps at most the strongest entries', () => {
    let entries = withPick([], 'keep', NOW);
    entries = withPick(entries, 'keep', NOW);
    for (let index = 0; index < MAX_ENTRIES + 5; index += 1) {
      entries = withPick(entries, `k${String(index)}`, NOW);
    }
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0]?.key).toBe('keep');
  });

  it('round-trips through storage per namespace and clears on sign-out', () => {
    recordPick('links:w1', 'item-1', NOW);
    recordPick('links:w2', 'item-2', NOW);
    expect(frecencyScores('links:w1', NOW).get('item-1')).toBeCloseTo(1);
    expect(frecencyScores('links:w1', NOW).has('item-2')).toBe(false);
    clearFrecency();
    expect(frecencyScores('links:w1', NOW).size).toBe(0);
  });

  it('treats corrupt storage as no history', () => {
    localStorage.setItem('nix.frecency.slash', '{not json');
    expect(frecencyScores('slash', NOW).size).toBe(0);
    recordPick('slash', 'heading', NOW);
    expect(frecencyScores('slash', NOW).get('heading')).toBeCloseTo(1);
  });

  it('serves repeat reads from memory without parsing storage again', () => {
    recordPick('slash', 'heading', NOW);
    const getItem = vi.spyOn(localStorage, 'getItem');
    frecencyScores('slash', NOW);
    frecencyScores('slash', NOW);
    expect(getItem).not.toHaveBeenCalled();
  });

  it('drops a cached namespace when another tab writes it', () => {
    expect(frecencyScores('slash', NOW).size).toBe(0);
    localStorage.setItem(
      'nix.frecency.slash',
      JSON.stringify([{ key: 'table', score: 2, at: NOW }]),
    );
    expect(frecencyScores('slash', NOW).size).toBe(0);

    window.dispatchEvent(new StorageEvent('storage', { key: 'nix.frecency.slash' }));

    expect(frecencyScores('slash', NOW).get('table')).toBeCloseTo(2);
  });

  it('drops everything when another tab clears storage', () => {
    recordPick('slash', 'heading', NOW);
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(frecencyScores('slash', NOW).size).toBe(0);
  });

  it('keeps at most a bounded number of namespaces in memory, least recently used first out', () => {
    recordPick('first', 'a', NOW);
    for (let index = 0; index < MAX_CACHED_NAMESPACES; index += 1) {
      recordPick(`ns${String(index)}`, 'a', NOW);
    }
    const getItem = vi.spyOn(localStorage, 'getItem');
    frecencyScores('first', NOW);
    expect(getItem).toHaveBeenCalledWith('nix.frecency.first');
  });

  it('forgets the memory copy when it is cleared', () => {
    recordPick('slash', 'heading', NOW);
    clearFrecency();
    expect(frecencyScores('slash', NOW).size).toBe(0);
  });
});
