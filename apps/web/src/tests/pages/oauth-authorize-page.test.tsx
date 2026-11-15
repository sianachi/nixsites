import { NixApiError } from '@nix/api-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OAuthAuthorizePage } from '../../pages/oauth-authorize-page';

const { execute, client } = vi.hoisted(() => {
  const run = vi.fn();
  return { execute: run, client: { execute: run } };
});
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => client }));

const assign = vi.fn();
const QUERY =
  '/oauth/authorize?response_type=code&client_id=c1&redirect_uri=https%3A%2F%2Fapp.test%2Fcb&code_challenge=abc&code_challenge_method=S256&state=xyz';

function mount(): void {
  render(
    <MemoryRouter initialEntries={[QUERY]}>
      <OAuthAuthorizePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('location', { assign });
});
afterEach(() => {
  vi.unstubAllGlobals();
  execute.mockReset();
  assign.mockReset();
});

describe('OAuth authorize page', () => {
  it('shows an error and follows nothing when the preview fails', async () => {
    execute.mockRejectedValue(new Error('bad client'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid/i);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it('refuses a response_type other than code without asking Core', async () => {
    render(
      <MemoryRouter initialEntries={[QUERY.replace('response_type=code', 'response_type=token')]}>
        <OAuthAuthorizePage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('posts the chosen scopes on approve and follows the address Core returns', async () => {
    execute
      .mockResolvedValueOnce({ clientName: 'ChatGPT', redirectHost: 'app.test' })
      .mockResolvedValueOnce({ redirectTo: 'https://app.test/cb?code=1&state=xyz' });
    mount();
    expect(await screen.findByText(/ChatGPT.*will be able to act in Nix as you/)).toBeVisible();
    await userEvent.click(screen.getByRole('checkbox', { name: /read/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://app.test/cb?code=1&state=xyz');
    });
    const sent = execute.mock.calls[1]?.[0] as { body: Record<string, unknown>; path: string };
    expect(sent.path).toBe('/api/v1/oauth/consent');
    expect(sent.body).toMatchObject({
      clientId: 'c1',
      redirectUri: 'https://app.test/cb',
      codeChallenge: 'abc',
      codeChallengeMethod: 'S256',
      state: 'xyz',
      decision: 'approve',
      token: { scopes: ['read'] },
    });
  });

  it("shows Core's refusal when the person is at the token cap", async () => {
    execute
      .mockResolvedValueOnce({ clientName: 'ChatGPT', redirectHost: 'app.test' })
      .mockRejectedValueOnce(
        new NixApiError({
          kind: 'problem',
          code: 'tokens.limit_reached',
          message: 'Request refused',
          detail: 'Revoke one you no longer use in Settings > Access tokens, then try again.',
        }),
      );
    mount();
    await userEvent.click(await screen.findByRole('checkbox', { name: /read/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings > Access tokens');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('asks for a scope before approving, and deny needs none', async () => {
    execute
      .mockResolvedValueOnce({ clientName: 'ChatGPT', redirectHost: 'app.test' })
      .mockResolvedValueOnce({ redirectTo: 'https://app.test/cb?error=access_denied&state=xyz' });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(screen.getByText('Choose at least one scope.')).toBeVisible();
    expect(execute).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://app.test/cb?error=access_denied&state=xyz');
    });
    expect((execute.mock.calls[1]?.[0] as { body: object }).body).toMatchObject({
      decision: 'deny',
    });
  });
});
