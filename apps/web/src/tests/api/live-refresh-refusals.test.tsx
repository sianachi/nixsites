import { createNixClient } from '@nix/api-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { useWorkspaceTree } from '../../items/use-workspace-tree';
import { WorkspaceProvider } from '../../workspaces/workspace-context';
import { item, STUB_WORKSPACE } from '../api-stub';

const parent = item({
  id: 'e1000000-0000-4000-8000-000000000001',
  workspaceId: STUB_WORKSPACE.id,
  title: 'Previously readable parent',
  hasChildren: true,
});
const child = item({
  id: 'e1000000-0000-4000-8000-000000000002',
  workspaceId: STUB_WORKSPACE.id,
  parentId: parent.id,
  title: 'Previously readable child',
});

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

function response(status: number, detail = 'The read was refused.', code?: string) {
  return new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'Read unavailable',
      status,
      detail,
      code: code ?? 'read.unavailable',
    }),
    {
      status,
      headers: { 'Content-Type': 'application/problem+json' },
    },
  );
}

function page(parentId: string | null) {
  return new Response(
    JSON.stringify({ items: parentId === null ? [parent] : [child], nextCursor: null }),
  );
}

function requestParent(input: RequestInfo | URL) {
  const url = input instanceof Request ? input.url : String(input);
  return new URL(url).searchParams.get('parentId');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tree readers after invalidation', () => {
  it.each([403, 404])(
    'removes previously loaded titles and expansion after a root %s',
    async (status) => {
      let refused = false;
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          const parentId = requestParent(input);
          return Promise.resolve(refused && parentId === null ? response(status) : page(parentId));
        }),
      );
      const { client, result } = setup();
      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });
      await act(() => result.current.expand(parent.id));
      expect(result.current.find(child.id)?.title).toBe(child.title);
      expect(result.current.isExpanded(parent.id)).toBe(true);

      refused = true;
      act(() => {
        client.invalidate(['workspaces', STUB_WORKSPACE.id, 'items']);
      });

      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });
      expect(result.current.items).toEqual([]);
      expect(result.current.find(parent.id)).toBeNull();
      expect(result.current.find(child.id)).toBeNull();
      expect(result.current.isExpanded(parent.id)).toBe(false);
    },
  );

  it.each([
    { status: 403, code: undefined },
    { status: 404, code: undefined },
    { status: 423, code: 'items.locked' },
  ])('removes loaded descendants after a branch $status', async ({ status, code }) => {
    let refused = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const parentId = requestParent(input);
        return Promise.resolve(
          refused && parentId === parent.id
            ? response(status, 'Branch unavailable.', code)
            : page(parentId),
        );
      }),
    );
    const { client, result } = setup();
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    await act(() => result.current.expand(parent.id));
    expect(result.current.find(child.id)?.title).toBe(child.title);

    refused = true;
    act(() => {
      client.invalidate(['workspaces', STUB_WORKSPACE.id, 'items']);
    });

    await waitFor(() => {
      expect(result.current.find(child.id)).toBeNull();
    });
    expect(result.current.find(parent.id)?.title).toBe(parent.title);
    expect(result.current.isLocked(parent.id)).toBe(code === 'items.locked');
  });

  it('keeps loaded titles and expansion when a root refresh temporarily fails', async () => {
    let refused = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const parentId = requestParent(input);
        return Promise.resolve(
          refused && parentId === null ? response(500, 'Temporary failure.') : page(parentId),
        );
      }),
    );
    const { client, result } = setup();
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    await act(() => result.current.expand(parent.id));
    refused = true;
    act(() => {
      client.invalidate(['workspaces', STUB_WORKSPACE.id, 'items']);
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Temporary failure.');
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.find(parent.id)?.title).toBe(parent.title);
    expect(result.current.find(child.id)?.title).toBe(child.title);
    expect(result.current.isExpanded(parent.id)).toBe(true);
  });

  it.each([
    { status: 403, code: 'items.forbidden' },
    { status: 404, code: 'items.not_found' },
    { status: 423, code: 'items.locked' },
  ])(
    'clears confirmed branch $status before a concurrent refresh fails',
    async ({ status, code }) => {
      let refreshing = false;
      let failRoot: (() => void) | undefined;
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          const parentId = requestParent(input);
          if (!refreshing) return Promise.resolve(page(parentId));
          if (parentId === parent.id)
            return Promise.resolve(response(status, 'Branch unavailable.', code));
          return new Promise<Response>((resolve) => {
            failRoot = () => {
              resolve(response(500, 'Temporary root failure.'));
            };
          });
        }),
      );
      const { client, result } = setup();
      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });
      await act(() => result.current.expand(parent.id));
      expect(result.current.find(child.id)?.title).toBe(child.title);
      refreshing = true;
      act(() => {
        client.invalidate(['workspaces', STUB_WORKSPACE.id, 'items']);
      });

      await waitFor(() => {
        expect(result.current.find(child.id)).toBeNull();
      });
      expect(failRoot).toBeTypeOf('function');
      act(() => {
        failRoot?.();
      });
      await waitFor(() => {
        expect(result.current.error).toBe('Temporary root failure.');
      });
      expect(result.current.find(child.id)).toBeNull();
      expect(result.current.find(parent.id)?.title).toBe(parent.title);
      expect(result.current.isLocked(parent.id)).toBe(code === 'items.locked');
    },
  );
});
