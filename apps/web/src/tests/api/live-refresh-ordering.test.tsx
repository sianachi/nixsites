import { createInMemoryTokenStore, createNixClient, items, type CacheKey } from '@nix/api-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '../../api/api-client-provider';
import { useWorkspaceTree, type WorkspaceTree } from '../../items/use-workspace-tree';
import { notifyItemChildrenChanged, onItemChildrenChanged } from '../../lib/item-children-changed';
import { WorkspaceProvider } from '../../workspaces/workspace-context';
import { item, STUB_WORKSPACE } from '../api-stub';
import { json } from '../json-response';

const FIRST = item({
  id: 'a4000000-0000-4000-8000-000000000001',
  title: 'First parent',
  hasChildren: true,
});
const SECOND = item({
  id: 'a4000000-0000-4000-8000-000000000002',
  title: 'Second parent',
  hasChildren: true,
});
const THIRD = item({
  id: 'a4000000-0000-4000-8000-000000000003',
  title: 'Third parent',
  hasChildren: true,
});
const CHILD = item({
  id: 'a4000000-0000-4000-8000-000000000004',
  title: 'Nested note',
  parentId: FIRST.id,
});
const CREATED = item({
  id: 'a4000000-0000-4000-8000-000000000005',
  title: 'Created note',
  parentId: FIRST.id,
});
const treeKey: CacheKey = ['workspaces', STUB_WORKSPACE.id, 'items'];
const collectionPath = '/api/v1/workspaces/' + STUB_WORKSPACE.id + '/items';

function page(rows: readonly ReturnType<typeof item>[]): Response {
  return json({ items: rows, nextCursor: null });
}

function deferredResponse() {
  let finish: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  return {
    promise,
    resolve: (response: Response) => {
      if (finish === undefined) throw new Error('The response was not initialized.');
      finish(response);
    },
  };
}

interface RequestObservation {
  readonly method: string;
  readonly path: string;
  readonly parentId: string | null;
  readonly signal: AbortSignal | null | undefined;
}

function mountTree(
  answer: (request: RequestObservation) => Response | Promise<Response>,
  secondReader = false,
) {
  const client = createNixClient({
    baseUrl: window.location.origin,
    tokens: createInMemoryTokenStore({
      initialAccessToken: 'ordering-test-token',
      refresh: () => Promise.resolve(null),
    }),
  });
  const requests: RequestObservation[] = [];
  let second: WorkspaceTree | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const request = {
        method: input instanceof Request ? input.method : (init?.method ?? 'GET'),
        path: url.pathname,
        parentId: url.searchParams.get('parentId'),
        signal: input instanceof Request ? input.signal : init?.signal,
      };
      requests.push(request);
      return Promise.resolve(answer(request));
    }),
  );

  function OtherReader(): null {
    const tree = useWorkspaceTree();
    useEffect(() => {
      second = tree;
    }, [tree]);
    return null;
  }

  function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return (
      <MemoryRouter initialEntries={['/w/' + STUB_WORKSPACE.id]}>
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
                  {secondReader ? <OtherReader /> : null}
                </WorkspaceProvider>
              }
            />
          </Routes>
        </ApiClientOverrideProvider>
      </MemoryRouter>
    );
  }

  return {
    client,
    requests,
    second: () => {
      if (second === undefined) throw new Error('The second tree has not mounted.');
      return second;
    },
    ...renderHook(() => useWorkspaceTree(), { wrapper: Wrapper }),
  };
}

