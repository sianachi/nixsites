import { afterEach, describe, expect, it, vi } from 'vitest';

import { onNotice } from '@nix/web-foundation/lib/notices';
import { registerServiceWorker } from '../../pwa/register-service-worker';

let unregister = (): void => undefined;

afterEach(() => {
  unregister();
  unregister = () => undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the installed app lifecycle', () => {
  it('registers the same-origin worker after the page has loaded', async () => {
    const register = vi.fn(() =>
      Promise.resolve({
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        update: vi.fn(() => Promise.resolve()),
      }),
    );
    vi.stubGlobal('navigator', { serviceWorker: { register } });

    unregister = registerServiceWorker();
    globalThis.dispatchEvent(new Event('load'));

    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledWith('/service-worker.js');
    });
  });

  it('looks for a newer build when a lazily loaded chunk is missing', async () => {
    const update = vi.fn(() => Promise.resolve());
    const register = vi.fn(() =>
      Promise.resolve({ addEventListener: vi.fn(), removeEventListener: vi.fn(), update }),
    );
    vi.stubGlobal('navigator', { serviceWorker: { register } });

    unregister = registerServiceWorker();
    globalThis.dispatchEvent(new Event('load'));
    await vi.waitFor(() => {
      expect(register).toHaveBeenCalled();
    });
    await Promise.resolve();
    const notices: { message: string; action?: { label: string } }[] = [];
    const stop = onNotice((notice) => notices.push(notice));
    window.dispatchEvent(new Event('vite:preloadError'));
    stop();

    expect(update).toHaveBeenCalledOnce();
    expect(notices).toEqual([
      expect.objectContaining({
        message: 'Nix has been updated. Reload to open this.',
        action: expect.objectContaining({ label: 'Reload' }) as unknown,
      }),
    ]);
  });

  it('does nothing when the browser has no service-worker support', () => {
    vi.stubGlobal('navigator', {});

    expect(() => {
      unregister = registerServiceWorker();
      globalThis.dispatchEvent(new Event('load'));
    }).not.toThrow();
  });

  it('leaves the web app usable and reports a refused registration', async () => {
    const refusal = new Error('blocked by policy');
    const register = vi.fn(() => Promise.reject(refusal));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('navigator', { serviceWorker: { register } });

    unregister = registerServiceWorker();
    globalThis.dispatchEvent(new Event('load'));

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('The Nix app installer could not be registered.', refusal);
    });
  });
});
