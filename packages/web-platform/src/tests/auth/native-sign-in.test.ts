import { afterEach, describe, expect, it, vi } from 'vitest';

import { canSignInNatively, nativeSignIn } from '../../auth/native-sign-in';

const setShell = (nativePromise?: (...args: unknown[]) => Promise<unknown>): void => {
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    nativePromise,
  };
};

afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  vi.unstubAllGlobals();
});

describe('native sign-in', () => {
  it('is off in a browser and on in the shell', () => {
    expect(canSignInNatively()).toBe(false);
    setShell(vi.fn());
    expect(canSignInNatively()).toBe(true);
  });

  it('passes the origin and path to the shell, then redeems the code', async () => {
    const nativePromise = vi.fn().mockResolvedValue({ code: 'c', verifier: 'v' });
    setShell(nativePromise);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(nativeSignIn('/a?b=1')).resolves.toBe('signed-in');

    expect(nativePromise).toHaveBeenCalledWith('NixShell', 'signIn', {
      origin: globalThis.location.origin,
      returnTo: '/a?b=1',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/auth/native/redeem');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
    expect(init.body).toBe(JSON.stringify({ code: 'c', verifier: 'v' }));
  });

  it('stays quiet when the person cancels', async () => {
    setShell(vi.fn().mockRejectedValue({ code: 'cancelled', message: 'x' }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(nativeSignIn('/')).resolves.toBe('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails when the shell errors, answers badly, or the redeem is refused', async () => {
    setShell(vi.fn().mockRejectedValue(new Error('boom')));
    await expect(nativeSignIn('/')).rejects.toThrow('boom');

    setShell(vi.fn().mockResolvedValue({ code: 'c' }));
    await expect(nativeSignIn('/')).rejects.toThrow();

    setShell(vi.fn().mockResolvedValue({ code: 'c', verifier: 'v' }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 400 })));
    await expect(nativeSignIn('/')).rejects.toThrow('Try again');
  });
});
