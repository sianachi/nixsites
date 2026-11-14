import type { MirrorItem } from '@nix/sync-core/mirror';
import type { SqliteMirrorStore } from '@nix/sync-sqlite';

import { computeView, type ViewAnswer, type ViewRequest } from '@nix/view-compute';

import { planWrite, type PlannedWrite } from './mirror-writes';
import { planViewWrite } from './view-writes';
import { closedByPassword } from './workspace-closed';

/**
 * Core, answered from the iOS shell's synced copy. The API client's `fetch` goes through
 * `createMirrorFetch` there: the network first, the mirror when the network is gone (or when the
 * app opened offline). Reads the app needs to browse are answered, in Core's JSON shapes. Create,
 * rename, move, trash and property edits are queued for replay (see `mirror-writes.ts`) and
 * answered as Core would; everything else says plainly that it needs a connection. Nothing here
 * runs in a browser.
 */

export type MirrorReader = Pick<
  SqliteMirrorStore,
  | 'readItems'
  | 'listItems'
  | 'searchItems'
  | 'readWorkspaceList'
  | 'getSetting'
  | 'setSetting'
  | 'enqueue'
  | 'listOutbox'
> & { subscribe(listener: () => void): () => void };

export interface MirrorFetchDeps {
  readonly inner: typeof fetch;
  /** The admitted mirror, or null when there is none (or admission is closed). */
  readonly store: () => MirrorReader | null;
  /** The principal the mirror belongs to, for computed reads that name the caller (`me`). */
  readonly principalId?: () => string | null;
  readonly readFile: (itemId: string, versionId: string) => Promise<Uint8Array | null>;
  readonly isBootOffline: () => boolean;
  /** Told whether the last call to Core got an answer, for the offline indicator. */
  readonly onReachability: (up: boolean) => void;
  readonly createBlobUrl?: (bytes: Uint8Array, mediaType: string) => string;
  /**
   * Told when an unlock succeeded. Core's change feed does not announce unlocks (a grant belongs to
   * one credential), so this device rebuilds the workspace from a fresh snapshot to see under it.
   */
  readonly onUnlocked?: (itemId: string) => void;
}

type Json = Record<string, unknown>;

function storedViews(value: unknown) {
  const raw = isRecord(value) ? value : {};
  const listed = (Array.isArray(raw.views) ? raw.views : []).filter(
    (view): view is Json =>
      isRecord(view) &&
      typeof view.id === 'string' &&
      typeof view.name === 'string' &&
      typeof view.kind === 'string',
  );
  const views = listed.filter(
    (view, index) => listed.findIndex((other) => other.id === view.id) === index,
  );
  // A missing default opens the document, or the first view if the document tab is hidden.
  const hideDocument = raw.hideDocument === true && views.length > 0;
  const mainView =
    views.find((view) => view.id === raw.default) ?? (hideDocument ? views[0] : undefined);
  return { views, hideDocument, mainView };
}

/** Small account-level reads the app makes at boot; kept from the last online run. */
export const REMEMBERED = new Set([
  '/api/v1/me',
  '/api/v1/me/preferences',
  '/api/v1/me/ui-settings',
  '/api/v1/me/workspace-arrangement',
]);
export const WORKSPACES_SETTING = 'offline.workspaces';
export const PROTECTED_SETTING = 'offline.protected-workspaces';
export const rememberKey = (path: string): string => `offline.cache:${path}`;
const MAX_REMEMBERED_BYTES = 256 * 1024;

/** Core's inline rule: only these are ever served as themselves (never html, svg or script types). */
const INLINE_TYPES =
  /^(image\/(png|jpeg|gif|webp|avif|heic|heif)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|aac|wav|ogg|flac|webm)|application\/pdf)$/;
const isInlineType = (mediaType: string): boolean => INLINE_TYPES.test(mediaType);

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

/** A stored schema's properties in Core's response shape (stored entries omit empty fields). */
const definitions = (schema: Json | null): Json[] =>
  (isRecord(schema) && Array.isArray(schema.properties) ? schema.properties : [])
    .filter(
      (entry): entry is Json =>
        isRecord(entry) &&
        typeof entry.key === 'string' &&
        entry.key !== '' &&
        typeof entry.type === 'string',
    )
    .map((entry) => ({
      key: entry.key,
      label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.key,
      type: entry.type,
      options: Array.isArray(entry.options) ? entry.options : [],
      required: entry.required === true,
      choiceSource: entry.choiceSource ?? null,
      expression: entry.expression ?? null,
      aggregate: entry.aggregate ?? null,
      source: entry.source ?? null,
    }));

