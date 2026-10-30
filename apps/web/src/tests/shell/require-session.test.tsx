import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { WebConfigContext } from '@nix/web-foundation/lib/web-config';
import { stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../app';

/**
 * The session gate, and the promise that it never lies about where sign-in has got to.
 *
 * Four states, four different things on screen. The one worth protecting hardest is the difference
 * between "we are still checking" and "you are signed out": showing the login screen during a
 * session restoration flashes it in front of someone whose session is about to come back, which reads as
 * being signed out and prompts a pointless click.
 */
describe('the session gate', () => {
  it('shows the sign-in screen when nobody is signed in', () => {
    useSessionStore.setState({ status: 'anonymous', profile: null, error: null });

    renderAt(<App />);

    expect(screen.getByRole('heading', { level: 1, name: /sign in/i })).toBeVisible();
    expect(screen.getByRole('button', { name: /continue with sso/i })).toBeEnabled();
    expect(screen.queryByRole('textbox', { name: /organisation/i })).not.toBeInTheDocument();
  });

  it('shows the landing page at the root when the install turns it on', () => {
    useSessionStore.setState({ status: 'anonymous', profile: null, error: null });

    renderAt(
      <WebConfigContext value={{ landing: true, demo: true }}>
        <App />
      </WebConfigContext>,
    );

    expect(
      screen.getByRole('heading', { level: 1, name: /people and their AI agents work together/i }),
    ).toBeVisible();
    expect(screen.getAllByRole('link', { name: 'Open the live demo' })[0]).toBeVisible();
  });

  it('keeps sign-in on a deep link, and offers no demo when only the landing page is on', () => {
    useSessionStore.setState({ status: 'anonymous', profile: null, error: null });

    const { unmount } = renderAt(
      <WebConfigContext value={{ landing: true, demo: false }}>
        <App />
      </WebConfigContext>,
      '/w/00000000-0000-4000-8000-000000000001',
    );
    expect(screen.getByRole('heading', { level: 1, name: /sign in/i })).toBeVisible();
    unmount();

    renderAt(
      <WebConfigContext value={{ landing: true, demo: false }}>
        <App />
      </WebConfigContext>,
    );
    expect(
      screen.getByRole('heading', { level: 1, name: /people and their AI agents work together/i }),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Open the live demo' })).not.toBeInTheDocument();
  });

  it('says the app is offline, not signed out, when Core cannot be reached', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    useSessionStore.setState({
      status: 'unreachable',
      profile: null,
      error: null,
      unreachable: { cause: 'offline', lastTriedAt: Date.now() },
    });

    renderAt(<App />);

    expect(screen.getByRole('heading', { level: 1, name: /nix is offline/i })).toBeVisible();
    expect(screen.queryByRole('button', { name: /continue with sso/i })).not.toBeInTheDocument();
    screen.getByRole('button', { name: /try again/i }).click();
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/auth/session', expect.anything());
    });
    vi.unstubAllGlobals();
  });

  it('says the server is not answering, not that the device is offline, when it has a network', () => {
    useSessionStore.setState({
      status: 'unreachable',
      profile: null,
      error: null,
      unreachable: { cause: 'server', lastTriedAt: Date.now() },
    });

    renderAt(<App />);

    expect(screen.getByRole('heading', { name: /can.t reach its server/i })).toBeVisible();
    expect(screen.getByText(/connection is working/i)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(/last tried at/i);
  });

  it('keeps the unreachable screen up, saying it is trying, while a retry is in flight', () => {
    useSessionStore.setState({
      status: 'authenticating',
      profile: null,
      error: null,
      unreachable: { cause: 'server', lastTriedAt: Date.now() },
    });

    renderAt(<App />);

    expect(screen.getByRole('button', { name: 'Trying…' })).toBeDisabled();
    expect(screen.queryByText(/restoring session/i)).not.toBeInTheDocument();
  });

  it('says it is restoring rather than showing sign-in while a renew is in flight', () => {
    useSessionStore.setState({ status: 'authenticating', profile: null, error: null });

    renderAt(<App />);

    expect(screen.getByText(/restoring session/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /continue with sso/i })).not.toBeInTheDocument();
  });

  it('explains a server without interactive authentication rather than offering a broken sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            authenticated: false,
            configured: false,
            profile: null,
            accessToken: null,
            expiresAt: null,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    useSessionStore.setState({ status: 'unknown', profile: null, error: null });

    renderAt(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /not configured on this nix server/i,
    );
    expect(screen.getByRole('heading', { level: 1, name: /sign in/i })).toBeVisible();
  });

  it('surfaces why the last attempt failed instead of a bare sign-in screen', () => {
    useSessionStore.setState({
      status: 'failed',
      profile: null,
      error: 'Tokens from unregistered issuers are rejected.',
    });

    renderAt(<App />);

    expect(screen.getByRole('alert')).toHaveTextContent(/unregistered issuers/i);
  });

  it('explains an expired session rather than showing the plain sign-in screen a first-time visitor sees', () => {
    // `signedOut` reaches `anonymous`, the same status a deliberate sign-out lands in - the
    // reason carried in `error` is what keeps the two from looking identical.
    useSessionStore.setState({
      status: 'anonymous',
      profile: null,
      error: 'Your session expired. Sign in again to continue.',
    });

    renderAt(<App />);

    expect(screen.getByRole('alert')).toHaveTextContent(/session expired/i);
  });

  it('shows the plain sign-in screen for a deliberate sign-out, with no leftover reason', () => {
    useSessionStore.setState({ status: 'anonymous', profile: null, error: null });

    renderAt(<App />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: /sign in/i })).toBeVisible();
  });

  it('never renders a password field, because Nix stores no passwords', () => {
    useSessionStore.setState({ status: 'anonymous', profile: null, error: null });

    const { container } = renderAt(<App />);

    // A sign-in screen that looks like it might want a password teaches people to type one
    // somewhere. There is no field, and this is the test that keeps it that way.
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it('lets a signed-in person through to the application', async () => {
    useSessionStore.setState({
      status: 'authenticated',
      profile: { subject: 'sub-1', name: 'Ada Admin', email: 'ada@acme.test' },
      error: null,
    });

    stubCoreApi();
    renderAt(<App />);

    expect(screen.queryByRole('button', { name: /continue with sso/i })).not.toBeInTheDocument();
    expect(await screen.findByRole('banner')).toBeInTheDocument();
  });
});
