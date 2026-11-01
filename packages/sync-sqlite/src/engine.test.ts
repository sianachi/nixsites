import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MirrorAccessRevokedError,
  runSyncPass,
  type BodySyncRequest,
  type BodySyncResponse,
  type MirrorApi,
  type MirrorBody,
  type MirrorItem,
  type NativeChangesPage,
  type NativeReplayResult,
  type NativeSnapshotPage,
  type OutboxOperation,
} from '@nix/sync-core/mirror';
import { fromByteArray, toByteArray } from '@nix/sync-core/base64';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { SqliteDriver } from './driver.js';
import { openSqliteMirror, type SqliteMirrorStore } from './mirror.js';
import { createNodeSqliteDriver } from './testing/node-driver.js';

function id(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}

const workspaceId = id(1);
const serverTime = '2026-10-13T20:00:00Z';
const scope = { serverOrigin: 'https://nix.example', tenantId: id(2), principalId: id(3) };

function item(input: Partial<MirrorItem> = {}): MirrorItem {
  return {
    id: id(10),
    workspaceId,
    parentId: null,
    type: 'note',
    title: 'A note',
    seq: 1000,
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
    createdAt: serverTime,
    updatedAt: serverTime,
    canWrite: true,
    locked: false,
    canPersistBody: true,
    metadataExpiresAt: null,
    bodyDocId: null,
    bodyHeadSeq: null,
    file: null,
    ...input,
  };
}

class FakeApi implements MirrorApi {
  readonly items = new Map<string, MirrorItem>();
  readonly bodies = new Map<string, { doc: Y.Doc; docId: string; headSeq: bigint }>();
  readonly receipts = new Map<string, NativeReplayResult>();
  readonly replayed: OutboxOperation[] = [];
  readonly bodyRequests: BodySyncRequest[] = [];
  revision = 1n;
  private nextId = 1000;

  constructor(items: MirrorItem[] = [item()]) {
    for (const value of items) this.items.set(value.id, value);
  }

  snapshot(input: Parameters<MirrorApi['snapshot']>[0]): Promise<unknown> {
    if (input.workspaceId !== workspaceId) return Promise.reject(new Error('Unexpected workspace'));
    return Promise.resolve({
      boundary: this.revision.toString(),
      nextCursor: null,
      complete: true,
      resync: false,
      items: [...this.items.values()],
      serverTime,
    } satisfies NativeSnapshotPage);
  }

  changes(input: Parameters<MirrorApi['changes']>[0]): Promise<unknown> {
    return Promise.resolve({
      cursor: this.revision.toString(),
      hasMore: false,
      resync: false,
      items: [...this.items.values()].filter(
        (value) => BigInt(value.revision) > BigInt(input.after),
      ),
      serverTime,
    } satisfies NativeChangesPage);
  }

  reconcile(input: Parameters<MirrorApi['reconcile']>[0]): Promise<unknown> {
    const items: MirrorItem[] = [];
    const removed: { itemId: string; reason: 'inaccessible' }[] = [];
    for (const itemId of input.itemIds) {
      const value = this.items.get(itemId);
      if (value === undefined) removed.push({ itemId, reason: 'inaccessible' });
      else items.push(value);
    }
    return Promise.resolve({ items, removed, serverTime });
  }

