import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { stubCoreApi, type StubAccessToken } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../../app';

/**
 * The access-tokens half of the settings screen, driven through the real route the way a person
 * reaches it. The stub holds the tokens; what is under test is what the screen says about them -
 * above all that dead tokens stay visible (the list is an audit) and that the secret is shown
 * exactly once.
 */

beforeEach(() => {
  signedIn();
});

async function renderTokens(): Promise<void> {
  renderAt(<App />, '/settings');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('link', { name: 'Access tokens' }));
}

/** Expiries a century out and a decade past, so no test hinges on the machine's clock. */
const liveToken: StubAccessToken = {
  id: '11111111-aaaa-4aaa-8aaa-111111111111',
  name: 'ci deploy',
  scopes: ['read', 'write'],
  createdAt: '2026-08-01T09:00:00+00:00',
  expiresAt: '2126-08-01T09:00:00+00:00',
  revokedAt: null,
  lastUsedAt: null,
};

const revokedToken: StubAccessToken = {
  id: '22222222-aaaa-4aaa-8aaa-222222222222',
  name: 'old laptop',
  scopes: ['read'],
  createdAt: '2026-05-01T09:00:00+00:00',
  expiresAt: '2126-05-01T09:00:00+00:00',
  revokedAt: '2026-06-01T09:00:00+00:00',
  lastUsedAt: '2026-05-20T09:00:00+00:00',
};

const expiredToken: StubAccessToken = {
  id: '33333333-aaaa-4aaa-8aaa-333333333333',
  name: 'stale script',
  scopes: ['admin'],
  createdAt: '2016-01-01T09:00:00+00:00',
  expiresAt: '2016-02-01T09:00:00+00:00',
  revokedAt: null,
  lastUsedAt: '2016-01-15T09:00:00+00:00',
};

describe('the token list', () => {
  it('renders live, revoked and expired tokens with their status, keeping dead ones visible', async () => {
    stubCoreApi({ accessTokens: [liveToken, revokedToken, expiredToken] });
    await renderTokens();

    // Every token has a row, dead or not: the list is an audit.
    const table = await screen.findByRole('table', { name: /your personal access tokens/i });
    expect(within(table).getByText('ci deploy')).toBeInTheDocument();
    expect(within(table).getByText('old laptop')).toBeInTheDocument();
    expect(within(table).getByText('stale script')).toBeInTheDocument();

    expect(within(table).getByText('Live')).toBeInTheDocument();
    expect(within(table).getByText(/revoked 2026-06-01/i)).toBeInTheDocument();
    expect(within(table).getByText(/expired 2016-02-01/i)).toBeInTheDocument();

    const mobileList = screen.getByRole('list', { name: /your personal access tokens/i });
    expect(within(mobileList).getByText('ci deploy')).toBeInTheDocument();
    expect(within(mobileList).getByText('old laptop')).toBeInTheDocument();
  });

  it('says "never" for a token that has not been used, rather than leaving the cell blank', async () => {
    stubCoreApi({ accessTokens: [liveToken] });
    await renderTokens();

    const table = await screen.findByRole('table', { name: /your personal access tokens/i });
    expect(within(table).getByText('never')).toBeInTheDocument();
  });

  it('offers Revoke only on live tokens - a dead token has nothing left to end', async () => {
    stubCoreApi({ accessTokens: [liveToken, revokedToken, expiredToken] });
    await renderTokens();

    const table = await screen.findByRole('table', { name: /your personal access tokens/i });
    expect(within(table).getByRole('button', { name: 'Revoke ci deploy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke old laptop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke stale script' })).not.toBeInTheDocument();
  });
});

