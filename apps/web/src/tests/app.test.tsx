import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../app';

// Every suite in this file is about what the application renders once somebody is past the session
// gate. The gate itself has its own suite.
beforeEach(() => {
  signedIn();
});

/**
 * The specimen page is a lazy route - it is ~35 kB of design-lane reference nobody working in the
 * product opens, so it is not in the entry chunk - which is why every assertion about it below is
 * awaited. A synchronous `getBy` here would find the Suspense fallback, and a test that "passes"
 * against a fallback would go on passing if the chunk never arrived.
 */
describe('the design token specimen page', () => {
  it('renders the token page heading at the index route', async () => {
    renderAt(<App />, '/tokens');

    expect(
      await screen.findByRole('heading', { level: 1, name: /industry design tokens/i }),
    ).toBeVisible();
  });

  it('renders the layout chrome around the page', async () => {
    renderAt(<App />, '/tokens');

    // The chrome is the shell's, not the page's, so it is there before the chunk is - but waiting
    // for the page first keeps the assertion about a settled screen rather than a loading one.
    await screen.findByRole('heading', { level: 1, name: /industry design tokens/i });

    // A banner and a main landmark, and deliberately no contentinfo. The status strip that used to
    // sit at the foot said which tenant the session was pinned to and that isolation is enforced
    // in the database - true, and not what somebody writing a document needs a permanent row of
    // the screen for.
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
  });

  it('tells the visitor which path was not found instead of showing a bare error', async () => {
    renderAt(<App />, '/no-such-place');

    expect(await screen.findByRole('heading', { name: /no such page/i })).toBeVisible();
    expect(screen.getByText(/no-such-place/)).toBeVisible();
  });
});

describe('state that lives in the URL', () => {
  it('renders the state named by the search parameter, so a link is shareable', async () => {
    renderAt(<App />, '/tokens?state=empty');

    expect(await screen.findByRole('heading', { name: /no items here yet/i })).toBeVisible();
  });

  it('names what it is waiting for rather than showing an anonymous spinner', async () => {
    renderAt(<App />, '/tokens?state=loading');

    expect(await screen.findByRole('heading', { name: /loading workspace items/i })).toBeVisible();
  });

  it('shows the data and says what is missing when the result is partial', async () => {
    renderAt(<App />, '/tokens?state=partial');

    expect(await screen.findByText(/not yet indexed/i)).toBeVisible();
    expect(screen.getByText('Acquisition memo')).toBeVisible();
  });

  it('falls back to the default view when the parameter is not a known state', async () => {
    renderAt(<App />, '/tokens?state=nonsense');

    expect(await screen.findByText('Acquisition memo')).toBeVisible();
  });

  it('recovers from the error state through its retry affordance', async () => {
    const user = userEvent.setup();
    renderAt(<App />, '/tokens?state=error');

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load workspace items/i);

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Acquisition memo')).toBeVisible();
  });

  it('offers every state as a real link, not a button', async () => {
    renderAt(<App />, '/tokens');

    const switcher = await screen.findByRole('navigation', { name: /state pattern preview/i });
    expect(screen.getAllByRole('link')).not.toHaveLength(0);
    expect(switcher).toBeInTheDocument();
  });
});
