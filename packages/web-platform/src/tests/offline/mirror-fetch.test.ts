import type { MirrorItem } from '@nix/sync-core/mirror';
import { describe, expect, it, vi } from 'vitest';

import {
  createMirrorFetch,
  rememberKey,
  WORKSPACES_SETTING,
  type MirrorReader,
} from '../../offline/mirror-fetch';

const WS = '0199a000-0000-7000-8000-000000000001';
const ROOT = '0199a000-0000-7000-8000-000000000010';
const CHILD = '0199a000-0000-7000-8000-000000000011';
const FILE = '0199a000-0000-7000-8000-000000000012';
const VERSION = '0199a000-0000-7000-8000-0000000000f1';

function item(id: string, over: Partial<MirrorItem> = {}): MirrorItem {
  return {
    id,
    workspaceId: WS,
    parentId: null,
    type: 'note',
    title: id.slice(-2),
    seq: 1,
    revision: '1',
    lifecycleState: 'active',
    properties: {},
    computedProperties: null,
    schema: null,
    views: null,
    recurrence: null,
    noDelete: false,
    noChildren: false,
    managedBy: null,
    createdAt: '2026-10-01T09:00:00+00:00',
    updatedAt: null,
    canWrite: true,
    locked: false,
    canPersistBody: true,
    metadataExpiresAt: null,
    bodyDocId: null,
    bodyHeadSeq: null,
    file: null,
    ...over,
  };
}

const items = [
  item(ROOT, {
    schema: { properties: [{ key: 'status', label: 'Status', type: 'text' }] },
    views: { views: [{ id: 'v1', name: 'List', kind: 'list' }], default: 'v1' },
  }),
  item(CHILD, { parentId: ROOT, seq: 2 }),
  item(FILE, {
    parentId: ROOT,
    seq: 1,
    type: 'file',
    file: {
      versionId: VERSION,
      fileName: 'a.txt',
      mediaType: 'text/plain',
      byteLength: 3,
      sha256: 'x',
    },
  }),
];

function fakeStore(settings: Record<string, string> = {}): MirrorReader {
  return {
    readItems: (ids) => Promise.resolve(items.filter((entry) => ids.includes(entry.id))),
    listItems: () => Promise.resolve(items),
    searchItems: (_ws, q) => Promise.resolve(items.filter((entry) => entry.title.includes(q))),
    readWorkspaceList: () => Promise.resolve([{ id: WS, name: 'Home' }]),
    getSetting: (key) => Promise.resolve(settings[key] ?? null),
    setSetting: (key, value) => {
      if (value !== null) settings[key] = value;
      return Promise.resolve();
    },
    subscribe: () => () => undefined,
  };
}

function setup(
  over: { bootOffline?: boolean; store?: MirrorReader | null; inner?: typeof fetch } = {},
) {
  const onReachability = vi.fn();
  const inner = over.inner ?? vi.fn(() => Promise.reject(new TypeError('Load failed')));
  const store = over.store === undefined ? fakeStore() : over.store;
  const run = createMirrorFetch({
    inner,
    store: () => store,
    readFile: (id) => Promise.resolve(id === FILE ? new Uint8Array([1, 2, 3]) : null),
    isBootOffline: () => over.bootOffline ?? false,
    onReachability,
    createBlobUrl: () => `blob:${location.origin}/abc`,
  });
  const get = async (path: string, init?: RequestInit) => run(`${location.origin}${path}`, init);
  return { get, inner, onReachability };
}

