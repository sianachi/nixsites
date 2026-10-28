import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { AuthProvider } from '@nix/web-platform/auth/auth-provider';
import { ReferenceResolutionProvider } from '@nix/web-editor/editor/reference-resolution';
import { ReferenceView } from '@nix/web-editor/editor/reference-view';
import { renderAt, signedIn } from '../render-with-router';
import { requestUrl } from '../request-url';

/**
 * How a reference is drawn once the server has been asked about it, and what it does when clicked.
 *
 * The four states are the point, and the refused one is a rule rather than a preference: the label
 * stored in the document is a copy of a title as it stood when the link was made, and a reader who
 * cannot open the target must not be shown it as though it were current.
 */

beforeEach(() => {
  signedIn();
});

const READABLE = '11111111-1111-4111-8111-111111111111';
const REFUSED = '22222222-2222-4222-8222-222222222222';

/** Reports the address, so navigation can be asserted the way a person experiences it. */
function Address(): ReactNode {
  const location = useLocation();
  return <span data-testid="address">{`${location.pathname}${location.search}`}</span>;
}

/**
 * The node view with the shape TipTap hands it.
 *
 * Cast because `ReactNodeViewProps` describes a whole ProseMirror node view and this component
 * reads exactly one thing off it. Building a real one would mean standing up an editor to assert
 * on a span.
 */
function renderReference(attrs: Record<string, unknown>): void {
  const props = { node: { attrs } } as unknown as Parameters<typeof ReferenceView>[0];

  renderAt(
    <AuthProvider>
      <ApiClientProvider>
        <ReferenceResolutionProvider>
          <ReferenceView {...props} />
          <Address />
        </ReferenceResolutionProvider>
      </ApiClientProvider>
    </AuthProvider>,
  );
}

function stubReferences(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      const ids = (/ids=([^&]*)/.exec(url)?.[1] ?? '')
        .split(',')
        .filter((id) => id.length > 0)
        .map((id) => decodeURIComponent(id));

      return Promise.resolve(
        new Response(
          JSON.stringify({
            references: ids.map((id) =>
              id === READABLE
                ? {
                    id,
                    readable: true,
                    item: {
                      id,
                      workspaceId: '00000000-0000-4000-8000-000000000001',
                      type: 'note',
                      title: 'Quarterly ledger',
                      parentId: null,
                      updatedAt: '2026-09-01T12:00:00Z',
                    },
                  }
                : { id, readable: false, item: null },
            ),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }),
  );
}

describe('a reference in a document', () => {
  it('opens the item it points at when it is clicked', async () => {
    // This is the one that was broken. The button lives inside a `contenteditable`, where
    // ProseMirror handles the press first and the click never arrives - so a resolved reference
    // looked like a link and did nothing.
    stubReferences();
    const user = userEvent.setup();
    renderReference({ kind: 'item', targetId: READABLE, label: 'What it was called' });

    await user.click(await screen.findByRole('button', { name: 'Quarterly ledger' }));

    await waitFor(() => {
      expect(screen.getByTestId('address')).toHaveTextContent(READABLE);
    });
  });

  it('shows the title the target has now, not the one stored when the link was made', async () => {
    stubReferences();
    renderReference({ kind: 'item', targetId: READABLE, label: 'Its old name' });

    expect(await screen.findByRole('button', { name: 'Quarterly ledger' })).toBeVisible();
    expect(screen.queryByText('Its old name')).not.toBeInTheDocument();
  });

  it('renders a stub for a target the reader may not see, and never the stored label', async () => {
    stubReferences();
    renderReference({ kind: 'item', targetId: REFUSED, label: 'Acquisition terms' });

    expect(await screen.findByText(/Unavailable/)).toBeVisible();

    // The rule. The label is a title as of when the link was made, and this reader has no
    // entitlement to it - so it must not appear, and it must not be a control either.
    expect(screen.queryByText('Acquisition terms')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says why a stub is a stub without naming a reason the server refused to give', async () => {
    stubReferences();
    renderReference({ kind: 'item', targetId: REFUSED, label: 'Acquisition terms' });

    // Deleted, never existed and not shared with you are one answer from the server. Picking the
    // most alarming of the three and stating it as fact told somebody who deleted their own
    // document that they lacked access to their own item.
    const stub = await screen.findByText(/Unavailable/);
    expect(stub).toHaveTextContent(/deleted/i);
    expect(stub).toHaveTextContent(/not be shared with you/i);
  });

  it('shows the stored label while the answer is still coming, which is what it is for', () => {
    stubReferences();
    renderReference({ kind: 'item', targetId: READABLE, label: 'What it was called' });

    expect(screen.getByText('What it was called')).toBeVisible();
  });

  it('does not resolve a mention of a person, so nobody is drawn as forbidden', async () => {
    // The item endpoint would answer "refused" for a principal identifier, which would render
    // every colleague's name as something the reader is not allowed to see.
    stubReferences();
    renderReference({ kind: 'principal', targetId: REFUSED, label: 'Dana' });

    expect(screen.getByText('Dana')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByText(/Unavailable/)).not.toBeInTheDocument();
    });
  });
});