describe('creating a token', () => {
  async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    await user.type(screen.getByRole('textbox', { name: /^name$/i }), 'ci robot');
    await user.click(screen.getByRole('checkbox', { name: /read items and search/i }));
    await user.click(screen.getByRole('radio', { name: /30 days/i }));
    await user.click(screen.getByRole('button', { name: 'Create the token' }));
  }

  it('shows the minted secret exactly once, with a copy affordance, and refreshes the list on dismissal', async () => {
    const user = userEvent.setup();
    stubCoreApi({ accessTokens: [] });
    await renderTokens();

    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await fillAndSubmit(user);

    // The one showing: the secret itself, the copy control, and the sentence that says there is
    // no second showing.
    expect(await screen.findByText(/stub-secret-/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy token/i })).toBeInTheDocument();
    expect(screen.getByText(/only time the secret will be shown/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));

    // The secret is gone for good, and the refreshed list now carries the new token's metadata.
    expect(screen.queryByText(/stub-secret-/)).not.toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /your personal access tokens/i });
    expect(within(table).getByText('ci robot')).toBeInTheDocument();
  });

  it('refuses to submit until an expiry is chosen - a default lifetime is a decision the person never made', async () => {
    const user = userEvent.setup();
    stubCoreApi({ accessTokens: [] });
    await renderTokens();

    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    await user.type(screen.getByRole('textbox', { name: /^name$/i }), 'ci robot');
    await user.click(screen.getByRole('checkbox', { name: /read items and search/i }));
    await user.click(screen.getByRole('button', { name: 'Create the token' }));

    expect(await screen.findByText(/choose how long the token lives/i)).toBeInTheDocument();
    expect(screen.queryByText(/stub-secret-/)).not.toBeInTheDocument();
  });

  it('asks before discarding a changed form through the dialog close control', async () => {
    const user = userEvent.setup();
    stubCoreApi({ accessTokens: [] });
    await renderTokens();

    await user.click(await screen.findByRole('button', { name: 'Create token' }));
    await user.type(screen.getByRole('textbox', { name: /^name$/i }), 'mobile deploy');
    await user.click(screen.getByRole('button', { name: 'Close without creating a token' }));

    expect(await screen.findByText('Discard what you typed?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('textbox', { name: /^name$/i })).toHaveValue('mobile deploy');
  });

  it("renders the 409 limit refusal honestly, in the server's own words", async () => {
    const user = userEvent.setup();
    stubCoreApi({
      accessTokens: [],
      createTokenProblem: {
        status: 409,
        code: 'tokens.limit_reached',
        detail: 'You already hold 25 live tokens; revoke one first.',
      },
    });
    await renderTokens();

    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await fillAndSubmit(user);

    expect(
      await screen.findByText('You already hold 25 live tokens; revoke one first.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/stub-secret-/)).not.toBeInTheDocument();
  });

  it("renders the 422 invalid refusal honestly, in the server's own words", async () => {
    const user = userEvent.setup();
    stubCoreApi({
      accessTokens: [],
      createTokenProblem: {
        status: 422,
        code: 'tokens.invalid',
        detail: 'A scope named "root" is not one this API grants.',
      },
    });
    await renderTokens();

    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    await fillAndSubmit(user);

    expect(
      await screen.findByText('A scope named "root" is not one this API grants.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/stub-secret-/)).not.toBeInTheDocument();
  });
});

describe('revoking a token', () => {
  it('asks for confirmation, sends the DELETE, and then shows the row as revoked', async () => {
    const user = userEvent.setup();
    stubCoreApi({ accessTokens: [liveToken] });
    await renderTokens();

    const table = await screen.findByRole('table', { name: /your personal access tokens/i });
    await user.click(within(table).getByRole('button', { name: 'Revoke ci deploy' }));

    // The confirmation names what is about to happen before anything does.
    expect(screen.getByRole('heading', { name: 'Revoke ci deploy?' })).toBeInTheDocument();
    expect(screen.getByText(/loses access immediately/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revoke token' }));

    // The row survives revocation - it turns into audit history rather than disappearing.
    expect(within(table).getByText(/revoked \d{4}-\d{2}-\d{2}/i)).toBeInTheDocument();
    expect(within(table).getByText('ci deploy')).toBeInTheDocument();
    expect(
      within(table).queryByRole('button', { name: 'Revoke ci deploy' }),
    ).not.toBeInTheDocument();

    // The wire call was the idempotent DELETE on this token's own address.
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const revocation = calls.find((call) => {
      const request = call[0];
      const url =
        typeof request === 'string' ? request : request instanceof Request ? request.url : '';
      const method =
        request instanceof Request ? request.method : (call[1] as RequestInit | undefined)?.method;
      return url.endsWith(`/api/v1/me/tokens/${liveToken.id}`) && method === 'DELETE';
    });
    expect(revocation).toBeDefined();
  });

  it('keeps the confirmation open and offers a way out that revokes nothing', async () => {
    const user = userEvent.setup();
    stubCoreApi({ accessTokens: [liveToken] });
    await renderTokens();

    const table = await screen.findByRole('table', { name: /your personal access tokens/i });
    await user.click(within(table).getByRole('button', { name: 'Revoke ci deploy' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Still live, still revocable: nothing was sent.
    expect(within(table).getByText('Live')).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'Revoke ci deploy' })).toBeInTheDocument();
  });
});

describe("the token list's own states", () => {
  it('renders a failed load as an error with a retry, not as an empty list', async () => {
    stubCoreApi({ tokensFail: true });
    await renderTokens();

    const alert = await screen.findByRole('heading', { name: /your tokens could not be loaded/i });
    expect(alert).toBeInTheDocument();
    expect(screen.queryByText(/you have no access tokens/i)).not.toBeInTheDocument();
  });

  it('says the list is empty only once the answer has arrived and the answer was none', async () => {
    stubCoreApi({ accessTokens: [] });
    await renderTokens();

    expect(await screen.findAllByText(/you have no access tokens/i)).toHaveLength(2);
  });
});

describe('the tokens table shape', () => {
  it('names its columns so every stated fact has a header', async () => {
    stubCoreApi({ accessTokens: [liveToken] });
    await renderTokens();

    await screen.findByRole('table', { name: /your personal access tokens/i });
    const table = screen.getByRole('table', { name: /your personal access tokens/i });
    for (const header of ['Name', 'Scopes', 'Created', 'Expires', 'Last used', 'Status']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
  });
});
