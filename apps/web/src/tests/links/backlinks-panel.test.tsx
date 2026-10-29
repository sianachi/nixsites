import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useLocation } from 'react-router';

import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { AuthProvider } from '@nix/web-platform/auth/auth-provider';
import { BacklinksPane } from '../../links/backlinks-panel';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

/**
 * What the backlinks pane says, in each of the states it can be in.
 *
 * All four are here because all four are different sentences, and getting one wrong is worse than
 * showing nothing: somebody told their document is unreferenced stops looking for the document
 * that references it, and somebody shown a stale list follows a link to a document that no longer
 * mentions them.
 */

beforeEach(() => {
  signedIn();
});

const TARGET = item({ id: '11111111-1111-4111-8111-111111111111', title: 'Quarterly ledger' });
const SOURCE = item({ id: '22222222-2222-4222-8222-222222222222', title: 'Ledger review' });

/** Reports the address, so navigation can be asserted the way a person experiences it. */
function Address(): ReactNode {
  const location = useLocation();
  return <span data-testid="address">{`${location.pathname}${location.search}`}</span>;
}

function renderPane(itemId: string | null): void {
  renderAt(
    <AuthProvider>
      <ApiClientProvider>
        <BacklinksPane itemId={itemId} />
        <Address />
      </ApiClientProvider>
    </AuthProvider>,
  );
}

describe('the backlinks pane', () => {
  it('lists the documents that point at this one', async () => {
    stubCoreApi({ items: [TARGET, SOURCE], backlinks: { [TARGET.id]: [SOURCE.id] } });
    renderPane(TARGET.id);

    expect(await screen.findByRole('button', { name: /Ledger review/ })).toBeVisible();
  });

  it('opens a referring document when it is chosen', async () => {
    // A backlink that lists a document and cannot take you to it is a citation, not a link.
    const user = userEvent.setup();
    stubCoreApi({ items: [TARGET, SOURCE], backlinks: { [TARGET.id]: [SOURCE.id] } });
    renderPane(TARGET.id);

    await user.click(await screen.findByRole('button', { name: /Ledger review/ }));

    await waitFor(() => {
      expect(screen.getByTestId('address')).toHaveTextContent(SOURCE.id);
    });
  });

  it('says nothing links here yet, and says how to make one', async () => {
    stubCoreApi({ items: [TARGET], backlinks: {} });
    renderPane(TARGET.id);

    await waitFor(() => {
      expect(screen.getByText(/Nothing links here yet/)).toBeVisible();
    });
  });

  it('reports a failed read as a failure, not as an item nothing points at', async () => {
    // The distinction the whole component is shaped around. "Nothing links here" after a 500 is a
    // false statement about somebody's workspace.
    stubCoreApi({ items: [TARGET], backlinksFail: true });
    renderPane(TARGET.id);

    expect(await screen.findByText(/could not be loaded/i)).toBeVisible();
    expect(screen.queryByText(/Nothing links here yet/)).not.toBeInTheDocument();
  });

  it('offers a way to try again after a failure', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [TARGET], backlinksFail: true });
    renderPane(TARGET.id);

    await user.click(await screen.findByRole('button', { name: /try again/i }));

    // Still failing, because the stub still refuses - what is asserted is that asking again is
    // possible at all, which a dead end would not be.
    expect(await screen.findByText(/could not be loaded/i)).toBeVisible();
  });

  it('says the list can lag the document it came from', async () => {
    // Backlinks are extracted when a document is snapshotted, so a link written moments ago in
    // another tab may genuinely not be here yet. Hiding that makes the panel look broken rather
    // than behind.
    stubCoreApi({ items: [TARGET, SOURCE], backlinks: { [TARGET.id]: [SOURCE.id] } });
    renderPane(TARGET.id);

    expect(await screen.findByText(/once the document holding them has been saved/i)).toBeVisible();
  });

  it('asks for nothing when no item is open', () => {
    stubCoreApi({ items: [] });
    renderPane(null);

    expect(screen.getByText(/Open an item to see what links to it/)).toBeVisible();
  });
});