  replay(input: Parameters<MirrorApi['replay']>[0]): Promise<unknown> {
    const { operation } = input;
    this.replayed.push(operation);
    const prior = this.receipts.get(operation.operationId);
    if (prior !== undefined) return Promise.resolve(prior);
    let value = this.items.get(operation.itemId);
    if (operation.kind === 'create' || operation.kind === 'daily-note') {
      const serverId = id(this.nextId++);
      this.revision++;
      value = item({
        id: serverId,
        title: operation.kind === 'create' ? operation.payload.title : operation.payload.date,
        parentId: operation.kind === 'create' ? operation.payload.parentId : null,
        type: operation.kind === 'create' ? operation.payload.type : 'note',
        properties: operation.kind === 'create' ? (operation.payload.properties ?? {}) : {},
        revision: this.revision.toString(),
      });
      this.items.set(serverId, value);
    } else {
      if (value === undefined) {
        return Promise.resolve({
          operationId: operation.operationId,
          status: 'refused',
          itemId: operation.itemId,
          revision: null,
          item: null,
          code: 'inaccessible',
        } satisfies NativeReplayResult);
      }
      if (operation.expectedRevision !== value.revision) {
        return Promise.resolve({
          operationId: operation.operationId,
          status: 'conflict',
          itemId: value.id,
          revision: value.revision,
          item: value,
          code: 'revision_changed',
        } satisfies NativeReplayResult);
      }
      this.revision++;
      switch (operation.kind) {
        case 'rename':
          value = { ...value, title: operation.payload.title };
          break;
        case 'move':
          value = { ...value, parentId: operation.payload.parentId };
          break;
        case 'properties':
          value = { ...value, properties: { ...value.properties, ...operation.payload.changes } };
          break;
        case 'archive': {
          this.items.delete(value.id);
          const result: NativeReplayResult = {
            operationId: operation.operationId,
            status: 'applied',
            itemId: value.id,
            revision: this.revision.toString(),
            item: null,
            code: null,
          };
          this.receipts.set(operation.operationId, result);
          return Promise.resolve(result);
        }
      }
      value = { ...value, revision: this.revision.toString() };
      this.items.set(value.id, value);
    }
    const result: NativeReplayResult = {
      operationId: operation.operationId,
      status: 'applied',
      itemId: value.id,
      revision: value.revision,
      item: value,
      code: null,
    };
    this.receipts.set(operation.operationId, result);
    return Promise.resolve(result);
  }

  syncBodies(input: BodySyncRequest): Promise<unknown> {
    this.bodyRequests.push(input);
    const documents: BodySyncResponse['documents'] = [];
    for (const requested of input.documents) {
      const metadata = this.items.get(requested.itemId);
      if (!metadata?.canPersistBody) {
        documents.push({ itemId: requested.itemId, status: 'forbidden' });
        continue;
      }
      let body = this.bodies.get(requested.itemId);
      if (body === undefined) {
        body = { doc: new Y.Doc(), docId: metadata.bodyDocId ?? id(this.nextId++), headSeq: 0n };
        this.bodies.set(requested.itemId, body);
      }
      if (requested.expectedDocId !== undefined && requested.expectedDocId !== body.docId) {
        documents.push({ itemId: requested.itemId, status: 'rejected', code: 'document_changed' });
        continue;
      }
      for (const update of requested.updates ?? []) {
        Y.applyUpdate(body.doc, toByteArray(update.update));
        body.headSeq++;
      }
      this.items.set(metadata.id, {
        ...metadata,
        bodyDocId: body.docId,
        bodyHeadSeq: body.headSeq.toString(),
      });
      documents.push({
        itemId: requested.itemId,
        status: 'ok',
        docId: body.docId,
        headSeq: body.headSeq.toString(),
        schemaVersion: 1,
        canWrite: metadata.canWrite,
        update: fromByteArray(Y.encodeStateAsUpdate(body.doc, toByteArray(requested.stateVector))),
        stateVector: fromByteArray(Y.encodeStateVector(body.doc)),
        acknowledgedClientIds: requested.updates?.map((update) => update.clientId) ?? [],
      });
    }
    return Promise.resolve({ documents } satisfies BodySyncResponse);
  }

  editBody(itemId: string, edit: (doc: Y.Doc) => void): void {
    const body = this.bodies.get(itemId);
    const metadata = this.items.get(itemId);
    if (body === undefined || metadata === undefined) throw new Error('Missing server body');
    edit(body.doc);
    body.headSeq++;
    this.revision++;
    this.items.set(itemId, {
      ...metadata,
      bodyHeadSeq: body.headSeq.toString(),
      revision: this.revision.toString(),
    });
  }

  dispose(): void {
    for (const body of this.bodies.values()) body.doc.destroy();
  }
}

const directories: string[] = [];
const stores: SqliteMirrorStore[] = [];
const apis: FakeApi[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const api of apis.splice(0)) api.dispose();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function setup(
  api = new FakeApi(),
  driver?: SqliteDriver,
): Promise<{
  store: SqliteMirrorStore;
  api: FakeApi;
  path: string;
  reopen: () => Promise<SqliteMirrorStore>;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'nix-sync-engine-'));
  directories.push(directory);
  apis.push(api);
  const path = join(directory, 'mirror.sqlite');
  const selected = driver ?? createNodeSqliteDriver(path);
  const store = await openSqliteMirror({ driver: selected, scope });
  stores.push(store);
  return {
    store,
    api,
    path,
    async reopen() {
      await store.close();
      const reopened = await openSqliteMirror({ driver: selected, scope });
      stores.push(reopened);
      return reopened;
    },
  };
}

