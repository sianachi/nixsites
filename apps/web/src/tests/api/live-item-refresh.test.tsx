import {
  createInMemoryTokenStore,
  createNixClient,
  items,
  propertyDefinitionSchema,
  structure,
  viewConfigurationSchema,
  views,
} from '@nix/api-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { useWorkspaceTree } from '../../items/use-workspace-tree';
import { useItemProperties } from '../../properties/use-item-properties';
import { useContainer } from '../../views/core/use-container';
import { WorkspaceProvider } from '@nix/web-workspaces/workspaces/workspace-context';
import { item, STUB_WORKSPACE } from '@nix/web-foundation/testing/api-stub';

const PARENT = item({
  id: 'a1000000-0000-4000-8000-000000000020',
  title: 'Projects',
  hasChildren: true,
});
const CHILD = item({
  id: 'a1000000-0000-4000-8000-000000000021',
  title: 'Existing project',
  parentId: PARENT.id,
  properties: { title: 'Existing project', status: 'Todo' },
});
const CREATED = item({
  id: 'a1000000-0000-4000-8000-000000000022',
  title: 'New project',
  parentId: PARENT.id,
  seq: 2000,
});
const STATUS = propertyDefinitionSchema.parse({
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['Todo', 'Done'],
  required: false,
});
const LIST = viewConfigurationSchema.parse({ id: 'list', name: 'List', kind: 'list' });

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mountReaders({ holdFirstItemRead = false } = {}) {
  const client = createNixClient({
    baseUrl: window.location.origin,
    tokens: createInMemoryTokenStore({
      initialAccessToken: 'test-token',
      refresh: () => Promise.resolve(null),
    }),
  });
  const olderResponse = deferred<Response>();
  let heldItem: typeof CHILD | undefined;
  let rows = [PARENT, CHILD];
  let schema = { properties: [STATUS], declared: [STATUS], inherit: true };
  let viewSet = { views: [LIST], unrenderable: [], default: LIST.id };
  const requests: Request[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // Node Request cannot accept jsdom's AbortSignal; the boundary stub keeps only request data.
      const request =
        input instanceof Request ? input : new Request(input, { ...init, signal: null });
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/schema')) {
        if (request.method === 'PUT') {
          const declaration = z
            .object({ properties: z.array(propertyDefinitionSchema), inherit: z.boolean() })
            .parse(await request.json());
          schema = { ...declaration, declared: declaration.properties };
        }
        return response(schema);
      }
      if (url.pathname.endsWith('/views')) {
        if (request.method === 'PUT') {
          const configuration = z
            .object({ views: z.array(viewConfigurationSchema), default: z.string() })
            .parse(await request.json());
          viewSet = { ...configuration, unrenderable: [] };
        }
        return response(viewSet);
      }
      if (url.pathname === `/api/v1/workspaces/${STUB_WORKSPACE.id}/items`) {
        if (request.method === 'POST') {
          rows = [...rows, CREATED];
          return response(CREATED);
        }
        const parentId = url.searchParams.get('parentId');
        return response({
          items: rows.filter((row) => row.parentId === parentId),
          nextCursor: null,
        });
      }
      if (url.pathname === `/api/v1/items/${CHILD.id}/properties`) {
        const changes = z
          .object({ properties: z.record(z.string(), z.unknown()) })
          .parse(await request.json());
        rows = rows.map((row) =>
          row.id === CHILD.id
            ? { ...row, properties: { ...row.properties, ...changes.properties } }
            : row,
        );
        return response(rows.find((row) => row.id === CHILD.id));
      }
      if (url.pathname === `/api/v1/items/${CHILD.id}`) {
        if (request.method === 'PATCH') {
          const changed = z.object({ title: z.string() }).parse(await request.json());
          rows = rows.map((row) =>
            row.id === CHILD.id
              ? {
                  ...row,
                  title: changed.title,
                  properties: { ...row.properties, title: changed.title },
                }
              : row,
          );
        } else if (holdFirstItemRead && heldItem === undefined) {
          heldItem = CHILD;
          return olderResponse.promise;
        }
        return response(rows.find((row) => row.id === CHILD.id));
      }
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

  return {
    client,
    requests,
    resolveOlderItem: () => {
      olderResponse.resolve(response(heldItem));
    },
    render: () =>
      renderHook(
        () => ({
          tree: useWorkspaceTree(),
          view: useContainer(PARENT.id),
          properties: useItemProperties(CHILD.id),
        }),
        { wrapper: Wrapper },
      ),
  };
}

