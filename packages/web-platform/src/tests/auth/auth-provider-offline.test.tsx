import * as bodies from '@nix/web-foundation/lib/body-cache';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../../auth/auth-provider';
import { setNativeMirror, type NativeMirror } from '../../offline/native-mirror';
import { getOfflineState, setOfflineState } from '../../offline/offline-state';

// The iOS shell: the offline paths of the provider only exist there.
vi.mock('../../pwa/install-nix', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  inNativeShell: true,
}));

const MARKER = 'nix.logout-pending';
const stored = { profile: { subject: 'person-1', name: 'Stored Person', email: null } };

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
const signedIn = (): Response =>
  json({
    authenticated: true,
    configured: true,
    profile: { subject: 'person-1', name: 'Stored Person' },
    accessToken: 'token',
    expiresAt: '2099-01-01T00:00:00+00:00',
  });

function fakeMirror(session: typeof stored | null) {
  const wipe = vi.fn(() => Promise.resolve(true));
  const mirror = {
    wipe,
    current: () => ({}),
    openStored: () => Promise.resolve(session === null ? null : {}),
    session: () => Promise.resolve(session),
  };
  setNativeMirror(mirror as unknown as NativeMirror);
  return wipe;
}

function Harness() {
  const status = useSessionStore((state) => state.status);
  const auth = useAuth();
  return (
    <div>
      <output>{status}</output>
      <button type="button" onClick={() => void auth.signOut()}>
        Sign out
      </button>
    </div>
  );
}
const mount = () =>
  render(
    <AuthProvider>
      <Harness />
    </AuthProvider>,
  );
const urls = (fetch: ReturnType<typeof vi.fn>): string[] =>
  fetch.mock.calls.map((call) => String(call[0]));

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({ status: 'unknown', profile: null, error: null });
  setOfflineState({ bootOffline: false, networkDown: false });
  vi.spyOn(bodies, 'sealAccountBodies').mockResolvedValue(undefined);
  vi.spyOn(bodies, 'openBodyCache').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  setNativeMirror(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the shell without a network', () => {
  it('opens signed in on the synced copy when Core cannot be reached and a profile is stored', async () => {
    fakeMirror(stored);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
    mount();
    await screen.findByText('authenticated');
    expect(getOfflineState().bootOffline).toBe(true);
    expect(useSessionStore.getState().profile?.subject).toBe('person-1');
  });

  it('shows the unreachable screen state when there is no stored profile', async () => {
    fakeMirror(null);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
    mount();
    await screen.findByText('unreachable');
    expect(getOfflineState().bootOffline).toBe(false);
  });

  it('never opens the copy on a 401, which closes the session instead', async () => {
    fakeMirror(stored);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
    mount();
    await screen.findByText('failed');
    expect(getOfflineState().bootOffline).toBe(false);
    expect(useSessionStore.getState().profile).toBeNull();
  });
});

describe('signing out in the shell', () => {
  it('wipes the synced copy', async () => {
    const wipe = fakeMirror(stored);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(signedIn())
        .mockResolvedValue(new Response(null, { status: 204 })),
    );
    mount();
    await screen.findByText('authenticated');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('anonymous');
    expect(wipe).toHaveBeenCalled();
    expect(localStorage.getItem(MARKER)).toBeNull();
  });

  it('offline: wipes, signs out locally, and leaves a marker for the server logout', async () => {
    const wipe = fakeMirror(stored);
    const fetch = vi.fn((input: unknown) =>
      String(input) === '/auth/session'
        ? Promise.resolve(signedIn())
        : Promise.reject(new TypeError('Load failed')),
    );
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByText('authenticated');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByText('anonymous');
    expect(wipe).toHaveBeenCalled();
    expect(localStorage.getItem(MARKER)).toBe('1');
  });

  it('logs out on the server before believing any session at the next launch', async () => {
    fakeMirror(null);
    localStorage.setItem(MARKER, '1');
    const fetch = vi.fn((input: unknown) =>
      Promise.resolve(
        String(input) === '/auth/logout'
          ? new Response(null, { status: 204 })
          : json({
              authenticated: false,
              configured: true,
              profile: null,
              accessToken: null,
              expiresAt: null,
            }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByText('anonymous');
    expect(urls(fetch)).toEqual(['/auth/logout', '/auth/session']);
    expect(localStorage.getItem(MARKER)).toBeNull();
  });

  it('does not ask for a session at all while the owed logout cannot reach the server', async () => {
    fakeMirror(null);
    localStorage.setItem(MARKER, '1');
    const fetch = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    vi.stubGlobal('fetch', fetch);
    mount();
    await screen.findByText('unreachable');
    expect(urls(fetch)).toEqual(['/auth/logout']);
    expect(localStorage.getItem(MARKER)).toBe('1');
  });

  it('finishes an owed logout before sending the person to sign in again', async () => {
    fakeMirror(null);
    localStorage.setItem(MARKER, '1');
    const order: string[] = [];
    const assign = vi.fn(() => order.push('login'));
    vi.stubGlobal('location', {
      assign,
      origin: window.location.origin,
      pathname: '/',
      search: '',
      hash: '',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        order.push(String(input));
        return Promise.resolve(
          String(input) === '/auth/logout'
            ? new Response(null, { status: 204 })
            : json({
                authenticated: false,
                configured: true,
                profile: null,
                accessToken: null,
                expiresAt: null,
              }),
        );
      }),
    );
    function SignIn() {
      const auth = useAuth();
      return <button onClick={() => void auth.signIn()}>Sign in</button>;
    }
    render(
      <AuthProvider>
        <SignIn />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(order).toEqual(['/auth/logout', '/auth/session']);
    });
    order.length = 0;
    localStorage.setItem(MARKER, '1');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(order).toEqual(['/auth/logout', 'login']);
    });
  });
});
