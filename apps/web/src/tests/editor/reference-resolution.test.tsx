import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientProvider } from '../../api/api-client-provider';
import { AuthProvider } from '../../auth/auth-provider';
import { ReferenceResolutionProvider, useReference } from '../../editor/reference-resolution';

/**
 * What a reference resolves to, and - the part that matters - what it refuses to resolve to.
 *
 * A reference node stores the target's title as it was when the link was made, so the document can
 * draw something before the server answers. That cache is a title, and a reader who cannot open
 * the target has no entitlement to it. These tests are about the states that decide whether it is
 * shown, so they are written from the refused side first.
 */

const READABLE = '11111111-1111-4111-8111-111111111111';
const REFUSED = '22222222-2222-4222-8222-222222222222';

/** Reports one reference's state as text, so a test can read it the way a component would. */
function Probe({ targetId }: { readonly targetId: string }): ReactNode {
  const state = useReference(targetId);

  return (
    <span data-testid={targetId}>
      {state.status === 'resolved' ? `resolved:${state.title ?? ''}` : state.status}
    </span>
  );
}

/**
 * The provider under test, with the auth context it reads a bearer token from.
 *
 * The real `AuthProvider` rather than a stand-in: it is what supplies `getAccessToken`, and with
 * no identity provider configured it answers null - which is exactly the shape the request builder
 * has to handle and the one a fake would have hidden.
 */
function renderProbes(children: ReactNode): void {
  render(
    <AuthProvider>
      <ApiClientProvider>
        <ReferenceResolutionProvider>{children}</ReferenceResolutionProvider>
      </ApiClientProvider>
    </AuthProvider>,
  );
}

/**
 * A reference lookup answering exactly as Core does.
 *
 * Returns the recorded request urls, so the batching can be asserted rather than assumed.
 */
