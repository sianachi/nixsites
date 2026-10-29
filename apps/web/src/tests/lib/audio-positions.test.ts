import { beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';

import {
  MAXIMUM_AUDIO_POSITIONS,
  forgetAudioPosition,
  readAudioPosition,
  rememberAudioPosition,
} from '@nix/web-foundation/lib/audio-positions';

/**
 * Resume points live in browser storage, which a person or an old build can leave holding
 * anything. A player that throws on a bad record is worse than one that starts from the top.
 */

const KEY = 'nix.audio-positions';

// The suite's jsdom leaves `localStorage` without methods; a real in-memory store is stubbed in.
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

describe('remembering a position', () => {
  it('reads back what was written', () => {
    rememberAudioPosition('item-a', 61.5);
    expect(readAudioPosition('item-a')).toBe(61.5);
    expect(readAudioPosition('item-b')).toBeNull();
  });

  it('keeps the most recently played first and replaces rather than duplicates an item', () => {
    rememberAudioPosition('a', 1);
    rememberAudioPosition('b', 2);
    rememberAudioPosition('a', 3);
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '[]') as { itemId: string }[];
    expect(stored.map((entry) => entry.itemId)).toEqual(['a', 'b']);
    expect(readAudioPosition('a')).toBe(3);
  });

  it('caps the list at 200, dropping the least recently played', () => {
    for (let i = 0; i < MAXIMUM_AUDIO_POSITIONS + 5; i += 1) {
      rememberAudioPosition(`item-${String(i)}`, i);
    }
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '[]') as { itemId: string }[];
    expect(stored).toHaveLength(200);
    expect(readAudioPosition('item-0')).toBeNull();
    expect(readAudioPosition('item-204')).toBe(204);
    expect(stored[0]?.itemId).toBe('item-204');
  });

  it.each([
    ['an empty id', '', 5],
    ['an id over 64 characters', 'x'.repeat(65), 5],
    ['a negative position', 'a', -1],
    ['a non-finite position', 'a', Number.NaN],
  ])('refuses %s', (_name, id, seconds) => {
    rememberAudioPosition(id, seconds);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('a damaged record', () => {
  it.each([
    ['not JSON', '{nope'],
    ['not an array', '{"itemId":"a","seconds":1}'],
    ['an entry with a negative position', '[{"itemId":"a","seconds":-3}]'],
    ['an entry with a missing id', '[{"seconds":3}]'],
    [
      'more than the cap',
      JSON.stringify(
        Array.from({ length: MAXIMUM_AUDIO_POSITIONS + 1 }, (_, i) => ({
          itemId: `i${String(i)}`,
          seconds: 1,
        })),
      ),
    ],
  ])('reads as nothing remembered when it is %s', (_name, raw) => {
    localStorage.setItem(KEY, raw);
    expect(readAudioPosition('a')).toBeNull();
    expect(readAudioPosition('i0')).toBeNull();
  });

  it('is replaced by the next write instead of blocking it', () => {
    localStorage.setItem(KEY, '{nope');
    rememberAudioPosition('a', 9);
    expect(readAudioPosition('a')).toBe(9);
  });
});

describe('forgetting', () => {
  it('removes only the named item', () => {
    rememberAudioPosition('a', 1);
    rememberAudioPosition('b', 2);
    forgetAudioPosition('a');
    expect(readAudioPosition('a')).toBeNull();
    expect(readAudioPosition('b')).toBe(2);
  });
});

describe('storage that fails', () => {
  it('does not throw when a write is refused, and reads as nothing', () => {
    vi.stubGlobal(
      'localStorage',
      Object.assign(memoryStorage(), {
        setItem: () => {
          throw new DOMException('full', 'QuotaExceededError');
        },
      }),
    );
    expect(() => {
      rememberAudioPosition('a', 1);
    }).not.toThrow();
    expect(readAudioPosition('a')).toBeNull();
  });

  it('does not throw when a read is refused', () => {
    vi.stubGlobal(
      'localStorage',
      Object.assign(memoryStorage(), {
        getItem: () => {
          throw new DOMException('blocked', 'SecurityError');
        },
      }),
    );
    expect(readAudioPosition('a')).toBeNull();
    expect(() => {
      forgetAudioPosition('a');
    }).not.toThrow();
  });
});
