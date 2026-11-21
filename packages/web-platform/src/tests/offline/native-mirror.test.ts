import { describe, expect, it, vi } from 'vitest';

import { NativeMirror } from '../../offline/native-mirror';

function setup(wipeResults: boolean[]) {
  const events: string[] = [];
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: (key: string) => {
      if (key === 'nix.offline.account') events.push('pointer removed');
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

describe('a session that ended without a sign-out', () => {
  function ended(unsent: number, withStorage = true) {
    const kept = new Map<string, string>();
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    };
    const mirror = new NativeMirror({
      origin: 'https://nix.example',
      post: vi.fn(() => Promise.resolve({})),
      storage: withStorage ? storage : null,
    });
    const account = { tenantId: 't', principalId: 'p' };
    const store = {
      wipe: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
      countUnsent: vi.fn(() => Promise.resolve(unsent)),
    };
    Object.assign(mirror as unknown as Record<string, unknown>, { store, account });
    kept.set('nix.offline.account', JSON.stringify({ origin: 'https://nix.example', ...account }));
    return { mirror, store, account, kept };
  }

  it('wipes a copy with nothing unsent', async () => {
    const { mirror, store } = ended(0);
    expect(await mirror.expire()).toBe('wiped');
    expect(store.wipe).toHaveBeenCalledTimes(1);
  });

  it('keeps unsent changes, closed to every read and to an offline launch', async () => {
    const { mirror, store } = ended(2);
    const expiring = mirror.expire();
    expect(mirror.current()).toBeNull();
    expect(await expiring).toBe('kept');
    expect(store.wipe).not.toHaveBeenCalled();
    expect(mirror.current()).toBeNull();
    expect(await mirror.fileGet('i', 'v')).toBeNull();
    expect(await mirror.openStored()).toBeNull();
    expect(await mirror.session()).toBeNull();
  });

  it('gives the copy back when the same account signs in again', async () => {
    const { mirror, store, account, kept } = ended(2);
    await mirror.expire();
    expect(await mirror.open(account)).toBe(store);
    expect(mirror.current()).toBe(store);
    expect(kept.has('nix.offline.locked')).toBe(false);
    expect(store.wipe).not.toHaveBeenCalled();
  });

  it('a sign-out wipes a locked copy', async () => {
    const { mirror, store, kept } = ended(2);
    await mirror.expire();
    expect(await mirror.wipe()).toBe(true);
    expect(store.wipe).toHaveBeenCalledTimes(1);
    expect(kept.size).toBe(0);
  });

  it('wipes when the lock could not outlive the page', async () => {
    const { mirror, store } = ended(2, false);
    expect(await mirror.expire()).toBe('wiped');
    expect(store.wipe).toHaveBeenCalledTimes(1);
  });

  it('wipes when the unsent changes cannot be counted', async () => {
    const { mirror, store } = ended(2);
    store.countUnsent.mockRejectedValue(new Error('disk'));
    expect(await mirror.expire()).toBe('wiped');
  });
});

describe('file downloads around a sign-out', () => {
  const account = { tenantId: 't', principalId: 'p' };
  function downloading() {
    const { mirror, post } = setup([true]);
    (mirror as unknown as { account: unknown }).account = account;
    let finish: () => void = () => undefined;
    post.mockImplementation(((request: { op: string }) =>
      request.op === 'fileDownload'
        ? new Promise((resolve) => {
            finish = () => {
              resolve({ bytes: 3, sha256: 'h' });
            };
          })
        : Promise.resolve({})) as never);
    return {
      mirror,
      post,
      finish: () => {
        finish();
      },
    };
  }

  it('keeps a download that finished while admitted', async () => {
    const { mirror, finish } = downloading();
    const result = mirror.fileDownload('i', 'v', 'https://f.example/x');
    finish();
    expect(await result).toEqual({ bytes: 3, sha256: 'h' });
  });

  it('deletes a file that landed after the wipe began', async () => {
    const { mirror, post, finish } = downloading();
    const result = mirror.fileDownload('i', 'v', 'https://f.example/x');
    void mirror.wipe();
    finish();
    expect(await result).toBeNull();
    expect(post).toHaveBeenCalledWith({ op: 'fileDelete', key: 'i:v' });
  });

  it('does not start a download once admission is closed', async () => {
    const { mirror, post } = downloading();
    void mirror.wipe();
    expect(await mirror.fileDownload('i', 'v', 'https://f.example/x')).toBeNull();
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ op: 'fileDownload' }));
  });
});
