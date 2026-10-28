import {
  createInMemoryTokenStore,
  createNixClient,
  viewConfigurationSchema,
} from '@nix/api-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { onItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import { ViewSchema } from '../../views/core/container-model';
import { useContainer } from '../../views/core/use-container';
import { useQueryResults } from '../../views/query/use-query-results';
import { WorkspaceProvider } from '../../workspaces/workspace-context';
import { item, STUB_WORKSPACE } from '../api-stub';

const PARENT = item({
  id: 'a6000000-0000-4000-8000-000000000001',
  title: 'Project smart list',
  hasChildren: true,
});
const TODO = item({
  id: 'a6000000-0000-4000-8000-000000000002',
  title: 'Unfinished project',
  parentId: PARENT.id,
  properties: { status: 'Todo' },
});
const DONE = item({
  id: 'a6000000-0000-4000-8000-000000000003',
  title: 'Finished project',
  parentId: PARENT.id,
  properties: { status: 'Done' },
});
const QUERY = viewConfigurationSchema.parse({
  id: 'projects',
  name: 'Projects',
  kind: 'query',
  filters: [{ property: 'status', operator: 'equals', value: 'Todo' }],
});
const UPDATED_QUERY = ViewSchema.parse({
  ...QUERY,
  filters: [{ property: 'status', operator: 'equals', value: 'Done' }],
});
const OTHER_VIEW = viewConfigurationSchema.parse({
  id: 'all',
  name: 'All projects',
  kind: 'list',
  columns: ['title', 'status'],
  sortBy: 'status',
  sortDescending: true,
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

describe('saved filters after a shared API write', () => {
  it('refreshes query results and view metadata once through the coalesced workspace bridge', async () => {
    const client = createNixClient({
      baseUrl: window.location.origin,
      tokens: createInMemoryTokenStore({
        initialAccessToken: 'filter-refresh-test-token',
        refresh: () => Promise.resolve(null),
      }),
    });
    let storedViews = { views: [QUERY, OTHER_VIEW], unrenderable: [], default: OTHER_VIEW.id };
    const requests: Request[] = [];
    const queriedStatuses: string[] = [];
    const viewsPath = `/api/v1/items/${PARENT.id}/views`;
    const queryPath = `/api/v1/items/${PARENT.id}/query`;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        // Node Request cannot accept jsdom's AbortSignal; keep only the boundary request data.
        const request =
          input instanceof Request ? input : new Request(input, { ...init, signal: null });
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname === viewsPath) {
          if (request.method === 'PUT') {
            const configuration = z
              .object({ views: z.array(viewConfigurationSchema), default: z.string() })
              .parse(await request.json());
            storedViews = { ...configuration, unrenderable: [] };
          }
          return response(storedViews);
        }
        if (url.pathname === queryPath) {
          const filter = storedViews.views[0]?.filters[0];
          if (filter?.property !== 'status' || filter.value === null)
            throw new Error('The stored status filter is missing.');
          queriedStatuses.push(filter.value);
          return response({
            itemId: PARENT.id,
            viewId: url.searchParams.get('view'),
            today: url.searchParams.get('today'),
            results: [TODO, DONE]
              .filter((row) => row.properties.status === filter.value)
              .map((row) => ({
                ...row,
                containerId: PARENT.id,
                containerTitle: PARENT.title,
              })),
            limit: 500,
            truncated: false,
          });
        }
        if (url.pathname === `/api/v1/items/${PARENT.id}/schema`)
          return response({ properties: [], declared: [], inherit: true });
        if (url.pathname === `/api/v1/workspaces/${STUB_WORKSPACE.id}/items`)
          return response({ items: [TODO, DONE], nextCursor: null });
        throw new Error(`Unexpected Core request: ${request.method} ${url.pathname}`);
      }),
    );

    function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
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

    const { result } = renderHook(
      () => ({
        container: useContainer(PARENT.id),
        query: useQueryResults(PARENT.id, QUERY.id),
      }),
      { wrapper: Wrapper },
    );
    await waitFor(() => {
      expect(result.current.container.status).toBe('ready');
      expect(result.current.query.results?.results.map((row) => row.id)).toEqual([TODO.id]);
    });
    const getCount = (path: string): number =>
      requests.filter(
        (request) => request.method === 'GET' && new URL(request.url).pathname === path,
      ).length;
    const metadataReads = getCount(viewsPath);
    const queryReads = getCount(queryPath);
    const changed = vi.fn();
    const stop = onItemChildrenChanged(changed);
    try {
      await act(async () => {
        expect(
          await result.current.container.setViews([UPDATED_QUERY, ViewSchema.parse(OTHER_VIEW)]),
        ).toBeNull();
      });
      expect(storedViews.views[0]?.filters).toMatchObject(UPDATED_QUERY.filters);
      expect(storedViews.views[1]).toEqual(OTHER_VIEW);
      expect(storedViews.default).toBe(OTHER_VIEW.id);
      await waitFor(() => {
        expect(result.current.query.results?.results.map((row) => row.id)).toEqual([DONE.id]);
        expect(result.current.container.views?.views[0]?.filters).toEqual(UPDATED_QUERY.filters);
        expect(result.current.container.refreshing).toBe(false);
        expect(result.current.container.refreshError).toBeNull();
      });
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_050));
      });

      expect(changed).toHaveBeenCalledTimes(1);
      expect(queriedStatuses).toEqual(['Todo', 'Done']);
      expect(getCount(queryPath) - queryReads).toBe(1);
      expect(getCount(viewsPath) - metadataReads).toBe(1);
      expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
      expect(result.current.container.views?.views[0]?.filters).toEqual(UPDATED_QUERY.filters);
      expect(result.current.container.views?.views[1]).toEqual(ViewSchema.parse(OTHER_VIEW));
      expect(result.current.container.views?.default).toBe(OTHER_VIEW.id);
      expect(result.current.query.error).toBeNull();
      expect(result.current.query.refreshError).toBeNull();
    } finally {
      stop();
    }
  });
});