describe('live refresh ordering and cancellation', () => {
  it('coalesces a shared API write and explicit notification once with two mounted trees', async () => {
    let rows = [FIRST, CHILD];
    const io = mountTree((request) => {
      if (request.path !== collectionPath) throw new Error('Unexpected item request.');
      if (request.method === 'POST') {
        rows = [...rows, CREATED];
        return json(CREATED);
      }
      return page(rows.filter((row) => row.parentId === request.parentId));
    }, true);
    await waitFor(() => {
      expect(io.result.current.status).toBe('ready');
      expect(io.second().status).toBe('ready');
    });
    await act(async () => {
      await Promise.all([io.result.current.expand(FIRST.id), io.second().expand(FIRST.id)]);
    });
    const changed = vi.fn();
    const stop = onItemChildrenChanged(changed);
    const before = io.requests.filter(
      (request) => request.method === 'GET' && request.parentId === null,
    ).length;
    try {
      await act(async () => {
        await io.client.execute(
          items.createItem(STUB_WORKSPACE.id, {
            title: CREATED.title,
            type: 'note',
            parentId: FIRST.id,
          }),
        );
        notifyItemChildrenChanged(STUB_WORKSPACE.id, FIRST.id);
      });
      await waitFor(() => {
        expect(io.result.current.childrenOf(FIRST.id).map((row) => row.id)).toEqual([
          CHILD.id,
          CREATED.id,
        ]);
        expect(
          io
            .second()
            .childrenOf(FIRST.id)
            .map((row) => row.id),
        ).toEqual([CHILD.id, CREATED.id]);
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
      });
      expect(changed).toHaveBeenCalledTimes(1);
      expect(
        io.requests.filter((request) => request.method === 'GET' && request.parentId === null)
          .length - before,
      ).toBe(2);
      expect(io.result.current.isExpanded(FIRST.id)).toBe(true);
      expect(io.second().isExpanded(FIRST.id)).toBe(true);
    } finally {
      stop();
    }
  });

  it('keeps children of an expanded parent moved beneath another expanded parent regardless of response order', async () => {
    const moved = { ...FIRST, parentId: SECOND.id };
    let moving = false;
    const destination = deferredResponse();
    const io = mountTree((request) => {
      if (request.path !== collectionPath) throw new Error('Unexpected item request.');
      if (moving && request.parentId === SECOND.id) return destination.promise;
      const rows = moving ? [SECOND, moved, CHILD] : [FIRST, SECOND, CHILD];
      return page(rows.filter((row) => row.parentId === request.parentId));
    });
    await waitFor(() => {
      expect(io.result.current.status).toBe('ready');
    });
    await act(async () => {
      await Promise.all([io.result.current.expand(FIRST.id), io.result.current.expand(SECOND.id)]);
    });
    moving = true;
    act(() => {
      io.client.invalidate(treeKey);
    });
    await waitFor(() => {
      expect(io.requests.filter((request) => request.parentId === SECOND.id)).toHaveLength(2);
    });
    await act(async () => {
      destination.resolve(page([moved]));
      await destination.promise;
    });
    await waitFor(() => {
      expect(io.result.current.find(FIRST.id)?.parentId).toBe(SECOND.id);
      expect(io.result.current.childrenOf(FIRST.id).map((row) => row.id)).toEqual([CHILD.id]);
    });
    expect(io.result.current.childrenOf(null).map((row) => row.id)).toEqual([SECOND.id]);
    expect(io.result.current.isExpanded(FIRST.id)).toBe(true);
    expect(io.result.current.isExpanded(SECOND.id)).toBe(true);
  });

  it.each(['old item', 'late refusal'])(
    'ignores a superseded reveal that returns %s after the fresh catalog',
    async (outcome) => {
      const older = deferredResponse();
      let fresh = false;
      const io = mountTree((request) => {
        if (request.path === '/api/v1/items/' + CHILD.id) return older.promise;
        if (request.path === collectionPath)
          return page([{ ...FIRST, title: fresh ? 'Fresh parent' : FIRST.title }]);
        if (request.path === '/api/v1/items/' + FIRST.id) return json(FIRST);
        throw new Error('Unexpected reveal request.');
      });
      await waitFor(() => {
        expect(io.result.current.status).toBe('ready');
      });
      let revealing: Promise<void> = Promise.resolve();
      act(() => {
        revealing = io.result.current.reveal(CHILD.id);
      });
      await waitFor(() => {
        expect(io.result.current.revealOf(CHILD.id)).toBe('revealing');
      });
      fresh = true;
      act(() => {
        io.client.invalidate(treeKey);
      });
      await waitFor(() => {
        expect(io.result.current.find(FIRST.id)?.title).toBe('Fresh parent');
      });
      await act(async () => {
        older.resolve(
          outcome === 'old item'
            ? json(CHILD)
            : json(
                {
                  title: 'Refused',
                  status: 404,
                  code: 'items.not_found',
                  detail: 'The old item is gone.',
                },
                404,
              ),
        );
        await revealing;
      });
      expect(io.result.current.find(CHILD.id)).toBeNull();
      expect(io.result.current.revealOf(CHILD.id)).toBeNull();
      expect(io.result.current.find(FIRST.id)?.title).toBe('Fresh parent');
      expect(io.result.current.error).toBeNull();
    },
  );

  it('ignores an old locked expansion after an unlocked refresh succeeds', async () => {
    const older = deferredResponse();
    let branchReads = 0;
    const io = mountTree((request) => {
      if (request.path !== collectionPath) throw new Error('Unexpected expansion request.');
      if (request.parentId === FIRST.id) {
        branchReads += 1;
        if (branchReads === 1) return older.promise;
        return page([CHILD]);
      }
      return page([FIRST]);
    });
    await waitFor(() => {
      expect(io.result.current.status).toBe('ready');
    });
    let expanding: Promise<void> = Promise.resolve();
    act(() => {
      expanding = io.result.current.expand(FIRST.id);
    });
    await waitFor(() => {
      expect(branchReads).toBe(1);
    });
    act(() => {
      io.client.invalidate(treeKey);
    });
    await waitFor(() => {
      expect(io.result.current.childrenOf(FIRST.id).map((row) => row.id)).toEqual([CHILD.id]);
    });
    await act(async () => {
      older.resolve(
        json({ title: 'Locked', status: 423, code: 'items.locked', detail: 'Locked.' }, 423),
      );
      await expanding;
    });
    expect(io.result.current.isLocked(FIRST.id)).toBe(false);
    expect(io.result.current.isExpanded(FIRST.id)).toBe(true);
    expect(io.result.current.isLoadingChildren(FIRST.id)).toBe(false);
    expect(io.result.current.childrenOf(FIRST.id).map((row) => row.id)).toEqual([CHILD.id]);
    expect(io.result.current.error).toBeNull();
  });

  it('aborts remaining branch reads after a terminal refresh failure and can refresh again', async () => {
    const root = deferredResponse();
    const branches: RequestObservation[] = [];
    let failing = false;
    const io = mountTree((request) => {
      if (request.path !== collectionPath) throw new Error('Unexpected branch request.');
      if (failing) {
        if (request.parentId === null) return root.promise;
        branches.push(request);
        return new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      }
      return page(request.parentId === null ? [FIRST, SECOND, THIRD] : []);
    });
    await waitFor(() => {
      expect(io.result.current.status).toBe('ready');
    });
    await act(async () => {
      await Promise.all(
        [FIRST, SECOND, THIRD].map((parent) => io.result.current.expand(parent.id)),
      );
    });
    failing = true;
    act(() => {
      io.client.invalidate(treeKey);
    });
    await waitFor(() => {
      expect(branches).toHaveLength(3);
    });
    await act(async () => {
      root.resolve(
        json(
          {
            title: 'Unavailable',
            status: 503,
            code: 'core.unavailable',
            detail: 'Refresh failed.',
          },
          503,
        ),
      );
      await root.promise;
    });
    await waitFor(() => {
      expect(branches.every((request) => request.signal?.aborted === true)).toBe(true);
      expect(io.result.current.error).toBe('Refresh failed.');
    });
    failing = false;
    const before = io.requests.length;
    act(() => {
      io.client.invalidate(treeKey);
    });
    await waitFor(() => {
      expect(io.requests.length - before).toBe(4);
      expect(io.result.current.error).toBeNull();
    });
    expect(io.result.current.childrenOf(null).map((row) => row.id)).toEqual([
      FIRST.id,
      SECOND.id,
      THIRD.id,
    ]);
  });
});
