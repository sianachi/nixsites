import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readOpenDailyOnLaunch,
  writeOpenDailyOnLaunch,
} from '../../lib/daily-note-device-preferences';

const KEY = 'nix.daily.open-on-launch';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('open daily note on launch preference', () => {
  it('reads off by default', () => {
    expect(readOpenDailyOnLaunch()).toBe(false);
  });

  it('stores "1" when turned on', () => {
    writeOpenDailyOnLaunch(true);

    expect(readOpenDailyOnLaunch()).toBe(true);
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('removes the key when turned off', () => {
    writeOpenDailyOnLaunch(true);
    writeOpenDailyOnLaunch(false);

    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readOpenDailyOnLaunch()).toBe(false);
  });

  it('reads off when storage throws', () => {
    localStorage.setItem(KEY, '1');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(readOpenDailyOnLaunch()).toBe(false);
  });
});
