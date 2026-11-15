import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountLinkPage } from '../../pages/local-auth/account-link-page';
import { LocalSetupPage } from '../../pages/local-auth/local-setup-page';
import { LocalSignInPage } from '../../pages/local-auth/local-sign-in-page';

const auth = vi.hoisted(() => ({ value: { mode: 'local', setupRequired: false } }));
vi.mock('@nix/web-platform/auth/auth-provider', () => ({ useAuth: () => auth.value }));

const assign = vi.fn();
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status });

function mount(path: string, element: React.ReactElement, route = path.split('?')[0] ?? '/') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
        <Route path="*" element={<p>elsewhere</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.value = { mode: 'local', setupRequired: false };
  vi.stubGlobal('location', {
    assign,
    hostname: 'nix.test',
    origin: 'https://nix.test',
    href: 'https://nix.test/',
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  assign.mockReset();
});

describe('sign-in page', () => {
  it('signs in and carries returnTo and native', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json(200, { status: 'signed_in', redirectTo: '/w/1' }));
    mount('/sign-in?returnTo=%2Fw%2F1&native=abc123', <LocalSignInPage />, '/sign-in');
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co');
    await userEvent.type(screen.getByLabelText(/password/i), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/w/1');
    });
    const sent = fetchMock.mock.calls[0]?.[1]?.body;
    const body: unknown = JSON.parse(typeof sent === 'string' ? sent : '');
    expect(body).toEqual({
      email: 'a@b.co',
      password: 'correct horse battery',
      returnTo: '/w/1',
      native: 'abc123',
    });
  });

  it('announces a wrong password without naming which part was wrong', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(401, { code: 'invalid_credentials' }));
    mount('/sign-in', <LocalSignInPage />);
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co');
    await userEvent.type(screen.getByLabelText(/password/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/did not match/);
  });

  it('says how long a paused account waits', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(429, { code: 'paused', retryAfterSeconds: 240 }),
    );
    mount('/sign-in', <LocalSignInPage />);
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co');
    await userEvent.type(screen.getByLabelText(/password/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/4 minutes/);
  });

  it('asks for the authenticator code after a second_step answer', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        json(200, { status: 'second_step', challengeId: 'c1', methods: ['totp'] }),
      )
      .mockResolvedValueOnce(json(200, { status: 'signed_in', redirectTo: '/' }));
    mount('/sign-in', <LocalSignInPage />);
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co');
    await userEvent.type(screen.getByLabelText(/password/i), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await userEvent.type(await screen.findByLabelText(/authenticator code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/');
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/auth/local/second-step/totp');
  });

  it('sends a first-run install to setup', () => {
    auth.value = { mode: 'local', setupRequired: true };
    mount('/sign-in', <LocalSignInPage />, '/sign-in');
    expect(screen.getByText('elsewhere')).toBeTruthy();
  });
});

describe('setup page', () => {
  it('refuses a short password before calling Core', async () => {
    auth.value = { mode: 'local', setupRequired: true };
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    mount('/setup', <LocalSetupPage />);
    await userEvent.type(screen.getByLabelText(/setup code/i), 'code');
    await userEvent.type(screen.getByLabelText(/your name/i), 'Ada');
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co');
    await userEvent.type(screen.getByLabelText(/^password/i), 'short');
    await userEvent.click(screen.getByRole('button', { name: /create admin/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/at least 10/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('account link page', () => {
  it('shows who the link is for and signs in after the password is set', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(200, { purpose: 'setup', email: 'a@b.co', name: 'Ada' }))
      .mockResolvedValueOnce(json(200, { status: 'signed_in', redirectTo: '/' }));
    mount('/account-link/tok', <AccountLinkPage />, '/account-link/:token');
    expect(await screen.findByText(/Ada \(a@b.co\)/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/new password/i), 'a long enough pass');
    await userEvent.click(screen.getByRole('button', { name: /set password/i }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/');
    });
  });

  it('treats any refusal as an invalid link', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(404, {}));
    mount('/account-link/tok', <AccountLinkPage />, '/account-link/:token');
    expect((await screen.findByRole('alert')).textContent).toMatch(/invalid/);
  });
});