function sync(
  store: SqliteMirrorStore,
  api: MirrorApi,
  ownerId = 'foreground',
  now?: () => number,
): ReturnType<typeof runSyncPass> {
  return runSyncPass({ workspaceId, store, api, ownerId, ...(now === undefined ? {} : { now }) });
}

function hydrate(body: MirrorBody): Y.Doc {
  const doc = new Y.Doc();
  if (body.confirmedUpdate !== null) Y.applyUpdate(doc, body.confirmedUpdate);
  for (const pending of body.pending) Y.applyUpdate(doc, pending.update);
  return doc;
}

async function requireBody(store: SqliteMirrorStore, itemId = id(10)): Promise<MirrorBody> {
  const body = await store.readBody(workspaceId, itemId);
  if (body === null) throw new Error('Expected a mirrored body');
  return body;
}

describe('resumable sync engine with real SQLite', () => {
  it.each([
    'snapshot',
    'changes',
    'reconcile',
    'replay',
    'syncBodies',
  ] satisfies (keyof MirrorApi)[])(
    'resumes after a lost %s response with one created item and its pending edit intact',
    async (boundary) => {
      const { store, api, reopen } = await setup();
      const localId = id(20);
      const operationId = id(100);
      await store.enqueue(workspaceId, {
        operationId,
        itemId: localId,
        kind: 'create',
        payload: { type: 'note', title: 'Boundary-safe capture', parentId: null },
      });
      const local = new Y.Doc();
      try {
        local.getText('note').insert(0, 'Boundary-safe edit');
        await store.enqueueBodyUpdate(workspaceId, localId, {
          clientId: 'boundary-edit',
          update: Y.encodeStateAsUpdate(local),
        });
      } finally {
        local.destroy();
      }
      const fault = { fired: false };
      async function loseResponse(request: Promise<unknown>): Promise<unknown> {
        const response = await request;
        if (!fault.fired) {
          fault.fired = true;
          throw new Error(`Stopped after ${boundary}`);
        }
        return response;
      }
      switch (boundary) {
        case 'snapshot': {
          const send = api.snapshot.bind(api);
          api.snapshot = (input) => loseResponse(send(input));
          break;
        }
        case 'changes': {
          const send = api.changes.bind(api);
          api.changes = (input) => loseResponse(send(input));
          break;
        }
        case 'reconcile': {
          const send = api.reconcile.bind(api);
          api.reconcile = (input) => loseResponse(send(input));
          break;
        }
        case 'replay': {
          const send = api.replay.bind(api);
          api.replay = (input) => loseResponse(send(input));
          break;
        }
        case 'syncBodies': {
          const send = api.syncBodies.bind(api);
          api.syncBodies = (input) => loseResponse(send(input));
          break;
        }
      }
      await expect(sync(store, api)).rejects.toThrow(`Stopped after ${boundary}`);
      const reopened = await reopen();
      await sync(reopened, api);
      const canonical = await reopened.resolveItemId(workspaceId, localId);
      expect(canonical).not.toBe(localId);
      expect(api.items.size).toBe(2);
      expect(api.receipts.size).toBe(1);
      expect(await reopened.listOutbox(workspaceId)).toEqual([]);
      const body = await requireBody(reopened, canonical);
      expect(body.pending).toEqual([]);
      const restored = hydrate(body);
      try {
        expect(restored.getText('note').toJSON()).toBe('Boundary-safe edit');
      } finally {
        restored.destroy();
      }
    },
  );

  it('mirrors all admitted bodies and uses bounded document batches', async () => {
    const api = new FakeApi(Array.from({ length: 41 }, (_, index) => item({ id: id(index + 10) })));
    const { store } = await setup(api);
    const result = await sync(store, api);
    expect(result).toEqual({
      status: 'complete',
      cursor: '1',
      replayedOperations: 0,
      syncedBodies: 41,
      conflicts: 0,
    });
    expect(api.bodyRequests.map((request) => request.documents.length)).toEqual([20, 20, 1]);
    expect(await store.listItems(workspaceId)).toHaveLength(41);
    for (const value of api.items.values())
      expect((await requireBody(store, value.id)).docId).not.toBeNull();
  });

  it('resumes a paged bootstrap after a process dies without publishing partial rows', async () => {
    const first = item({ id: id(10) });
    const second = item({ id: id(11) });
    const api = new FakeApi([first, second]);
    const { store, reopen } = await setup(api);
    const calls: Parameters<MirrorApi['snapshot']>[0][] = [];
    let crash = true;
    api.snapshot = (input) => {
      calls.push(input);
      if (input.cursor === undefined)
        return Promise.resolve({
          boundary: '1',
          nextCursor: first.id,
          complete: false,
          resync: false,
          items: [first],
          serverTime,
        } satisfies NativeSnapshotPage);
      if (crash) return Promise.reject(new Error('Process stopped between pages'));
      return Promise.resolve({
        boundary: '1',
        nextCursor: null,
        complete: true,
        resync: false,
        items: [second],
        serverTime,
      } satisfies NativeSnapshotPage);
    };
    await expect(sync(store, api)).rejects.toThrow('Process stopped');
    expect(await store.listItems(workspaceId)).toEqual([]);
    expect(await store.getCheckpoint(workspaceId)).toMatchObject({
      cursor: null,
      snapshot: { boundary: '1', nextCursor: first.id },
    });
    crash = false;
    const reopened = await reopen();
    await sync(reopened, api);
    expect(calls.at(-1)).toEqual({ workspaceId, limit: 200, boundary: '1', cursor: first.id });
    expect((await reopened.listItems(workspaceId)).map((value) => value.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(await reopened.getCheckpoint(workspaceId)).toMatchObject({
      cursor: '1',
      snapshot: null,
    });
  });

  it('rolls back item writes and cursor together when the feed transaction fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nix-sync-fault-'));
    directories.push(directory);
    const actual = createNodeSqliteDriver(join(directory, 'mirror.sqlite'));
    let armed = false;
    const driver: SqliteDriver = {
      open() {
        const connection = actual.open();
        return {
          ...connection,
          transaction(work) {
            return connection.transaction(async (transaction) => {
              const fault = { sawChangedItem: false };
              const value = await work({
                execute(sql, parameters = []) {
                  if (
                    parameters.some(
                      (parameter) =>
                        typeof parameter === 'string' &&
                        parameter.includes('Feed transaction sentinel'),
                    )
                  )
                    fault.sawChangedItem = true;
                  return transaction.execute(sql, parameters);
                },
              });
              if (armed && fault.sawChangedItem) {
                armed = false;
                throw new Error('Crash before SQLite commit');
              }
              return value;
            });
          },
        };
      },
    };
    const { store, api, reopen } = await setup(new FakeApi(), driver);
    await sync(store, api);
    api.revision = 2n;
    api.items.set(id(10), { ...item(), title: 'Feed transaction sentinel', revision: '2' });
    armed = true;
    await expect(sync(store, api)).rejects.toThrow('Crash before SQLite commit');
    const reopened = await reopen();
    expect((await reopened.listItems(workspaceId))[0]?.title).toBe('A note');
    expect((await reopened.getCheckpoint(workspaceId)).cursor).toBe('1');
    await sync(reopened, api);
    expect((await reopened.listItems(workspaceId))[0]?.title).toBe('Feed transaction sentinel');
    expect((await reopened.getCheckpoint(workspaceId)).cursor).toBe('2');
  });

  it('holds one workspace lease and rejects a stale owner after takeover', async () => {
    const { store, api } = await setup();
    await sync(store, api);
    let clock = 1000;
    let release: () => void = () => {
      throw new Error('Gate not initialized');
    };
    let reached: () => void = () => {
      throw new Error('Gate not initialized');
    };
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const normal = api.changes.bind(api);
    let first = true;
    api.changes = async (input) => {
      if (first) {
        first = false;
        reached();
        await blocked;
      }
      return normal(input);
    };
    const foreground = sync(store, api, 'foreground', () => clock);
    await started;
    expect(await sync(store, api, 'background', () => clock)).toEqual({ status: 'busy' });
    clock = 62_000;
    expect((await sync(store, api, 'background', () => clock)).status).toBe('complete');
    release();
    expect(await foreground).toEqual({ status: 'busy' });
    expect((await store.getCheckpoint(workspaceId)).cursor).toBe('1');
  });

  it('retries an acknowledged create after a lost response, remaps IDs and preserves its body', async () => {
    const { store, api, reopen } = await setup(new FakeApi([]));
    const localId = id(20);
    const operationId = id(100);
    await store.enqueue(workspaceId, {
      operationId,
      itemId: localId,
      kind: 'create',
      payload: { type: 'note', title: 'Captured offline', parentId: null },
    });
    const local = new Y.Doc();
    try {
      local.getText('note').insert(0, 'Saved while offline');
      await store.enqueueBodyUpdate(workspaceId, localId, {
        clientId: 'capture-edit',
        update: Y.encodeStateAsUpdate(local),
      });
    } finally {
      local.destroy();
    }
    const realReplay = api.replay.bind(api);
    let crash = true;
    api.replay = async (input) => {
      const result = await realReplay(input);
      if (crash) {
        crash = false;
        throw new Error('Response lost after server commit');
      }
      return result;
    };
    await expect(sync(store, api)).rejects.toThrow('Response lost');
    expect((await store.listOutbox(workspaceId))[0]?.operationId).toBe(operationId);
    const reopened = await reopen();
    expect((await sync(reopened, api)).status).toBe('complete');
    expect(api.items.size).toBe(1);
    expect(api.replayed.map((operation) => operation.operationId)).toEqual([
      operationId,
      operationId,
    ]);
    const serverId = [...api.items.keys()][0];
    if (serverId === undefined) throw new Error('Missing canonical item');
    expect(await reopened.resolveItemId(workspaceId, localId)).toBe(serverId);
    expect(await reopened.listOutbox(workspaceId)).toEqual([]);
    const body = await requireBody(reopened, serverId);
    expect(body.pending).toEqual([]);
    const restored = hydrate(body);
    try {
      expect(restored.getText('note').toJSON()).toBe('Saved while offline');
    } finally {
      restored.destroy();
    }
  });

  it('replays FIFO edits with the revision returned by the previous operation', async () => {
    const parent = item({ id: id(11), title: 'Destination', canPersistBody: false });
    const { store, api } = await setup(new FakeApi([item(), parent]));
    await sync(store, api);
    await store.enqueue(workspaceId, {
      kind: 'rename',
      operationId: id(100),
      itemId: id(10),
      expectedRevision: '1',
      payload: { title: 'Renamed offline' },
    });
    await store.enqueue(workspaceId, {
      kind: 'move',
      operationId: id(101),
      itemId: id(10),
      expectedRevision: '1',
      payload: { parentId: parent.id },
    });
    const result = await sync(store, api);
    expect(result).toMatchObject({ status: 'complete', replayedOperations: 2, conflicts: 0 });
    expect(
      api.replayed.map((operation) =>
        operation.kind === 'create' ? null : operation.expectedRevision,
      ),
    ).toEqual(['1', '2']);
    expect((await store.listItems(workspaceId)).find((value) => value.id === id(10))).toMatchObject(
      { title: 'Renamed offline', parentId: parent.id, revision: '3' },
    );
  });

  it('keeps the server title and a visible conflict when an offline rename loses CAS', async () => {
    const { store, api } = await setup();
    await sync(store, api);
    await store.enqueue(workspaceId, {
      kind: 'rename',
      operationId: id(100),
      itemId: id(10),
      expectedRevision: '1',
      payload: { title: 'Offline title' },
    });
    api.revision = 2n;
    const current = api.items.get(id(10));
    if (current === undefined) throw new Error('Missing remote item');
    api.items.set(id(10), { ...current, revision: '2', title: 'Server title' });
    expect(await sync(store, api)).toMatchObject({
      status: 'partial',
      replayedOperations: 0,
      conflicts: 1,
    });
    expect((await store.listItems(workspaceId))[0]?.title).toBe('Server title');
    expect(await store.listOutbox(workspaceId)).toEqual([]);
    expect(await store.listConflicts(workspaceId)).toMatchObject([
      {
        kind: 'metadata',
        code: 'revision_changed',
        operation: { payload: { title: 'Offline title' } },
      },
    ]);
  });

  it('acks only uploaded body edits and preserves a concurrent local update across reopen', async () => {
    const { store, api, reopen } = await setup();
    await sync(store, api);
    api.editBody(id(10), (doc) => {
      doc.getText('note').insert(0, 'base');
    });
    await sync(store, api);
    const before = await requireBody(store);
    const local = hydrate(before);
    const updates: Uint8Array[] = [];
    local.on('update', (update: Uint8Array) => {
      updates.push(update);
    });
    try {
      local.getText('note').insert(local.getText('note').length, ' L');
      const first = updates.shift();
      if (first === undefined) throw new Error('Missing local delta');
      await store.enqueueBodyUpdate(workspaceId, id(10), { clientId: 'local-1', update: first });
      const original = api.syncBodies.bind(api);
      let interleave = true;
      api.syncBodies = async (request) => {
        if (interleave) {
          interleave = false;
          const remote = api.bodies.get(id(10));
          if (remote === undefined) throw new Error('Missing server document');
          api.editBody(id(10), (doc) => {
            doc.getText('note').insert(0, 'R ');
          });
          local.getText('note').insert(local.getText('note').length, ' N');
          const second = updates.shift();
          if (second === undefined) throw new Error('Missing concurrent delta');
          await store.enqueueBodyUpdate(workspaceId, id(10), {
            clientId: 'local-2',
            update: second,
          });
        }
        return original(request);
      };
      expect((await sync(store, api)).status).toBe('partial');
      const pending = await requireBody(store);
      expect(pending.pending.map((update) => update.clientId)).toEqual(['local-2']);
      const reopened = await reopen();
      await sync(reopened, api);
      const complete = await requireBody(reopened);
      expect(complete.pending).toEqual([]);
      const restored = hydrate(complete);
      try {
        const remote = api.bodies.get(id(10));
        if (remote === undefined) throw new Error('Missing server document');
        expect(restored.getText('note').toJSON()).toBe('R base L N');
        expect(remote.doc.getText('note').toJSON()).toBe('R base L N');
      } finally {
        restored.destroy();
      }
    } finally {
      local.destroy();
    }
  });

  it('retains pending bytes after the body upload commits but its response is lost', async () => {
    const { store, api } = await setup();
    await sync(store, api);
    const local = hydrate(await requireBody(store));
    try {
      local.getText('note').insert(0, 'Exactly once');
      await store.enqueueBodyUpdate(workspaceId, id(10), {
        clientId: 'edit-1',
        update: Y.encodeStateAsUpdate(local),
      });
      const actual = api.syncBodies.bind(api);
      let fail = true;
      api.syncBodies = async (request) => {
        const response = await actual(request);
        if (fail) {
          fail = false;
          throw new Error('Upload acknowledgement lost');
        }
        return response;
      };
      await expect(sync(store, api)).rejects.toThrow('acknowledgement lost');
      expect((await requireBody(store)).pending.map((update) => update.clientId)).toEqual([
        'edit-1',
      ]);
      await sync(store, api);
      expect((await requireBody(store)).pending).toEqual([]);
      expect(api.bodies.get(id(10))?.doc.getText('note').toJSON()).toBe('Exactly once');
    } finally {
      local.destroy();
    }
  });

  it('does not delete pending updates for an acknowledgement it never submitted', async () => {
    const { store, api } = await setup();
    await sync(store, api);
    const local = hydrate(await requireBody(store));
    try {
      local.getText('note').insert(0, 'Pending content');
      await store.enqueueBodyUpdate(workspaceId, id(10), {
        clientId: 'real-edit',
        update: Y.encodeStateAsUpdate(local),
      });
      const actual = api.syncBodies.bind(api);
      api.syncBodies = async (request) => {
        await actual(request);
        const remote = api.bodies.get(id(10));
        if (remote === undefined) throw new Error('Missing remote document');
        return {
          documents: [
            {
              itemId: id(10),
              status: 'ok',
              docId: remote.docId,
              headSeq: remote.headSeq.toString(),
              schemaVersion: 1,
              canWrite: true,
              update: fromByteArray(Y.encodeStateAsUpdate(remote.doc)),
              stateVector: fromByteArray(Y.encodeStateVector(remote.doc)),
              acknowledgedClientIds: ['unknown-edit'],
            },
          ],
        } satisfies BodySyncResponse;
      };
      await expect(sync(store, api)).rejects.toThrow('was not submitted');
      expect((await requireBody(store)).pending.map((update) => update.clientId)).toEqual([
        'real-edit',
      ]);
    } finally {
      local.destroy();
    }
  });

  it('converges under deterministic random ordering of local and server edits', async () => {
    const { store, api } = await setup();
    await sync(store, api);
    let random = 0xabcdef;
    const actual = api.syncBodies.bind(api);
    for (let round = 0; round < 20; round++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const order = random % 3;
      const remote = api.bodies.get(id(10));
      if (remote === undefined) throw new Error('Missing remote body');
      const local = hydrate(await requireBody(store));
      const update: { value: Uint8Array | null } = { value: null };
      local.on('update', (delta: Uint8Array) => {
        update.value = delta;
      });
      try {
        if (order === 0)
          api.editBody(id(10), (doc) => {
            doc.getText('note').insert(0, `R${round.toString()} `);
          });
        local.getText('note').insert(local.getText('note').length, `L${round.toString()} `);
        if (update.value === null) throw new Error('Missing generated local update');
        await store.enqueueBodyUpdate(workspaceId, id(10), {
          clientId: `round-${round.toString()}`,
          update: update.value,
        });
        api.syncBodies = async (request) => {
          if (order === 1)
            api.editBody(id(10), (doc) => {
              doc.getText('note').insert(0, `R${round.toString()} `);
            });
          const response = await actual(request);
          if (order === 2)
            api.editBody(id(10), (doc) => {
              doc.getText('note').insert(0, `R${round.toString()} `);
            });
          return response;
        };
        await sync(store, api);
      } finally {
        local.destroy();
      }
    }
    api.syncBodies = actual;
    await sync(store, api);
    const restored = hydrate(await requireBody(store));
    try {
      const remote = api.bodies.get(id(10));
      if (remote === undefined) throw new Error('Missing remote body');
      const text = restored.getText('note').toJSON();
      expect(text).toBe(remote.doc.getText('note').toJSON());
      const expected = Array.from({ length: 20 }, (_, round) => [
        `L${round.toString()}`,
        `R${round.toString()}`,
      ])
        .flat()
        .sort();
      expect(text.trim().split(/\s+/).sort()).toEqual(expected);
      expect((await requireBody(store)).pending).toEqual([]);
    } finally {
      restored.destroy();
    }
  });

  it('purges inaccessible known items rather than recovering their contents', async () => {
    const { store, api } = await setup();
    await sync(store, api);
    expect((await requireBody(store)).confirmedUpdate).not.toBeNull();
    api.items.delete(id(10));
    await sync(store, api);
    expect(await store.listItems(workspaceId)).toEqual([]);
    expect(await store.readBody(workspaceId, id(10))).toBeNull();
    expect(await store.listOutbox(workspaceId)).toEqual([]);
    expect(api.replayed).toEqual([]);
  });

  it('keeps the workspace sealed after a failed permission resync and resumes protected drafts', async () => {
    const { store, api, reopen } = await setup();
    await sync(store, api);
    await store.enqueue(workspaceId, {
      kind: 'rename',
      operationId: id(100),
      itemId: id(10),
      expectedRevision: '1',
      payload: { title: 'Draft title' },
    });
    const local = hydrate(await requireBody(store));
    try {
      local.getText('note').insert(0, 'Protected pending edit');
      await store.enqueueBodyUpdate(workspaceId, id(10), {
        clientId: 'protected-edit',
        update: Y.encodeStateAsUpdate(local),
      });
    } finally {
      local.destroy();
    }
    const changes = api.changes.bind(api);
    const snapshot = api.snapshot.bind(api);
    let invalidate = true;
    api.revision = 2n;
    api.changes = (input) => {
      if (invalidate) {
        invalidate = false;
        return Promise.resolve({
          cursor: '2',
          hasMore: false,
          resync: true,
          items: [],
          serverTime,
        } satisfies NativeChangesPage);
      }
      return changes(input);
    };
    api.snapshot = () => Promise.reject(new Error('Network stopped during permission rebuild'));
    await expect(sync(store, api)).rejects.toThrow('permission rebuild');
    expect((await store.getCheckpoint(workspaceId)).sealed).toBe(true);
    expect(await store.listItems(workspaceId)).toEqual([]);
    expect(await store.searchItems(workspaceId, 'note')).toEqual([]);
    expect(await store.readBody(workspaceId, id(10))).toBeNull();
    api.snapshot = snapshot;
    const reopened = await reopen();
    await sync(reopened, api);
    expect((await reopened.getCheckpoint(workspaceId)).sealed).toBe(false);
    expect((await reopened.listItems(workspaceId))[0]?.title).toBe('Draft title');
    const body = await requireBody(reopened);
    expect(body.pending).toEqual([]);
    const restored = hydrate(body);
    try {
      expect(restored.getText('note').toJSON()).toBe('Protected pending edit');
    } finally {
      restored.destroy();
    }
  });

  it('discards a snapshot invalidated by a lock before publishing its staged body metadata', async () => {
    const open = item();
    const locked = item({ canWrite: false, canPersistBody: false, locked: true, revision: '2' });
    const api = new FakeApi([locked]);
    api.revision = 2n;
    const { store } = await setup(api);
    let calls = 0;
    api.snapshot = (input) => {
      calls++;
      if (calls === 1)
        return Promise.resolve({
          boundary: '1',
          nextCursor: open.id,
          complete: false,
          resync: false,
          items: [open],
          serverTime,
        } satisfies NativeSnapshotPage);
      if (input.boundary === '1')
        return Promise.resolve({
          boundary: '2',
          nextCursor: null,
          complete: false,
          resync: true,
          items: [],
          serverTime,
        } satisfies NativeSnapshotPage);
      return Promise.resolve({
        boundary: '2',
        nextCursor: null,
        complete: true,
        resync: false,
        items: [locked],
        serverTime,
      } satisfies NativeSnapshotPage);
    };
    expect(await sync(store, api)).toMatchObject({ status: 'complete', syncedBodies: 0 });
    expect(await store.listItems(workspaceId)).toEqual([locked]);
    expect(api.bodyRequests).toEqual([]);
    expect(await store.getCheckpoint(workspaceId)).toMatchObject({
      sealed: false,
      cursor: '2',
      snapshot: null,
    });
  });

  it('purges an unreadable item when collab refuses its body without creating a recovery note', async () => {
    const { store, api } = await setup();
    await sync(store, api);
    await store.requestBody(workspaceId, id(10));
    api.syncBodies = (request) =>
      Promise.resolve({
        documents: request.documents.map((document) => ({
          itemId: document.itemId,
          status: 'forbidden',
        })),
      });
    expect(await sync(store, api)).toMatchObject({ status: 'partial', conflicts: 1 });
    expect(await store.listItems(workspaceId)).toEqual([]);
    expect(await store.readBody(workspaceId, id(10))).toBeNull();
    expect(api.replayed).toEqual([]);
  });

  it('removes only the revoked workspace while another workspace remains readable', async () => {
    const { store, api, path } = await setup();
    await sync(store, api);
    const otherWorkspace = id(9);
    const other = item({ id: id(90), workspaceId: otherWorkspace, title: 'Still authorized' });
    await store.applySnapshotPage(
      otherWorkspace,
      {
        boundary: '1',
        nextCursor: null,
        complete: true,
        resync: false,
        items: [other],
        serverTime,
      },
      true,
    );
    api.changes = () => Promise.reject(new MirrorAccessRevokedError('workspace'));
    expect(await sync(store, api)).toEqual({ status: 'revoked', scope: 'workspace' });
    expect(existsSync(path)).toBe(true);
    expect(await store.listItems(workspaceId)).toEqual([]);
    expect(await store.listItems(otherWorkspace)).toEqual([other]);
  });

  it('deletes the account SQLite files after final authentication refusal', async () => {
    const { store, api, path } = await setup();
    await sync(store, api);
    expect(existsSync(path)).toBe(true);
    api.changes = () => Promise.reject(new MirrorAccessRevokedError());
    expect(await sync(store, api)).toEqual({ status: 'revoked', scope: 'account' });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    await expect(store.listItems(workspaceId)).rejects.toThrow('no longer authorized');
  });
});
