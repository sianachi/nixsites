import type { MirrorItem } from '@nix/sync-core/mirror';
import type { SqliteMirrorStore } from '@nix/sync-sqlite';

/**
 * Core, answered from the iOS shell's synced copy. The API client's `fetch` goes through
 * `createMirrorFetch` there: the network first, the mirror when the network is gone (or when the
 * app opened offline). Only reads the app needs to browse are answered, in Core's JSON shapes;
 * everything else says plainly that it needs a connection. Nothing here runs in a browser.
 */

export type MirrorReader = Pick<
  SqliteMirrorStore,
  'readItems' | 'listItems' | 'searchItems' | 'readWorkspaceList' | 'getSetting' | 'setSetting'
> & { subscribe(listener: () => void): () => void };

export interface MirrorFetchDeps {
  readonly inner: typeof fetch;
  /** The admitted mirror, or null when there is none (or admission is closed). */
  readonly store: () => MirrorReader | null;
  readonly readFile: (itemId: string, versionId: string) => Promise<Uint8Array | null>;
  readonly isBootOffline: () => boolean;
  /** Told whether the last call to Core got an answer, for the offline indicator. */
  readonly onReachability: (up: boolean) => void;
  readonly createBlobUrl?: (bytes: Uint8Array, mediaType: string) => string;
}

type Json = Record<string, unknown>;

/** Small account-level reads the app makes at boot; kept from the last online run. */
export const REMEMBERED = new Set([
  '/api/v1/me',
  '/api/v1/me/preferences',
  '/api/v1/me/ui-settings',
  '/api/v1/me/workspace-arrangement',
]);
export const WORKSPACES_SETTING = 'offline.workspaces';
export const rememberKey = (path: string): string => `offline.cache:${path}`;
const MAX_REMEMBERED_BYTES = 256 * 1024;

const GATEWAY_DOWN = new Set([502, 503, 504, 530]);

function problem(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: detail, status, code, detail }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const seqOf = (item: MirrorItem): bigint => {
  try {
    return BigInt(String(item.seq));
  } catch {
    return 0n;
  }
};

interface WorkspaceIndex {
  readonly byParent: Map<string | null, MirrorItem[]>;
}

