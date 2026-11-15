import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createSecurityClient, type SecurityClient } from '@nix/web-platform/auth/security-client';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { AuthOverrideProvider } from '@nix/web-platform/auth/auth-provider';
import { PeopleSection } from '../../settings/people/people-section';
import { passwordFault, SecuritySection } from '../../settings/security/security-section';

const auth = {
  signIn: vi.fn(),
  signOut: vi.fn(() => Promise.resolve()),
  getAccessToken: () => Promise.resolve('jwt'),
  handleSessionRefusal: vi.fn(),
  isConfigured: true,
  accountUrl: null,
  mode: 'local' as const,
  setupRequired: false,
};

function wrap(node: React.ReactNode) {
  return render(<AuthOverrideProvider value={auth}>{node}</AuthOverrideProvider>);
}

describe('passwordFault', () => {
  it('enforces length and confirmation', () => {
    expect(passwordFault('short', 'short')).toMatch(/at least 10/u);
    expect(passwordFault('x'.repeat(257), 'x'.repeat(257))).toMatch(/at most 256/u);
    expect(passwordFault('long enough pw', 'different one')).toMatch(/differ/u);
    expect(passwordFault('long enough pw', 'long enough pw')).toBeNull();
  });
});

describe('createSecurityClient', () => {
  it('sends the current password with a reset link and keeps the refusal code', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ detail: 'Sign in again.', code: 'security.recent_sign_in_required' }),
          {
            status: 403,
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createSecurityClient(() => Promise.resolve('jwt'));
    await expect(client.resetLink('p1', 'pw')).rejects.toMatchObject({
      status: 403,
      code: 'security.recent_sign_in_required',
    });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/v1/tenant/people/p1/reset-link');
    expect(init.body).toBe(JSON.stringify({ currentPassword: 'pw' }));
    vi.unstubAllGlobals();
  });

  it('sends the bearer token and surfaces the refusal sentence', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ detail: 'Wrong password.' }), { status: 401 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createSecurityClient(() => Promise.resolve('jwt'));
    await expect(client.removePassword('nope')).rejects.toThrow('Wrong password.');
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/v1/me/security/password');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt');
    vi.unstubAllGlobals();
  });
});

function fakeClient(overrides: Partial<SecurityClient>): SecurityClient {
  return overrides as SecurityClient;
}

describe('SecuritySection', () => {
  it('offers Remove password only with a passkey and sends the current password', async () => {
    const removePassword = vi.fn(() => Promise.resolve(null));
    const getSecurity = vi.fn(() =>
      Promise.resolve({
        hasPassword: true,
        totpEnabled: false,
        passkeyRpId: 'example.test',
        passkeys: [
          {
            id: 'k1',
            name: 'Laptop',
            kind: 'passkey' as const,
            createdAt: '2026-11-01T00:00:00Z',
            lastUsedAt: null,
          },
        ],
      }),
    );
    wrap(<SecuritySection client={fakeClient({ getSecurity, removePassword })} />);
    const remove = await screen.findByRole('button', { name: 'Remove password' });
    expect(remove).toBeDisabled();
    const [current] = screen.getAllByLabelText(/current password/iu);
    if (!current) throw new Error('no current password field');
    await userEvent.type(current, 'hunter2hunter2');
    await userEvent.click(remove);
    await waitFor(() => {
      expect(removePassword).toHaveBeenCalledWith('hunter2hunter2');
    });
  });

  it('hides Remove password without a passkey', async () => {
    const getSecurity = () =>
      Promise.resolve({ hasPassword: true, totpEnabled: false, passkeyRpId: 'x', passkeys: [] });
    wrap(<SecuritySection client={fakeClient({ getSecurity })} />);
    await screen.findByRole('button', { name: 'Change password' });
    expect(screen.queryByRole('button', { name: 'Remove password' })).toBeNull();
  });
});

describe('PeopleSection', () => {
  it('adds a person and shows the one-time link', async () => {
    const person = {
      id: 'p1',
      email: 'a@example.test',
      name: 'Ada',
      status: 'active',
      isAdmin: false,
      hasPassword: false,
      passkeyCount: 0,
      totpEnabled: false,
      createdAt: '2026-11-01T00:00:00Z',
    };
    const addPerson = vi.fn(() =>
      Promise.resolve({
        person,
        link: { url: 'https://nix.test/account-link/abc', expiresAt: '2026-11-15T12:00:00Z' },
      }),
    );
    wrap(
      <PeopleSection
        client={fakeClient({
          listPeople: () => Promise.resolve({ people: [] }),
          getSecurity: () =>
            Promise.resolve({
              hasPassword: true,
              totpEnabled: false,
              passkeyRpId: null,
              passkeys: [],
            }),
          addPerson,
        })}
      />,
    );
    await userEvent.type(await screen.findByLabelText(/email/iu), 'a@example.test');
    await userEvent.type(screen.getByLabelText(/^name/iu), 'Ada');
    await userEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText('https://nix.test/account-link/abc')).toBeTruthy();
    expect(addPerson).toHaveBeenCalledWith('a@example.test', 'Ada');
  });
});

describe('PeopleSection reset link', () => {
  const row = (id: string, name: string) => ({
    id,
    email: `${name}@example.test`,
    name,
    status: 'active',
    isAdmin: false,
    hasPassword: true,
    passkeyCount: 0,
    totpEnabled: false,
    createdAt: '2026-11-01T00:00:00Z',
  });

  it('hides Reset link on your own row and asks for your password on others', async () => {
    useSessionStore.setState({ profile: { subject: 'me', name: 'Me', email: null } });
    const resetLink = vi.fn(() =>
      Promise.resolve({
        url: 'https://nix.test/account-link/zzz',
        expiresAt: '2026-11-15T12:00:00Z',
      }),
    );
    wrap(
      <PeopleSection
        client={fakeClient({
          listPeople: () => Promise.resolve({ people: [row('me', 'Me'), row('p2', 'Bob')] }),
          getSecurity: () =>
            Promise.resolve({
              hasPassword: true,
              totpEnabled: false,
              passkeyRpId: null,
              passkeys: [],
            }),
          resetLink,
        })}
      />,
    );
    await screen.findByText('Bob');
    expect(screen.queryByRole('button', { name: 'Reset link for Me' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Reset link for Bob' }));
    const issue = screen.getByRole('button', { name: 'Issue link' });
    expect(issue).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/your current password/iu), 'hunter2hunter2');
    await userEvent.click(issue);
    expect(await screen.findByText('https://nix.test/account-link/zzz')).toBeTruthy();
    expect(resetLink).toHaveBeenCalledWith('p2', 'hunter2hunter2');
    useSessionStore.setState({ profile: null });
  });
});
