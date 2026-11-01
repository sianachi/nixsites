import type { MirrorItem, OutboxOperation } from '@nix/sync-core/mirror';
import {
  createInMemoryTokenStore,
  createNixClient,
  files,
  structure,
  views,
} from '@nix/api-client';
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

function fakeStore(
  settings: Record<string, string> = {},
  extra: { outbox?: OutboxOperation[]; aliases?: Record<string, string>; refuse?: string } = {},
): MirrorReader {
  const outbox = extra.outbox ?? [];
  return {
    enqueue: (_ws, operation) => {
      if (extra.refuse !== undefined) return Promise.reject(new Error(extra.refuse));
      outbox.push(operation);
      if (operation.kind === 'create')
        items.push(item(operation.itemId, { title: operation.payload.title, revision: '0' }));
      return Promise.resolve();
    },
    listOutbox: () => Promise.resolve([...outbox]),
    readItems: (ids) =>
      Promise.resolve(
        items.filter((entry) =>
          ids.some((id) => id === entry.id || extra.aliases?.[id] === entry.id),
        ),
      ),
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
  const onUnlocked = vi.fn();
  const inner = over.inner ?? vi.fn(() => Promise.reject(new TypeError('Load failed')));
  const store = over.store === undefined ? fakeStore() : over.store;
  const run = createMirrorFetch({
    inner,
    store: () => store,
    readFile: (id) => Promise.resolve(id === FILE ? new Uint8Array([1, 2, 3]) : null),
    isBootOffline: () => over.bootOffline ?? false,
    onReachability,
    createBlobUrl: () => `blob:${location.origin}/abc`,
    onUnlocked,
  });
  const get = async (path: string, init?: RequestInit) => run(`${location.origin}${path}`, init);
  return { get, inner, onReachability, onUnlocked };
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

  it('reports a successful online unlock so the workspace is rebuilt', async () => {
    const status = { value: 200 };
    const inner = vi.fn(() => Promise.resolve(new Response('{}', { status: status.value })));
    const { get, onUnlocked } = setup({ inner: inner as unknown as typeof fetch });
    await get('/api/v1/items/abc/unlock', { method: 'POST' });
    expect(onUnlocked).toHaveBeenCalledWith('abc');
    onUnlocked.mockClear();
    status.value = 403;
    await get('/api/v1/items/abc/unlock', { method: 'POST' });
    await get('/api/v1/items/abc/unlock');
    expect(onUnlocked).not.toHaveBeenCalled();
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

  describe('offline writes', () => {
    const post = (path: string, body: unknown, method = 'POST') =>
      ({ path, init: { method, body: JSON.stringify(body) } }) as const;

    it('queues a rename with the revision it saw and answers with the item', async () => {
      const outbox: OutboxOperation[] = [];
      const { get } = setup({ store: fakeStore({}, { outbox }) });
      const { path, init } = post(`/api/v1/items/${CHILD}`, { title: 'Renamed' }, 'PATCH');
      const response = await get(path, init);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { id: string }).id).toBe(CHILD);
      expect(outbox).toMatchObject([
        { kind: 'rename', itemId: CHILD, expectedRevision: '1', payload: { title: 'Renamed' } },
      ]);
    });

    it('queues a create under its idempotency key, once, and returns a local item', async () => {
      const outbox: OutboxOperation[] = [];
      const store = fakeStore({}, { outbox });
      const { get } = setup({ store });
      const key = '0199a000-0000-7000-8000-0000000000aa';
      const { path, init } = post(`/api/v1/workspaces/${WS}/items`, {
        type: 'note',
        title: 'New',
        parentId: ROOT,
        properties: null,
        idempotencyKey: key,
      });
      const first = await get(path, init);
      const second = await get(path, init);
      expect(first.status).toBe(201);
      const created = (await first.json()) as { id: string; title: string };
      expect(created.title).toBe('New');
      expect(((await second.json()) as { id: string }).id).toBe(created.id);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ kind: 'create', operationId: key, itemId: created.id });
    });

    it('queues trash as archive and property edits as changes', async () => {
      const outbox: OutboxOperation[] = [];
      const { get } = setup({ store: fakeStore({}, { outbox }) });
      const trashed = await get(`/api/v1/items/${CHILD}`, { method: 'DELETE' });
      expect(trashed.status).toBe(204);
      const { path, init } = post(
        `/api/v1/items/${CHILD}/properties`,
        { properties: { status: 'done', old: null } },
        'PATCH',
      );
      await get(path, init);
      expect(outbox).toMatchObject([
        { kind: 'archive', itemId: CHILD },
        { kind: 'properties', itemId: CHILD, payload: { changes: { status: 'done', old: null } } },
      ]);
    });

    it('refuses writes the replay endpoint cannot carry, and cross-workspace moves', async () => {
      const outbox: OutboxOperation[] = [];
      const { get } = setup({ store: fakeStore({}, { outbox }) });
      for (const [path, init] of [
        [`/api/v1/items/${CHILD}/restore`, { method: 'POST', body: '{}' }],
        [`/api/v1/items/${CHILD}/protection`, { method: 'PUT', body: '{}' }],
        [`/api/v1/workspaces/${WS}/structured-items`, { method: 'POST', body: '{}' }],
        [
          `/api/v1/items/${CHILD}/move`,
          { method: 'POST', body: JSON.stringify({ parentId: null, workspaceId: WS }) },
        ],
      ] as const) {
        const response = await get(path, init);
        expect(response.status).toBe(503);
        expect(((await response.json()) as { code: string }).code).toBe('offline.read_only');
      }
      expect(outbox).toEqual([]);
    });

    it('says why when the mirror will not take a change', async () => {
      const { get } = setup({
        store: fakeStore({}, { refuse: 'Item is not admitted for offline writes' }),
      });
      const { path, init } = post(`/api/v1/items/${CHILD}`, { title: 'x' }, 'PATCH');
      const response = await get(path, init);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { detail: string }).detail).toContain('not admitted');
    });

    it('re-asks the server with the real id once a temporary id has been replaced', async () => {
      const temp = '0199a000-0000-7000-8000-0000000000bb';
      const inner = vi.fn((input: RequestInfo | URL) => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
        return Promise.resolve(
          href.includes(temp) ? new Response('{}', { status: 404 }) : Response.json({ id: CHILD }),
        );
      });
      const { get } = setup({
        inner: inner as unknown as typeof fetch,
        store: fakeStore({}, { aliases: { [temp]: CHILD } }),
      });
      const response = await get(`/api/v1/items/${temp}`);
      expect(response.status).toBe(200);
      expect(inner).toHaveBeenLastCalledWith(
        expect.stringContaining(`/api/v1/items/${CHILD}`),
        undefined,
      );
    });
  });

  describe('responses parse with the real client schemas', () => {
    const HEX = 'a'.repeat(64);
    const stored = [
      item(ROOT, {
        schema: { properties: [{ key: 'status', type: 'select', options: ['A'] }] },
        views: {
          views: [
            { id: 'v1', name: 'List', kind: 'list' },
            { id: 'v1', name: 'Dupe', kind: 'list' },
          ],
          default: 'gone',
          hideDocument: true,
        },
      }),
      item(CHILD, {
        parentId: ROOT,
        schema: { inherit: true, properties: [{ key: 'due', label: 'Due', type: 'date' }] },
      }),
      item(FILE, {
        parentId: CHILD,
        type: 'file',
        file: {
          versionId: VERSION,
          fileName: 'p.png',
          mediaType: 'image/png',
          byteLength: 3,
          sha256: HEX,
        },
      }),
    ];
    const reader = {
      ...fakeStore(),
      readItems: (ids: string[]) => Promise.resolve(stored.filter((e) => ids.includes(e.id))),
    };
    const client = createNixClient({
      baseUrl: location.origin,
      tokens: createInMemoryTokenStore({
        initialAccessToken: 't',
        refresh: () => Promise.resolve(null),
      }),
      fetch: createMirrorFetch({
        inner: () => Promise.reject(new TypeError('Load failed')),
        store: () => reader,
        readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
        isBootOffline: () => true,
        onReachability: () => undefined,
        createBlobUrl: () => `blob:${location.origin}/abc`,
      }),
    });

    it('merges the schema in Core order and fills the fields Core always sends', async () => {
      const schema = await client.query(structure.effectiveSchema(CHILD), { forceRefresh: true });
      expect(schema.properties.map((p) => p.key)).toEqual(['status', 'due']);
      expect(schema.properties[0]).toMatchObject({
        label: 'status',
        options: ['A'],
        required: false,
      });
      expect(schema.declared.map((p) => p.key)).toEqual(['due']);
    });

    it('resolves the views default like Core: dangling opens the document, hidden opens the first', async () => {
      const set = await client.query(views.containerViews(ROOT), { forceRefresh: true });
      expect(set.views.map((v) => v.id)).toEqual(['v1']);
      expect(set).toMatchObject({ default: 'v1', hideDocument: true, unrenderable: [] });
    });

    it('answers the file record and the thumbnail capability', async () => {
      const record = await client.query(files.fileByItem(FILE), { forceRefresh: true });
      expect(record.current).toMatchObject({ fileName: 'p.png', previewable: true });
      const thumbnail = await client.query(files.thumbnailFile(FILE), { forceRefresh: true });
      expect(thumbnail.url).toBe(`blob:${location.origin}/abc`);
      expect(files.isOwnBlobUrl(thumbnail.url)).toBe(true);
    });
  });
});
