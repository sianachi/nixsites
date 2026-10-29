import { createNixClient } from '@nix/api-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { useContainer } from '@nix/web-collections/core/use-container';
import { useQueryResults } from '../../views/query/use-query-results';
import { WorkspaceProvider } from '@nix/web-workspaces/workspaces/workspace-context';
import { item, STUB_WORKSPACE } from '@nix/web-foundation/testing/api-stub';
import { aView } from '@nix/web-collections/testing/view-fixture';

const CONTAINER = 'e2000000-0000-4000-8000-000000000001';
const child = item({
  id: 'e2000000-0000-4000-8000-000000000002',
  workspaceId: STUB_WORKSPACE.id,
  parentId: CONTAINER,
  title: 'Previously readable row',
});
const field = {
  key: 'status',
  label: 'Private status',
  type: 'text',
  options: [],
  required: false,
};
const schema = { properties: [field], declared: [field], inherit: true };
const views = { views: [aView()], unrenderable: [], default: 'view-1' };

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
  return { client, Wrapper };
}

function requestUrl(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : String(input));
}

function successful(input: RequestInfo | URL) {
  const url = requestUrl(input);
  const payload = url.pathname.endsWith('/schema')
    ? schema
    : url.pathname.endsWith('/views')
      ? views
      : url.pathname.endsWith('/query')
        ? {
            itemId: CONTAINER,
            viewId: 'view-1',
            today: url.searchParams.get('today'),
            results: [
              {
                id: child.id,
                workspaceId: child.workspaceId,
                containerId: CONTAINER,
                containerTitle: 'Previously readable container',
                title: child.title,
                type: child.type,
                properties: child.properties,
              },
            ],
            limit: 500,
            truncated: false,
          }
        : { items: [child], nextCursor: null };
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
}

