import { describe, expect, it, vi } from 'vitest';

import { NativeMirror } from '../../offline/native-mirror';

function setup(wipeResults: boolean[]) {
  const events: string[] = [];
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => {
      events.push('pointer removed');
    },
  };
  const post = vi.fn(() => Promise.resolve({}));
  const mirror = new NativeMirror({ origin: 'https://nix.example', post, storage });
  const fake = {
    wipe: vi.fn(() => {
      events.push(`wipe (readable: ${String(mirror.current() !== null)})`);
      return wipeResults.shift() === false ? Promise.reject(new Error('disk')) : Promise.resolve();
    }),
    close: vi.fn(() => Promise.resolve()),
  };
  (mirror as unknown as { store: unknown }).store = fake;
  return { mirror, events, post };
}

describe('wiping the offline copy', () => {
  it('closes admission and the account pointer before deleting anything', async () => {
    const { mirror, events } = setup([true]);
    expect(mirror.current()).not.toBeNull();
    const wiping = mirror.wipe();
    expect(mirror.current()).toBeNull();
    expect(await wiping).toBe(true);
    expect(events).toEqual(['pointer removed', 'wipe (readable: false)']);
    expect(mirror.current()).toBeNull();
  });

  it('keeps admission closed when the wipe fails, and retries', async () => {
    const { mirror } = setup([false, true]);
    expect(await mirror.wipe()).toBe(false);
    expect(mirror.current()).toBeNull();
    expect(await mirror.wipe()).toBe(true);
  });

  it('wipes natively even when nothing was opened in this page', async () => {
    const { mirror, post } = setup([true]);
    (mirror as unknown as { store: unknown }).store = null;
    expect(await mirror.wipe()).toBe(true);
    expect(post).toHaveBeenCalledWith({ op: 'wipe' });
  });
});