function stubReferences(
  answer: (ids: readonly string[]) => unknown,
  status = 200,
): { readonly calls: string[] } {
  const calls: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      // A real fetch refuses an already-aborted signal before anything reaches the wire. A stub
      // that ignored the signal would hide exactly the class of bug the StrictMode test below
      // exists to catch - which is how it shipped.
      if (init?.signal?.aborted === true) {
        return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
      }

      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/auth/session')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              authenticated: true,
              configured: true,
              profile: { subject: 'reference-reader', name: 'Reference reader' },
              accessToken: 'reference-token',
              expiresAt: '2999-01-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (url.endsWith('/auth/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              accessToken: 'reference-token',
              expiresAt: '2999-01-01T00:00:00Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }

      calls.push(url);

      const ids = (/ids=([^&]*)/.exec(url)?.[1] ?? '')
        .split(',')
        .filter((id) => id.length > 0)
        .map((id) => decodeURIComponent(id));

      return Promise.resolve(
        new Response(JSON.stringify(answer(ids)), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );

  return { calls };
}

/** Core's answer shape: every requested identifier comes back, only some of them with an item. */
function coreAnswer(ids: readonly string[]): unknown {
  return {
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
  };
}

describe('resolving what a document points at', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a readable target with the title it has now', async () => {
    stubReferences(coreAnswer);
    renderProbes(<Probe targetId={READABLE} />);

    await waitFor(() => {
      expect(screen.getByTestId(READABLE)).toHaveTextContent('resolved:Quarterly ledger');
    });
  });

  it('reports a target the reader may not see as refused, and carries no title at all', async () => {
    // The one that matters. `refused` is what tells the node view to draw a stub instead of the
    // label stored in the document, which is a copy of a title this reader is not entitled to.
    stubReferences(coreAnswer);
    renderProbes(<Probe targetId={REFUSED} />);

    await waitFor(() => {
      expect(screen.getByTestId(REFUSED)).toHaveTextContent('refused');
    });
  });

  it('reports a failed lookup as unavailable rather than as refused', async () => {
    // A network failure is a fact about the network. Drawing it as a refusal would tell a reader
    // something about their own permissions that nobody established - and would replace a title
    // they are perfectly entitled to with a stub.
    stubReferences(() => ({ detail: 'nope' }), 500);
    renderProbes(<Probe targetId={READABLE} />);

    await waitFor(() => {
      expect(screen.getByTestId(READABLE)).toHaveTextContent('unavailable');
    });
  });

  it('shows the loading state until an answer arrives', () => {
    stubReferences(coreAnswer);
    renderProbes(<Probe targetId={READABLE} />);

    // Before the request settles. The stored label is what a node view draws in this state, which
    // is the one thing the label is for.
    expect(screen.getByTestId(READABLE)).toHaveTextContent('loading');
  });

  it('asks about every reference on screen in one request', async () => {
    // A note is a page of links, not one. Forty references asking separately would open forty
    // connections and queue most of them behind each other.
    const { calls } = stubReferences(coreAnswer);

    renderProbes(
      <>
        <Probe targetId={READABLE} />
        <Probe targetId={REFUSED} />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId(READABLE)).toHaveTextContent('resolved:Quarterly ledger');
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(READABLE);
    expect(calls[0]).toContain(REFUSED);
  });

  it('asks once for a target mentioned twice', async () => {
    const { calls } = stubReferences(coreAnswer);

    renderProbes(
      <>
        <Probe targetId={READABLE} />
        <Probe targetId={READABLE} />
      </>,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId(READABLE)[0]).toHaveTextContent('resolved:Quarterly ledger');
    });

    expect(calls).toHaveLength(1);
  });

  it('resolves every reference on a document that holds more than one batch', async () => {
    // The server refuses more than 200 identifiers at once, so a document that links widely - a
    // map-of-content page, the most predictable shape in a wiki-links product - arrives in several
    // batches. Dropping the tail left those references on `loading` forever, and `loading` draws
    // the stored label: a cached title that was never checked against this reader's permissions.
    const { calls } = stubReferences(coreAnswer);
    const many = Array.from(
      { length: 250 },
      (_unused, index) => `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    );

    renderProbes(
      <>
        {many.map((id) => (
          <Probe key={id} targetId={id} />
        ))}
      </>,
    );

    const last = many.at(-1) ?? '';
    await waitFor(() => {
      expect(screen.getByTestId(last)).not.toHaveTextContent('loading');
    });

    // Two requests, not one dropped tail.
    expect(calls.length).toBeGreaterThan(1);
    for (const id of many) {
      expect(screen.getByTestId(id)).toHaveTextContent('refused');
    }
  });

  it('still resolves after StrictMode has probed the provider with an extra mount cycle', async () => {
    // The app mounts under StrictMode, whose development-only probe unmounts and remounts every
    // component once. The provider held one AbortController for the life of the component
    // instance, the probe's unmount aborted it, and a controller aborted once is aborted forever:
    // every flush after the remount was cancelled before it reached the wire and returned through
    // the cancellation branch. No request, no warning - and every reference in every document
    // stayed on `loading`, which draws the stored label and nothing clickable. This is the test
    // that fails without a controller per mount; the suite's default render has no probe, which
    // is how the bug shipped past every other test here.
    const { calls } = stubReferences(coreAnswer);

    render(
      <StrictMode>
        <AuthProvider>
          <ApiClientProvider>
            <ReferenceResolutionProvider>
              <Probe targetId={READABLE} />
            </ReferenceResolutionProvider>
          </ApiClientProvider>
        </AuthProvider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByTestId(READABLE)).toHaveTextContent('resolved:Quarterly ledger');
    });

    expect(calls.length).toBeGreaterThan(0);
  });

  it('leaves a reference unresolved outside a provider rather than failing the document', async () => {
    // An editor mounted in a test or a story has no resolver. A document that refused to render
    // because its links could not be checked is a worse failure than links showing their labels.
    render(
      <AuthProvider>
        <Probe targetId={READABLE} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId(READABLE)).toHaveTextContent('loading');
    });
  });
});