function refused(status: number, code = 'items.unavailable') {
  return new Response(JSON.stringify({ status, code, detail: 'The refreshed read was refused.' }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('view readers after cache invalidation', () => {
  it.each([403, 404, 423, 503])(
    'handles a fresh container %s after a successful read',
    async (status) => {
      let fail = false;
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) =>
          Promise.resolve(fail ? refused(status) : successful(input)),
        ),
      );
      const { client, Wrapper } = setup();
      const { result } = renderHook(() => useContainer(CONTAINER), { wrapper: Wrapper });
      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });
      expect(result.current.children[0]?.title).toBe(child.title);
      expect(result.current.schema?.properties[0]?.label).toBe(field.label);
      expect(result.current.views?.views[0]?.id).toBe('view-1');
      const previous = result.current;
      fail = true;
      act(() => {
        client.invalidate(['workspaces', STUB_WORKSPACE.id, 'items']);
      });

      if (status === 503) {
        await waitFor(() => {
          expect(result.current.refreshError).not.toBeNull();
        });
        expect(result.current.status).toBe('ready');
        expect(result.current.children).toBe(previous.children);
        expect(result.current.schema).toBe(previous.schema);
        expect(result.current.views).toBe(previous.views);
      } else {
        await waitFor(() => {
          expect(result.current.status).toBe('error');
        });
        expect(result.current.children).toEqual([]);
        expect(result.current.schema).toBeNull();
        expect(result.current.views).toBeNull();
        expect(result.current.error).not.toBeNull();
        expect(result.current.refreshError).toBeNull();
      }
      expect(result.current.refreshing).toBe(false);
    },
  );

  it.each([403, 404, 423, 503])(
    'handles a fresh query %s after a successful read',
    async (status) => {
      let fail = false;
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) =>
          Promise.resolve(fail ? refused(status) : successful(input)),
        ),
      );
      const { client, Wrapper } = setup();
      const { result } = renderHook(() => useQueryResults(CONTAINER, 'view-1'), {
        wrapper: Wrapper,
      });
      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });
      expect(result.current.results?.results[0]?.title).toBe(child.title);
      const previous = result.current.results;
      fail = true;
      act(() => {
        client.invalidate(['workspaces', STUB_WORKSPACE.id, 'items']);
      });

      if (status === 503) {
        await waitFor(() => {
          expect(result.current.refreshError).not.toBeNull();
        });
        expect(result.current.status).toBe('ready');
        expect(result.current.results).toBe(previous);
      } else {
        await waitFor(() => {
          expect(result.current.status).toBe('error');
        });
        expect(result.current.results).toBeNull();
        expect(result.current.error).not.toBeNull();
        expect(result.current.refreshError).toBeNull();
      }
      expect(result.current.refreshing).toBe(false);
    },
  );

  it('clears locked children while another container read is pending and then fails', async () => {
    let fail = false;
    let failSchema: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (!fail) return Promise.resolve(successful(input));
        const url = requestUrl(input);
        if (url.pathname.endsWith('/schema'))
          return new Promise<Response>((resolve) => {
            failSchema = () => {
              resolve(refused(503));
            };
          });
        if (url.pathname.endsWith('/views')) return Promise.resolve(successful(input));
        return Promise.resolve(refused(423, 'items.locked'));
      }),
    );
    const { client, Wrapper } = setup();
    const { result } = renderHook(() => useContainer(CONTAINER), { wrapper: Wrapper });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.children[0]?.title).toBe(child.title);
    fail = true;
    act(() => {
      client.invalidate(['workspaces', STUB_WORKSPACE.id, 'items']);
    });
    await waitFor(() => {
      expect(result.current.children).toEqual([]);
    });
    expect(failSchema).toBeTypeOf('function');
    act(() => {
      failSchema?.();
    });
    await waitFor(() => {
      expect(result.current.refreshing).toBe(false);
    });
    expect(result.current.children).toEqual([]);
  });

  it('clears a confirmed child refusal even after another request reported a transient failure', async () => {
    let fail = false;
    let denyChildren: (() => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (!fail) return Promise.resolve(successful(input));
        const url = requestUrl(input);
        if (url.pathname.endsWith('/schema')) return Promise.resolve(refused(503));
        if (url.pathname.endsWith('/views')) return Promise.resolve(successful(input));
        return new Promise<Response>((resolve) => {
          denyChildren = () => {
            resolve(refused(403));
          };
        });
      }),
    );
    const { client, Wrapper } = setup();
    const { result } = renderHook(() => useContainer(CONTAINER), { wrapper: Wrapper });
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    fail = true;
    act(() => {
      client.invalidate(['workspaces', STUB_WORKSPACE.id, 'items']);
    });
    await waitFor(() => {
      expect(denyChildren).toBeTypeOf('function');
    });
    expect(result.current.children[0]?.title).toBe(child.title);
    act(() => {
      denyChildren?.();
    });
    await waitFor(() => {
      expect(result.current.children).toEqual([]);
    });
    expect(result.current.schema).toBeNull();
    expect(result.current.views).toBeNull();
  });

  it.each(['schema', 'views'])(
    'clears a confirmed %s items.not_found even when children fail temporarily',
    async (endpoint) => {
      let fail = false;
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL) => {
          if (!fail) return Promise.resolve(successful(input));
          const path = requestUrl(input).pathname;
          return Promise.resolve(
            path.endsWith(`/${endpoint}`)
              ? refused(404, 'items.not_found')
              : path.endsWith('/schema') || path.endsWith('/views')
                ? successful(input)
                : refused(503),
          );
        }),
      );
      const { client, Wrapper } = setup();
      const { result } = renderHook(() => useContainer(CONTAINER), { wrapper: Wrapper });
      await waitFor(() => {
        expect(result.current.status).toBe('ready');
      });
      fail = true;
      act(() => {
        client.invalidate(['workspaces', STUB_WORKSPACE.id, 'items']);
      });
      await waitFor(() => {
        expect(result.current.status).toBe('error');
      });
      expect(result.current.children).toEqual([]);
      expect(result.current.schema).toBeNull();
      expect(result.current.views).toBeNull();
    },
  );
});
