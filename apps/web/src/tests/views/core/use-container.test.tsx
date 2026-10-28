import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { useContainer } from '../../../views/core/use-container';
import { WorkspaceProvider } from '@nix/web-workspaces/workspaces/workspace-context';
import { item, STUB_WORKSPACE } from '../../api-stub';
import { notifyItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import { useQueryResults } from '../../../views/query/use-query-results';
import { useWorkspaceTree } from '../../../items/use-workspace-tree';
import { requestUrl } from '../../request-url';

const getAccessToken = (): Promise<string> => Promise.resolve('token');

vi.mock('@nix/web-platform/auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken }),
}));

function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <MemoryRouter initialEntries={[`/w/${STUB_WORKSPACE.id}`]}>
      <ApiClientProvider>
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
      </ApiClientProvider>
    </MemoryRouter>
  );
}

describe('container loading', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes('cursor=')) return new Promise<Response>(() => undefined);
      if (url.endsWith('/schema')) {
        return Promise.resolve(
          new Response(JSON.stringify({ properties: [], declared: [], inherit: true })),
        );
      }
      if (url.endsWith('/views')) {
        return Promise.resolve(
          new Response(JSON.stringify({ views: [], unrenderable: [], default: 'document' })),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              item({
                id: 'a1000000-0000-4000-8000-000000000010',
                workspaceId: '00000000-0000-4000-8000-000000000001',
                parentId: 'a1000000-0000-4000-8000-000000000020',
                title: 'First page',
              }),
            ],
            nextCursor: 'next-page',
          }),
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes shared view data after an external item change, scoped to the workspace', async () => {
    const parentId = 'a1000000-0000-4000-8000-000000000020';
    let title = 'Before pet update';
    let status = 'Todo';
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const payload = url.endsWith('/schema')
        ? { properties: [], declared: [], inherit: true }
        : url.endsWith('/views')
          ? { views: [], unrenderable: [], default: 'document' }
          : {
              items: [
                item({
                  id: 'a1000000-0000-4000-8000-000000000010',
                  parentId,
                  title,
                  properties: { title, status },
                }),
              ],
              nextCursor: null,
            };
      return Promise.resolve(new Response(JSON.stringify(payload)));
    });
    const { result, unmount } = renderHook(() => useContainer(parentId), { wrapper: Wrapper });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const calls = fetchMock.mock.calls.length;
    act(() => {
      notifyItemChildrenChanged('another-workspace', parentId);
    });
    expect(fetchMock.mock.calls).toHaveLength(calls);
    title = 'After pet update';
    status = 'Done';
    act(() => {
      notifyItemChildrenChanged(STUB_WORKSPACE.id, parentId);
    });
    await waitFor(() => {
      expect(result.current.children[0]?.title).toBe(title);
    });
    expect(result.current.children[0]?.properties.status).toBe('Done');
    unmount();
    const afterUnmount = fetchMock.mock.calls.length;
    act(() => {
      notifyItemChildrenChanged(STUB_WORKSPACE.id, parentId);
    });
    expect(fetchMock.mock.calls).toHaveLength(afterUnmount);
  });

  it('removes a confirmed deletion from the tree and view before refresh finishes, then restores both', async () => {
    const note = item({
      id: 'e1000000-0000-4000-8000-000000000001',
      workspaceId: STUB_WORKSPACE.id,
      title: 'Delete from both places',
    });
    let deleted = false;
    let holdRefresh = false;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
      if (method === 'DELETE') {
        deleted = true;
        holdRefresh = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (method === 'POST') {
        deleted = false;
        holdRefresh = false;
        return Promise.resolve(new Response(JSON.stringify(note)));
      }
      if (holdRefresh) return new Promise<Response>(() => undefined);
      return Promise.resolve(
        new Response(JSON.stringify({ items: deleted ? [] : [note], nextCursor: null })),
      );
    });
    const { result } = renderHook(() => ({ tree: useWorkspaceTree(), view: useContainer(null) }), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(result.current.tree.childrenOf(null)).toHaveLength(1);
      expect(result.current.view.children).toHaveLength(1);
    });
    await act(async () => {
      expect(await result.current.tree.remove(note.id)).toEqual({ refusal: null });
    });
    expect(result.current.tree.find(note.id)).toBeNull();
    expect(result.current.view.children).toHaveLength(0);
    expect(result.current.view.refreshing).toBe(true);
    await act(async () => {
      expect(await result.current.tree.restore(note.id)).toEqual({ refusal: null });
    });
    await waitFor(() => {
      expect(result.current.tree.find(note.id)?.title).toBe(note.title);
      expect(result.current.view.children[0]?.id).toBe(note.id);
    });
  });

  it('cancels an unfinished page walk when its consumer unmounts', async () => {
    const { unmount } = renderHook(() => useContainer('a1000000-0000-4000-8000-000000000020'), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cursor='))).toBe(true);
    });
    const cursorCall = fetchMock.mock.calls.find(([url]) => String(url).includes('cursor='));
    const request = cursorCall?.[0] as RequestInfo | URL | undefined;
    const signal =
      request instanceof Request
        ? request.signal
        : (cursorCall?.[1] as RequestInit | undefined)?.signal;

    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('refreshes saved-query results after a pet mutation and unsubscribes on unmount', async () => {
    const itemId = 'a1000000-0000-4000-8000-000000000020';
    let title = 'Before';
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            itemId,
            viewId: 'query',
            today: '2026-09-06',
            limit: 100,
            truncated: false,
            results: [
              {
                id: itemId,
                workspaceId: STUB_WORKSPACE.id,
                containerId: null,
                containerTitle: null,
                title,
                type: 'note',
                properties: { title },
              },
            ],
          }),
        ),
      ),
    );
    const { result, unmount } = renderHook(() => useQueryResults(itemId, 'query'), {
      wrapper: Wrapper,
    });
    await waitFor(() => {
      expect(result.current.results?.results[0]?.title).toBe('Before');
    });
    const calls = fetchMock.mock.calls.length;
    act(() => {
      notifyItemChildrenChanged('another-workspace', null);
    });
    expect(fetchMock.mock.calls).toHaveLength(calls);
    title = 'After';
    act(() => {
      notifyItemChildrenChanged(STUB_WORKSPACE.id, null);
    });
    await waitFor(() => {
      expect(result.current.results?.results[0]?.title).toBe('After');
    });
    unmount();
    const finalCalls = fetchMock.mock.calls.length;
    act(() => {
      notifyItemChildrenChanged(STUB_WORKSPACE.id, null);
    });
    expect(fetchMock.mock.calls).toHaveLength(finalCalls);
  });

  it('reports a parsed API shape that fails the container boundary as partial telemetry', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith('/schema')) {
        return Promise.resolve(
          new Response(JSON.stringify({ properties: [], declared: [], inherit: true })),
        );
      }
      if (url.endsWith('/views')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              views: [{ id: 'list', name: 'List', kind: 'list', companionPlacement: 'above' }],
              unrenderable: [],
              default: 'list',
            }),
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [], nextCursor: null })));
    });

    const { result } = renderHook(() => useContainer('a1000000-0000-4000-8000-000000000020'), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('partial');
    });
    expect(result.current.error).toMatch(/views could not be read/i);
    expect(warning).toHaveBeenCalledWith(
      'The container views did not match the contract:',
      expect.any(String),
    );
  });
});