function indexOf(items: MirrorItem[]): WorkspaceIndex {
  const byParent = new Map<string | null, MirrorItem[]>();
  for (const item of items) {
    if (item.lifecycleState !== 'active') continue;
    const siblings = byParent.get(item.parentId) ?? [];
    siblings.push(item);
    byParent.set(item.parentId, siblings);
  }
  for (const siblings of byParent.values())
    siblings.sort((a, b) => {
      const order = seqOf(a) - seqOf(b);
      return order !== 0n ? (order < 0n ? -1 : 1) : a.id.localeCompare(b.id);
    });
  return { byParent };
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const propertyList = (schema: Json | null): unknown[] =>
  isRecord(schema) && Array.isArray(schema.properties) ? schema.properties : [];

export function createMirrorFetch(deps: MirrorFetchDeps): typeof fetch {
  const indexes = new Map<string, Promise<WorkspaceIndex>>();
  const watched = new WeakSet<object>();

  function workspaceIndex(store: MirrorReader, workspaceId: string): Promise<WorkspaceIndex> {
    if (!watched.has(store)) {
      watched.add(store);
      store.subscribe(() => {
        indexes.clear();
      });
    }
    let index = indexes.get(workspaceId);
    if (index === undefined) {
      index = store.listItems(workspaceId).then(indexOf);
      indexes.set(workspaceId, index);
    }
    return index;
  }

  const toItem = (item: MirrorItem, index: WorkspaceIndex): Json => ({
    id: item.id,
    workspaceId: item.workspaceId,
    parentId: item.parentId,
    type: item.type,
    title: item.title,
    hasChildren: (index.byParent.get(item.id)?.length ?? 0) > 0,
    seq: item.seq,
    lifecycleState: item.lifecycleState,
    properties: item.properties,
    computed: item.computedProperties,
    noDelete: item.noDelete,
    noChildren: item.noChildren,
    managedBy: item.managedBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt ?? item.createdAt,
  });

  async function cachedWorkspaces(store: MirrorReader): Promise<Json[]> {
    const present = new Set((await store.readWorkspaceList()).map((workspace) => workspace.id));
    const raw = await store.getSetting(WORKSPACES_SETTING);
    let workspaces: Json[] = [];
    try {
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      workspaces = Array.isArray(parsed) ? parsed.filter(isRecord) : [];
    } catch {
      /* An unreadable list falls back to the mirror's own names below. */
    }
    if (workspaces.length === 0)
      return (await store.readWorkspaceList()).map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        versionRetentionDays: 0,
        storageQuotaBytes: 0,
        createdAt: new Date(0).toISOString(),
        kind: 'personal',
        canRename: false,
        canManageMembers: false,
        canLeave: false,
        canUseDailyNotes: false,
        pendingInvitationId: null,
        lifecycleState: 'active',
        archivedAt: null,
      }));
    return workspaces.filter(
      (workspace) => present.size === 0 || present.has(String(workspace.id)),
    );
  }

  /** The item and its ancestors, nearest first, for inheriting schemas. */
  async function chain(store: MirrorReader, item: MirrorItem): Promise<MirrorItem[]> {
    const found: MirrorItem[] = [];
    let current: MirrorItem | undefined = item;
    while (current !== undefined && found.length < 64) {
      found.push(current);
      current =
        current.parentId === null ? undefined : (await store.readItems([current.parentId]))[0];
    }
    return found;
  }

  async function answer(store: MirrorReader, url: URL): Promise<Response | null> {
    const path = url.pathname;
    const query = url.searchParams;

    if (REMEMBERED.has(path)) {
      const kept = await store.getSetting(rememberKey(path));
      return kept === null
        ? null
        : new Response(kept, { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/api/v1/workspaces')
      return json({ items: await cachedWorkspaces(store), nextCursor: null });

    const workspaceMatch = /^\/api\/v1\/workspaces\/([^/]+)$/.exec(path);
    if (workspaceMatch?.[1] !== undefined) {
      const found = (await cachedWorkspaces(store)).find((entry) => entry.id === workspaceMatch[1]);
      return found === undefined
        ? problem(404, 'workspace.not_found', 'This workspace is not in the synced copy.')
        : json(found);
    }

    const listMatch = /^\/api\/v1\/workspaces\/([^/]+)\/items$/.exec(path);
    if (listMatch?.[1] !== undefined) {
      const index = await workspaceIndex(store, listMatch[1]);
      const siblings = index.byParent.get(query.get('parentId') ?? null) ?? [];
      const limit = Math.max(1, Math.min(Number(query.get('limit')) || 100, 500));
      const offset = Math.max(0, Number(query.get('cursor')) || 0);
      const page = siblings.slice(offset, offset + limit);
      return json({
        items: page.map((item) => toItem(item, index)),
        nextCursor: offset + limit < siblings.length ? String(offset + limit) : null,
      });
    }

    if (path === '/api/v1/search') {
      const needle = (query.get('q') ?? '').trim();
      const limit = Number(query.get('limit')) || 20;
      const hits: MirrorItem[] = [];
      if (needle.length >= 2)
        for (const workspace of await store.readWorkspaceList())
          hits.push(...(await store.searchItems(workspace.id, needle)));
      return json({
        query: query.get('q') ?? '',
        results: hits.slice(0, limit).map((item) => ({
          id: item.id,
          workspaceId: item.workspaceId,
          type: item.type,
          title: item.title,
          parentId: item.parentId,
          updatedAt: item.updatedAt ?? item.createdAt,
        })),
        limit,
        truncated: hits.length > limit,
      });
    }

    const itemMatch = /^\/api\/v1\/items\/([^/]+)(?:\/(schema|views|lock|file\/download))?$/.exec(
      path,
    );
    if (itemMatch?.[1] === undefined) return null;
    const item = (await store.readItems([itemMatch[1]]))[0];
    if (item?.lifecycleState !== 'active')
      return problem(404, 'item.not_found', 'This item is not in the synced copy.');
    const part = itemMatch[2];

    if (part === undefined)
      return json(toItem(item, await workspaceIndex(store, item.workspaceId)));

    if (part === 'lock')
      return json({
        locked: item.locked,
        unlockedUntil: null,
        lockItemId: null,
        selfLocked: false,
      });

    if (part === 'schema') {
      // shortcut: ancestors' schemas merge by key with the nearest winning; Core's finer rules
      // (choice sources, rollups) are not re-derived. Upgrade if offline forms look wrong.
      const own = propertyList(item.schema);
      const inherit = !isRecord(item.schema) || item.schema.inherit !== false;
      const properties = new Map<string, unknown>();
      if (inherit)
        for (const ancestor of (await chain(store, item)).slice(1).reverse())
          for (const property of propertyList(ancestor.schema))
            if (isRecord(property)) properties.set(String(property.key), property);
      for (const property of own)
        if (isRecord(property)) properties.set(String(property.key), property);
      return json({ properties: [...properties.values()], declared: own, inherit });
    }

    if (part === 'views') {
      const raw = isRecord(item.views) ? item.views : {};
      const views = Array.isArray(raw.views) ? raw.views : [];
      const first = isRecord(views[0]) ? views[0].id : undefined;
      return json({
        views,
        unrenderable: Array.isArray(raw.unrenderable) ? raw.unrenderable : [],
        default:
          typeof raw.default === 'string'
            ? raw.default
            : typeof first === 'string'
              ? first
              : 'document',
        hideDocument: raw.hideDocument === true,
        version: typeof raw.version === 'string' ? raw.version : null,
      });
    }

    // file/download: a capability whose url is a blob of the downloaded bytes.
    const file = item.file;
    const wanted = query.get('versionId');
    if (file === null || item.locked || (wanted !== null && wanted !== file.versionId))
      return problem(404, 'file.not_found', 'This file version is not in the synced copy.');
    const bytes = await deps.readFile(item.id, file.versionId);
    if (bytes === null)
      return problem(
        503,
        'offline.unavailable',
        'This file has not been downloaded to this device yet.',
      );
    const blobUrl =
      deps.createBlobUrl?.(bytes, file.mediaType) ??
      URL.createObjectURL(new Blob([bytes.slice().buffer], { type: file.mediaType }));
    return json({
      url: blobUrl,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      fileName: file.fileName,
      mediaType: file.mediaType,
      byteLength: file.byteLength,
      sha256: file.sha256,
      inline: true,
      unscanned: false,
      noSniff: true,
    });
  }

  function remember(store: MirrorReader, path: string, response: Response): void {
    if (!REMEMBERED.has(path) || !response.ok) return;
    void response
      .clone()
      .text()
      .then((text) =>
        text.length <= MAX_REMEMBERED_BYTES ? store.setSetting(rememberKey(path), text) : undefined,
      )
      .catch(() => undefined);
  }

  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      globalThis.location.origin,
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (url.origin !== globalThis.location.origin || !url.pathname.startsWith('/api/v1/'))
      return deps.inner(input, init);

    let unreachable: Response | null = null;
    if (!deps.isBootOffline()) {
      try {
        const response = await deps.inner(input, init);
        if (!(method === 'GET' && GATEWAY_DOWN.has(response.status) && deps.store() !== null)) {
          deps.onReachability(true);
          const store = deps.store();
          if (store !== null && method === 'GET') remember(store, url.pathname, response);
          return response;
        }
        unreachable = response;
      } catch (error) {
        if (
          init?.signal?.aborted === true ||
          (error as { name?: unknown } | null)?.name === 'AbortError'
        )
          throw error;
        deps.onReachability(false);
        if (deps.store() === null) throw error;
      }
      if (unreachable !== null) deps.onReachability(false);
    }

    const store = deps.store();
    if (store === null) {
      return unreachable ?? problem(503, 'offline.unavailable', 'Nix cannot reach the server.');
    }
    if (method !== 'GET')
      return problem(
        503,
        'offline.read_only',
        'You are offline. This change needs a connection and was not made.',
      );
    const local = await answer(store, url).catch(() => null);
    return (
      local ?? unreachable ?? problem(503, 'offline.unavailable', 'This is not available offline.')
    );
  };
}