describe('mirror fetch router', () => {
  it('passes through while connected and keeps the small boot reads', async () => {
    const settings: Record<string, string> = {};
    const inner = vi.fn(() => Promise.resolve(Response.json({ id: 'me' })));
    const { get, onReachability } = setup({
      inner: inner as unknown as typeof fetch,
      store: fakeStore(settings),
    });
    const response = await get('/api/v1/me');
    expect(await response.json()).toEqual({ id: 'me' });
    expect(onReachability).toHaveBeenCalledWith(true);
    await vi.waitFor(() => {
      expect(settings[rememberKey('/api/v1/me')]).toBe('{"id":"me"}');
    });
  });

  it('answers from the mirror when the network throws', async () => {
    const { get, onReachability } = setup();
    const response = await get(`/api/v1/workspaces/${WS}/items?parentId=${ROOT}`);
    expect(onReachability).toHaveBeenCalledWith(false);
    const body = (await response.json()) as {
      items: { id: string; hasChildren: boolean }[];
      nextCursor: null;
    };
    expect(body.items.map((entry) => entry.id)).toEqual([FILE, CHILD]);
    expect(body.nextCursor).toBeNull();
  });

  it('rethrows a network failure when there is no mirror, and never swallows an abort', async () => {
    await expect(setup({ store: null }).get('/api/v1/me')).rejects.toThrow('Load failed');
    const aborted = vi.fn(() => Promise.reject(new DOMException('x', 'AbortError')));
    await expect(
      setup({ inner: aborted as unknown as typeof fetch }).get('/api/v1/me'),
    ).rejects.toThrow();
  });

  it('serves roots with hasChildren, an item, its schema and views', async () => {
    const { get, inner } = setup({ bootOffline: true });
    const roots = (await (await get(`/api/v1/workspaces/${WS}/items`)).json()) as {
      items: { id: string; hasChildren: boolean }[];
    };
    expect(roots.items).toEqual([expect.objectContaining({ id: ROOT, hasChildren: true })]);
    expect(inner).not.toHaveBeenCalled();

    const one = (await (await get(`/api/v1/items/${CHILD}`)).json()) as { parentId: string };
    expect(one.parentId).toBe(ROOT);

    const schema = (await (await get(`/api/v1/items/${CHILD}/schema`)).json()) as {
      properties: { key: string }[];
      declared: unknown[];
      inherit: boolean;
    };
    expect(schema.properties.map((entry) => entry.key)).toEqual(['status']);
    expect(schema.declared).toEqual([]);

    const views = (await (await get(`/api/v1/items/${ROOT}/views`)).json()) as {
      views: unknown[];
      default: string;
    };
    expect(views).toMatchObject({ default: 'v1', hideDocument: false });
    expect(views.views).toHaveLength(1);
  });

  it('pages the item list', async () => {
    const { get } = setup({ bootOffline: true });
    const page = (await (
      await get(`/api/v1/workspaces/${WS}/items?parentId=${ROOT}&limit=1`)
    ).json()) as {
      items: { id: string }[];
      nextCursor: string;
    };
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('1');
    const rest = (await (
      await get(`/api/v1/workspaces/${WS}/items?parentId=${ROOT}&limit=1&cursor=1`)
    ).json()) as {
      items: { id: string }[];
      nextCursor: null;
    };
    expect(rest).toMatchObject({ items: [{ id: CHILD }], nextCursor: null });
  });

  it('lists workspaces from the kept list and searches the mirror', async () => {
    const kept = [{ id: WS, name: 'Home', kind: 'shared' }];
    const { get } = setup({
      bootOffline: true,
      store: fakeStore({ [WORKSPACES_SETTING]: JSON.stringify(kept) }),
    });
    expect(await (await get('/api/v1/workspaces')).json()).toEqual({
      items: kept,
      nextCursor: null,
    });
    expect(await (await get(`/api/v1/workspaces/${WS}`)).json()).toEqual(kept[0]);
    const found = (await (await get('/api/v1/search?q=10&limit=5')).json()) as {
      results: { id: string }[];
    };
    expect(found.results.map((hit) => hit.id)).toEqual([ROOT]);
  });

  it('answers a file download with a capability for a blob of the stored bytes', async () => {
    const { get } = setup({ bootOffline: true });
    const capability = (await (await get(`/api/v1/items/${FILE}/file/download`)).json()) as {
      url: string;
      byteLength: number;
    };
    expect(capability.url).toBe(`blob:${location.origin}/abc`);
    expect(capability.byteLength).toBe(3);
    const missing = await get(`/api/v1/items/${FILE}/file/download?versionId=other`);
    expect(missing.status).toBe(404);
  });

  it('says plainly when something is not available offline or is a write', async () => {
    const { get } = setup({ bootOffline: true });
    const unknown = await get('/api/v1/pets');
    expect(unknown.status).toBe(503);
    expect(((await unknown.json()) as { code: string }).code).toBe('offline.unavailable');
    const write = await get(`/api/v1/items/${CHILD}`, { method: 'PATCH', body: '{}' });
    expect(write.status).toBe(503);
    expect(((await write.json()) as { code: string }).code).toBe('offline.read_only');
  });

  it('does not intercept other origins', async () => {
    const inner = vi.fn(() => Promise.resolve(new Response('ok')));
    const run = createMirrorFetch({
      inner,
      store: () => null,
      readFile: () => Promise.resolve(null),
      isBootOffline: () => true,
      onReachability: () => undefined,
    });
    await run('https://files.example/x');
    expect(inner).toHaveBeenCalled();
  });
});