describe('mounted readers after shared API writes', () => {
  it('shows a created child in the tree and view without collapsing its loaded parent', async () => {
    const io = mountReaders();
    const { result } = io.render();
    await waitFor(() => {
      expect(result.current.tree.status).toBe('ready');
      expect(result.current.view.children.map((child) => child.id)).toEqual([CHILD.id]);
    });
    await act(async () => {
      await result.current.tree.expand(PARENT.id);
    });
    expect(result.current.tree.isExpanded(PARENT.id)).toBe(true);
    await act(async () => {
      await io.client.execute(
        items.createItem(STUB_WORKSPACE.id, {
          parentId: PARENT.id,
          title: CREATED.title,
          type: 'note',
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.tree.childrenOf(PARENT.id).map((child) => child.title)).toEqual([
        CHILD.title,
        CREATED.title,
      ]);
      expect(result.current.view.children.map((child) => child.title)).toEqual([
        CHILD.title,
        CREATED.title,
      ]);
    });
    expect(result.current.tree.isExpanded(PARENT.id)).toBe(true);
  });

  it('updates the mounted properties panel and container after a property write through the shared client', async () => {
    const io = mountReaders();
    const { result } = io.render();
    await waitFor(() => {
      expect(result.current.properties.item?.properties.status).toBe('Todo');
      expect(result.current.view.children[0]?.properties.status).toBe('Todo');
    });
    await act(async () => {
      await io.client.execute(structure.setItemProperties(CHILD.id, { status: 'Done' }));
    });

    await waitFor(() => {
      expect(result.current.properties.item?.properties.status).toBe('Done');
      expect(result.current.view.children[0]?.properties.status).toBe('Done');
    });
  });

  it('refreshes cached inherited schemas and view configurations after an item invalidation', async () => {
    const io = mountReaders();
    const { result } = io.render();
    await waitFor(() => {
      expect(result.current.view.schema?.properties[0]?.label).toBe('Status');
      expect(result.current.view.views?.views[0]?.name).toBe('List');
      expect(result.current.properties.schema?.properties[0]?.label).toBe('Status');
    });
    expect(io.client.cache.peek(['items', PARENT.id, 'schema'])).toBeDefined();
    expect(io.client.cache.peek(['items', PARENT.id, 'view-configurations'])).toBeDefined();
    const schemaReads = io.requests.filter((request) => request.url.endsWith('/schema')).length;
    const viewReads = io.requests.filter((request) => request.url.endsWith('/views')).length;
    await act(async () => {
      await io.client.execute(
        structure.setItemSchema(PARENT.id, {
          properties: [{ ...STATUS, label: 'Workflow status' }],
          inherit: true,
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.view.schema?.properties[0]?.label).toBe('Workflow status');
      expect(result.current.properties.schema?.properties[0]?.label).toBe('Workflow status');
    });
    expect(io.requests.filter((request) => request.url.endsWith('/schema')).length).toBeGreaterThan(
      schemaReads,
    );
    expect(io.requests.filter((request) => request.url.endsWith('/views')).length).toBeGreaterThan(
      viewReads,
    );
    await act(async () => {
      await io.client.execute(
        views.setContainerViews(PARENT.id, {
          views: [{ ...LIST, name: 'Project list' }],
          default: LIST.id,
        }),
      );
    });
    await waitFor(() => {
      expect(result.current.view.views?.views[0]?.name).toBe('Project list');
    });
  });

  it('keeps the latest mounted item when a GET begun before the write resolves afterward', async () => {
    const io = mountReaders({ holdFirstItemRead: true });
    const olderRead = io.client.query(items.itemById(CHILD.id));
    await waitFor(() => {
      expect(io.requests.some((request) => request.url.endsWith(`/items/${CHILD.id}`))).toBe(true);
    });
    const { result } = io.render();
    await waitFor(() => {
      expect(result.current.view.children[0]?.title).toBe(CHILD.title);
      expect(result.current.tree.status).toBe('ready');
    });
    await act(async () => {
      await result.current.tree.expand(PARENT.id);
      await io.client.execute(items.renameItem(STUB_WORKSPACE.id, CHILD.id, 'Latest title'));
    });
    await waitFor(() => {
      expect(result.current.properties.item?.title).toBe('Latest title');
      expect(result.current.tree.find(CHILD.id)?.title).toBe('Latest title');
      expect(result.current.view.children[0]?.title).toBe('Latest title');
    });
    await act(async () => {
      io.resolveOlderItem();
      expect((await olderRead).title).toBe(CHILD.title);
    });

    expect(result.current.properties.item?.title).toBe('Latest title');
    expect(result.current.tree.find(CHILD.id)?.title).toBe('Latest title');
    expect(result.current.view.children[0]?.title).toBe('Latest title');
    expect(io.client.cache.peek(['items', CHILD.id])?.data).toMatchObject({
      title: 'Latest title',
    });
  });
});