/**
 * A create sent online carries an idempotency key, so when the answer is lost after Core committed
 * the replay queued from the same request reuses it and Core de-duplicates.
 */
function withCreateKey(
  method: string,
  url: URL,
  init: RequestInit | undefined,
): RequestInit | undefined {
  if (
    method !== 'POST' ||
    typeof init?.body !== 'string' ||
    !/^\/api\/v1\/workspaces\/[^/]+\/items$/.test(url.pathname)
  )
    return init;
  try {
    const body: unknown = JSON.parse(init.body);
    return isRecord(body) && body.idempotencyKey === undefined
      ? { ...init, body: JSON.stringify({ ...body, idempotencyKey: crypto.randomUUID() }) }
      : init;
  } catch {
    return init;
  }
}

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
    defaultViewKind: storedViews(item.views).mainView?.kind ?? null,
    hasChildren: (index.byParent.get(item.id)?.length ?? 0) > 0,
    seq: item.seq,
    lifecycleState: item.lifecycleState,
    properties: item.properties,
    computed: item.computedProperties,
    noDelete: item.noDelete,
    noChildren: item.noChildren,
    ...(item.settings ? { settings: item.settings } : {}),
    managedBy: item.managedBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt ?? item.createdAt,
  });

  /**
   * The workspaces a password keeps closed on this device, whose items, search hits and files are
   * not served. The mirror keeps their data, so queued edits survive to be sent after an unlock.
   *
   * A workspace is closed when the cached list says so (protected, with no unlock still running by
   * the clock). Where the list does not state a workspace's password - the list is unreadable, or
   * has no entry for it - the separately recorded protected ids decide: a workspace recorded as
   * protected stays closed (its unlock state is unknown, so it is not trusted), and one that is
   * not recorded is open, so ordinary workspaces keep working offline. If the recorded ids are
   * present but unreadable, every workspace the list does not state is treated as closed. If they
   * were never recorded (a device that has not synced since this was added), nothing is known to
   * be protected and nothing is closed.
   */
  async function closedWorkspaceIds(store: MirrorReader): Promise<Set<string>> {
    const closed = new Set<string>();
    const stated = new Set<string>();
    try {
      const raw = await store.getSetting(WORKSPACES_SETTING);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      for (const entry of Array.isArray(parsed) ? parsed.filter(isRecord) : []) {
        const id = String(entry.id);
        stated.add(id);
        if (
          closedByPassword({
            passwordProtected: entry.passwordProtected === true,
            unlockedUntil: typeof entry.unlockedUntil === 'string' ? entry.unlockedUntil : null,
          })
        )
          closed.add(id);
      }
    } catch {
      /* An unreadable list states nothing; the recorded ids below decide. */
    }
    const recorded = await store.getSetting(PROTECTED_SETTING).catch(() => null);
    if (recorded === null) return closed;
    try {
      const ids: unknown = JSON.parse(recorded);
      for (const id of Array.isArray(ids) ? ids : [])
        if (!stated.has(String(id))) closed.add(String(id));
    } catch {
      for (const workspace of await store.readWorkspaceList())
        if (!stated.has(workspace.id)) closed.add(workspace.id);
    }
    return closed;
  }

  /** A closed workspace as the list shows it: its name and that it is locked, nothing else. */
  const closedEntry = (workspace: Json): Json => ({
    id: workspace.id,
    name: workspace.name,
    versionRetentionDays: 0,
    storageQuotaBytes: 0,
    createdAt: new Date(0).toISOString(),
    kind: workspace.kind === 'shared' ? 'shared' : 'personal',
    canRename: false,
    canManageMembers: false,
    canLeave: false,
    canUseDailyNotes: false,
    pendingInvitationId: null,
    lifecycleState:
      typeof workspace.lifecycleState === 'string' ? workspace.lifecycleState : 'active',
    archivedAt: null,
    membershipLocked: false,
    collaboration: false,
    passwordProtected: true,
    unlockedUntil: null,
  });

  async function cachedWorkspaces(store: MirrorReader): Promise<Json[]> {
    const closed = await closedWorkspaceIds(store);
    return (await readCachedWorkspaces(store)).map((workspace) =>
      closed.has(String(workspace.id)) ? closedEntry(workspace) : workspace,
    );
  }

  async function readCachedWorkspaces(store: MirrorReader): Promise<Json[]> {
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

  /** `{ [key]: value }`, or nothing when the value is unknown (optional fields stay absent). */
  const withDefined = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
    value === undefined ? {} : ({ [key]: value } as Record<K, V>);

  /** The caller's zone from the last preferences Core sent; undefined when never cached. */
  async function cachedTimeZone(store: MirrorReader): Promise<string | null | undefined> {
    const kept = await store.getSetting(rememberKey('/api/v1/me/preferences'));
    if (kept === null) return undefined;
    try {
      const zone = (JSON.parse(kept) as { timeZone?: unknown }).timeZone;
      return typeof zone === 'string' && zone !== '' ? zone : null;
    } catch {
      return undefined;
    }
  }

  /** Core's computed reads (queries, charts, calendar, habits), recalculated offline. */
  async function computed(store: MirrorReader, request: ViewRequest): Promise<Response | null> {
    const closed = await closedWorkspaceIds(store);
    const answered: ViewAnswer | null = await computeView(
      {
        item: async (id) => {
          const found = (await store.readItems([id]))[0];
          return found !== undefined && closed.has(found.workspaceId) ? undefined : found;
        },
        workspaceItems: async (workspaceId) =>
          closed.has(workspaceId)
            ? []
            : [...(await workspaceIndex(store, workspaceId)).byParent.values()].flat(),
        now: () => new Date(),
        ...withDefined('principalId', deps.principalId?.() ?? undefined),
        ...withDefined('timeZone', await cachedTimeZone(store)),
        workspaceIds: async () =>
          (await store.readWorkspaceList())
            .map((entry) => entry.id)
            .filter((id) => !closed.has(id)),
      },
      request,
    );
    if (answered === null) return null;
    return 'body' in answered
      ? json(answered.body)
      : problem(answered.status, answered.code, answered.detail);
  }

  async function answer(store: MirrorReader, url: URL): Promise<Response | null> {
    const path = url.pathname;
    const query = url.searchParams;

    const viewAnswer = await computed(store, { method: 'GET', url, body: null });
    if (viewAnswer !== null) return viewAnswer;

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

    const closed = await closedWorkspaceIds(store);

    const listMatch = /^\/api\/v1\/workspaces\/([^/]+)\/items$/.exec(path);
    if (listMatch?.[1] !== undefined) {
      if (closed.has(listMatch[1]))
        return problem(404, 'workspaces.not_found', 'This workspace is locked.');
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
          if (!closed.has(workspace.id))
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

    const itemMatch =
      /^\/api\/v1\/items\/([^/]+)(?:\/(schema|views|lock|file\/download|file\/thumbnail|file))?$/.exec(
        path,
      );
    if (itemMatch?.[1] === undefined) return null;
    const item = (await store.readItems([itemMatch[1]]))[0];
    if (item?.lifecycleState !== 'active' || closed.has(item.workspaceId))
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
      // Core's rules (SchemaResolver): walk from the item outwards, nearer wins per key and keeps
      // the farther position, an item declaring `inherit: false` is the last to contribute.
      // shortcut: choice sources, formulas and rollups are passed through as stored, not
      // re-validated. Upgrade if offline forms look wrong.
      const own = definitions(item.schema);
      const inherit = !isRecord(item.schema) || item.schema.inherit !== false;
      const properties = new Map<string, Json>();
      const layers: Json[][] = [];
      for (const level of await chain(store, item)) {
        layers.unshift(definitions(level.schema));
        if (isRecord(level.schema) && level.schema.inherit === false) break;
      }
      for (const layer of layers)
        for (const property of layer) properties.set(String(property.key), property);
      return json({ properties: [...properties.values()], declared: own, inherit });
    }

    if (part === 'views') {
      const { views, hideDocument, mainView } = storedViews(item.views);
      return json({
        views,
        // shortcut: whether a view's property still exists is not re-derived offline.
        unrenderable: [],
        default: mainView?.id ?? 'document',
        hideDocument,
        version: null,
      });
    }

    // file: the one version the copy holds, as Core's file record.
    if (part === 'file') {
      const stored = item.file;
      if (stored === null || item.locked)
        return problem(404, 'file.not_found', 'This file is not in the synced copy.');
      const version = {
        id: stored.versionId,
        // shortcut: only the current version is mirrored, so history reads as version 1.
        version: 1,
        fileName: stored.fileName,
        mediaType: stored.mediaType,
        byteLength: stored.byteLength,
        sha256: stored.sha256,
        previewable: isInlineType(stored.mediaType),
        pixelWidth: null,
        pixelHeight: null,
        createdAt: item.createdAt,
        current: true,
        thumbnail: null,
      };
      return json({
        itemId: item.id,
        workspaceId: item.workspaceId,
        current: version,
        versions: [version],
      });
    }

    // file/download and file/thumbnail: a capability whose url is a blob of the downloaded bytes.
    const file = item.file;
    const wanted = query.get('versionId');
    if (file === null || item.locked || (wanted !== null && wanted !== file.versionId))
      return problem(404, 'file.not_found', 'This file version is not in the synced copy.');
    // Only the full file is stored. An image stands in for its thumbnail; anything else has none,
    // which is Core's own answer for a file without one.
    if (
      part === 'file/thumbnail' &&
      !(file.mediaType.startsWith('image/') && isInlineType(file.mediaType))
    )
      return problem(404, 'file.not_found', 'This file has no thumbnail in the synced copy.');
    const bytes = await deps.readFile(item.id, file.versionId);
    if (bytes === null)
      return problem(
        503,
        'offline.unavailable',
        'This file has not been downloaded to this device yet.',
      );
    // Core's download rule: the stored type and inline only for a preview of a previewable type;
    // anything else is an attachment, so an uploaded html file never becomes a document here.
    const inline =
      part === 'file/thumbnail' ||
      (query.get('preview') === 'true' && isInlineType(file.mediaType));
    const servedType = inline ? file.mediaType : 'application/octet-stream';
    const blobUrl =
      deps.createBlobUrl?.(bytes, servedType) ??
      URL.createObjectURL(new Blob([bytes.slice().buffer], { type: servedType }));
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    // shortcut: the thumbnail's size is not known without decoding the image, and the app reads
    // only its bytes; give real dimensions if a screen ever lays out by them.
    if (part === 'file/thumbnail')
      return json({ url: blobUrl, expiresAt, width: 1, height: 1, byteLength: file.byteLength });
    return json({
      url: blobUrl,
      expiresAt,
      fileName: file.fileName,
      mediaType: servedType,
      byteLength: file.byteLength,
      sha256: file.sha256,
      inline,
      unscanned: true,
      noSniff: true,
    });
  }

  /** Queues a supported write for replay and answers with the item as Core would. */
  async function write(store: MirrorReader, plan: PlannedWrite): Promise<Response> {
    // A workspace a password has closed takes no new edits on this device either: nothing of it is
    // shown, so nothing should be typed into it. What is already queued stays queued.
    const closed = await closedWorkspaceIds(store);
    const target =
      plan.kind === 'create'
        ? plan.workspaceId
        : (await store.readItems([plan.itemId]))[0]?.workspaceId;
    if (target !== undefined && closed.has(target))
      return problem(
        423,
        'workspaces.locked',
        'This workspace is locked. Unlock it to make changes.',
      );
    const respondWith = async (itemId: string, status = 200): Promise<Response> => {
      indexes.clear();
      const found = (await store.readItems([itemId]))[0];
      return found === undefined
        ? problem(404, 'item.not_found', 'This item is not in the synced copy.')
        : new Response(
            JSON.stringify(toItem(found, await workspaceIndex(store, found.workspaceId))),
            {
              status,
              headers: { 'Content-Type': 'application/json' },
            },
          );
    };
    // A temporary id that has since been replaced by the server's resolves to the real item.
    const real = async (id: string | null): Promise<string | null> =>
      id === null ? null : ((await store.readItems([id]))[0]?.id ?? id);
    try {
      if (plan.kind === 'create') {
        const operationId = plan.key ?? crypto.randomUUID();
        // A retry of a create whose answer was lost finds the one already queued.
        const queued = (await store.listOutbox(plan.workspaceId)).find(
          (entry) => entry.operationId === operationId,
        );
        if (queued !== undefined) return await respondWith(queued.itemId, 201);
        const itemId = crypto.randomUUID();
        await store.enqueue(plan.workspaceId, {
          kind: 'create',
          operationId,
          itemId,
          payload: {
            type: plan.type,
            title: plan.title,
            parentId: await real(plan.parentId),
            ...(plan.properties === undefined ? {} : { properties: { ...plan.properties } }),
          },
        });
        return await respondWith(itemId, 201);
      }
      const item = (await store.readItems([plan.itemId]))[0];
      if (item === undefined)
        return problem(404, 'item.not_found', 'This item is not in the synced copy.');
      const base = {
        operationId: crypto.randomUUID(),
        itemId: item.id,
        expectedRevision: item.revision,
      };
      if (plan.kind === 'rename')
        await store.enqueue(item.workspaceId, {
          ...base,
          kind: 'rename',
          payload: { title: plan.title },
        });
      else if (plan.kind === 'move')
        await store.enqueue(item.workspaceId, {
          ...base,
          kind: 'move',
          payload: { parentId: await real(plan.parentId), afterId: await real(plan.afterId) },
        });
      else if (plan.kind === 'properties')
        await store.enqueue(item.workspaceId, {
          ...base,
          kind: 'properties',
          payload: { changes: { ...plan.changes } },
        });
      else {
        await store.enqueue(item.workspaceId, { ...base, kind: 'archive', payload: {} });
        indexes.clear();
        return new Response(null, { status: 204 });
      }
      return await respondWith(item.id);
    } catch (error) {
      return problem(
        403,
        'offline.not_allowed',
        error instanceof Error && error.message !== ''
          ? `${error.message}. This change was not made offline.`
          : 'This change cannot be made offline.',
      );
    }
  }

  /** Local ids the server has since replaced, found in a request's path, query and body. */
  async function withServerIds(
    store: MirrorReader,
    url: URL,
    init: RequestInit | undefined,
  ): Promise<{ url: URL; init: RequestInit | undefined } | null> {
    const map = new Map<string, string>();
    const resolve = async (id: string | null): Promise<void> => {
      if (id === null || map.has(id) || !/^[0-9a-fA-F-]{36}$/.test(id)) return;
      const found = (await store.readItems([id]))[0];
      if (found !== undefined && found.id !== id) map.set(id, found.id);
    };
    const body = typeof init?.body === 'string' ? init.body : null;
    let parsed: Json | null = null;
    try {
      const value: unknown = body === null ? null : JSON.parse(body);
      parsed = isRecord(value) ? value : null;
    } catch {
      /* A body that is not JSON carries no ids of ours. */
    }
    for (const segment of url.pathname.split('/')) await resolve(segment);
    await resolve(url.searchParams.get('parentId'));
    for (const key of ['parentId', 'afterId'])
      await resolve(typeof parsed?.[key] === 'string' ? parsed[key] : null);
    if (map.size === 0) return null;
    const swap = (text: string): string => {
      let out = text;
      for (const [from, to] of map) out = out.split(from).join(to);
      return out;
    };
    const next = new URL(swap(url.href));
    return {
      url: next,
      init: body === null || init === undefined ? init : { ...init, body: swap(body) },
    };
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

  return async (input, sentInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      globalThis.location.origin,
    );
    const method = (
      sentInit?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const init = withCreateKey(method, url, sentInit);
    if (url.origin !== globalThis.location.origin) return deps.inner(input, init);
    if (!url.pathname.startsWith('/api/v1/'))
      // Opened on the synced copy the session is a placeholder: nothing else may reach the network.
      return deps.isBootOffline()
        ? problem(503, 'offline.unavailable', 'This is not available offline.')
        : deps.inner(input, init);

    let unreachable: Response | null = null;
    if (!deps.isBootOffline()) {
      try {
        const response = await deps.inner(input, init);
        if (!(method === 'GET' && GATEWAY_DOWN.has(response.status) && deps.store() !== null)) {
          deps.onReachability(true);
          const unlocked = /^\/api\/v1\/items\/([^/]+)\/unlock$/.exec(url.pathname)?.[1];
          if (method === 'POST' && response.ok && unlocked !== undefined)
            deps.onUnlocked?.(unlocked);
          const store = deps.store();
          if (store !== null && method === 'GET') remember(store, url.pathname, response);
          // A screen still addressing an item by the temporary id it was created under, after the
          // server's replacement landed: ask again with the real one.
          if (
            store !== null &&
            !(input instanceof Request) &&
            [400, 404, 409, 422].includes(response.status)
          ) {
            const swapped = await withServerIds(store, url, init).catch(() => null);
            if (swapped !== null) return await deps.inner(swapped.url.href, swapped.init);
          }
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
    if (method !== 'GET') {
      let body: unknown = null;
      try {
        body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      } catch {
        /* An unreadable body is not a write we can queue. */
      }
      if (method === 'POST') {
        const read = await computed(store, { method: 'POST', url, body }).catch(() => null);
        if (read !== null) return read;
      }
      const plan =
        planWrite(method, url.pathname, body) ??
        (await planViewWrite(store, method, url.pathname, body).catch(() => null));
      return plan === null
        ? problem(
            503,
            'offline.read_only',
            'You are offline. This change needs a connection and was not made.',
          )
        : write(store, plan);
    }
    const local = await answer(store, url).catch(() => null);
    return (
      local ?? unreachable ?? problem(503, 'offline.unavailable', 'This is not available offline.')
    );
  };
}
