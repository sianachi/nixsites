import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSuggestionDismissals,
  MAXIMUM_DISMISSALS,
  readDismissals,
  rememberDismissal,
} from '@nix/web-foundation/lib/suggestion-dismissals';
import { memoryStorage } from '../memory-storage';

/** An in-memory `Storage`: the test environment's global is not a usable one. */
describe('suggestion dismissals', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('remembers a dismissal once, however often it is dismissed', () => {
    rememberDismissal('stale:w1:item-1:2026-09-01');
    rememberDismissal('stale:w1:item-1:2026-09-01');

    expect([...readDismissals()]).toEqual(['stale:w1:item-1:2026-09-01']);
  });

  it(`keeps at most ${String(MAXIMUM_DISMISSALS)}, forgetting the oldest first`, () => {
    for (let index = 0; index <= MAXIMUM_DISMISSALS; index += 1) {
      rememberDismissal(`mention:w1:item-${String(index)}`);
    }

    const kept = readDismissals();
    expect(kept.size).toBe(MAXIMUM_DISMISSALS);
    expect(kept.has('mention:w1:item-0')).toBe(false);
    expect(kept.has(`mention:w1:item-${String(MAXIMUM_DISMISSALS)}`)).toBe(true);
  });

  it('ignores an empty or oversized key', () => {
    rememberDismissal('');
    rememberDismissal('x'.repeat(513));

    expect(readDismissals().size).toBe(0);
  });

  it('treats corrupt storage as nothing dismissed, and recovers on the next dismissal', () => {
    localStorage.setItem('nix.suggestion-dismissals', '{not json');
    expect(readDismissals().size).toBe(0);

    localStorage.setItem('nix.suggestion-dismissals', JSON.stringify([42]));
    expect(readDismissals().size).toBe(0);

    rememberDismissal('mention:w1:item-1');
    expect(readDismissals().has('mention:w1:item-1')).toBe(true);
  });

  it('forgets everything when cleared at sign-out', () => {
    rememberDismissal('mention:w1:item-1');

    clearSuggestionDismissals();

    expect(readDismissals().size).toBe(0);
  });

  it('degrades to nothing dismissed where the browser has no storage', () => {
    vi.stubGlobal('localStorage', undefined);

    rememberDismissal('mention:w1:item-1');

    expect(readDismissals().size).toBe(0);
  });
});
