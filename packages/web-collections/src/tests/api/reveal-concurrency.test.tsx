import { createNixClient } from '@nix/api-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { useWorkspaceTree } from '../../items/use-workspace-tree';
import { WorkspaceProvider } from '@nix/web-workspaces/workspaces/workspace-context';
import { item, STUB_WORKSPACE } from '@nix/web-foundation/testing/api-stub';

function setup() {
  const client = createNixClient({
    baseUrl: 'http://localhost',
    tokens: {
      getAccessToken: () => Promise.resolve('token'),
      refreshAccessToken: () => Promise.resolve('token'),
    },
  });
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[`/w/${STUB_WORKSPACE.id}`]}>
        <ApiClientOverrideProvider client={client}>
          <Routes>
            <Route
              path="/w/:workspaceId"
              element={
                <WorkspaceProvider
                  state={{
                    status: 'ready',
                    workspaces: [STUB_WORKSPACE],
                    error: null,
                    reload: () => undefined,
                    workspaceCreated: () => undefined,
                    workspaceUpdated: () => undefined,
                    workspaceRemoved: () => undefined,
                  }}
                >
                  {children}
                </WorkspaceProvider>
              }
            />
          </Routes>
        </ApiClientOverrideProvider>
      </MemoryRouter>
    );
  }
  return { client, ...renderHook(() => useWorkspaceTree(), { wrapper: Wrapper }) };
}

const CHAIN = Array.from({ length: 7 }, (_, index) =>
  item({
    id: `e2000000-0000-4000-8000-00000000000${index}`,
    workspaceId: STUB_WORKSPACE.id,
    parentId: index === 0 ? null : `e2000000-0000-4000-8000-00000000000${index - 1}`,
    title: `Level ${index}`,
    hasChildren: index < 6,
  }),
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reveal of a deep item', () => {
  it('reads the ancestors levels with at most four requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    let siblingReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const parentId = url.searchParams.get('parentId');
        const byId = CHAIN.find((entry) => url.pathname.endsWith(`/items/${entry.id}`));
        if (byId) return new Response(JSON.stringify(byId));
        if (parentId !== null) siblingReads += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        const children = CHAIN.filter((entry) => entry.parentId === parentId);
        return new Response(JSON.stringify({ items: children, nextCursor: null }));
      }),
    );
    const { result } = setup();
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    peak = 0;
    const target = CHAIN[6]!;
    await act(() => result.current.reveal(target.id));

    expect(result.current.revealOf(target.id)).toBe('found');
    expect(siblingReads).toBe(6);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    for (const entry of CHAIN.slice(0, 6)) expect(result.current.isExpanded(entry.id)).toBe(true);
    expect(result.current.find(target.id)?.title).toBe('Level 6');
  });
});
