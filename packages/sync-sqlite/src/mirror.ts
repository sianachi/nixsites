import {
  BODY_SYNC_LIMITS,
  MirrorAccessRevokedError,
  bodySyncFailureSchema,
  bodySyncSuccessSchema,
  mirrorScopeSchema,
  nativeChangesPageSchema,
  nativeItemSnapshotSchema,
  nativeReconcilePageSchema,
  nativeReplayResultSchema,
  nativeSnapshotPageSchema,
  outboxOperationSchema,
  type BodySyncFailure,
  type BodySyncSuccess,
  type LiveBodySyncSuccess,
  type MirrorBody,
  type MirrorCheckpoint,
  type MirrorConflict,
  type MirrorItem,
  type MirrorScope,
  type MirrorStore,
  type NativeChangesPage,
  type NativeReconcilePage,
  type NativeReplayResult,
  type NativeSnapshotPage,
  type OutboxOperation,
  type PendingBodyUpdate,
  type WorkspaceLease,
} from '@nix/sync-core/mirror';
import { toByteArray } from '@nix/sync-core/base64';
import * as Y from 'yjs';
import { z } from 'zod';
import type { SqliteConnection, SqliteDriver, SqliteTransaction } from './driver.js';

const textRows = z.array(z.object({ value: z.string() }));
const itemRows = z.array(z.object({ snapshot: z.string() }));
const blob = z.union([z.instanceof(ArrayBuffer), z.instanceof(Uint8Array)]);
const bodyRows = z.array(
  z.object({
    doc_id: z.string(),
    confirmed_update: blob,
    schema_version: z.number().int().positive(),
    head_seq: z.string().nullable(),
  }),
);
const pendingRows = z.array(z.object({ client_id: z.string(), update_blob: blob }));
const checkpointRows = z.array(
  z.object({
    cursor: z.string().nullable(),
    boundary: z.string().nullable(),
    next_cursor: z.string().nullable(),
    sealed: z.union([z.literal(0), z.literal(1)]),
  }),
);
const workspaceListSchema = z.array(z.object({ id: z.uuid(), name: z.string() }));

const schema = [
  'CREATE TABLE IF NOT EXISTS mirror_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS mirror_workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS mirror_checkpoint (workspace_id TEXT PRIMARY KEY, cursor TEXT, boundary TEXT, next_cursor TEXT, sealed INTEGER NOT NULL DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS mirror_lease (workspace_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at REAL NOT NULL)',
  'CREATE TABLE IF NOT EXISTS mirror_item (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, snapshot TEXT NOT NULL, expires_at REAL, local INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS mirror_item_workspace ON mirror_item (workspace_id, id)',
  'CREATE INDEX IF NOT EXISTS mirror_item_parent ON mirror_item (parent_id)',
  'CREATE INDEX IF NOT EXISTS mirror_item_expiry ON mirror_item (expires_at)',
  'CREATE TABLE IF NOT EXISTS mirror_stage (workspace_id TEXT NOT NULL, id TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(workspace_id, id))',
  'CREATE TABLE IF NOT EXISTS mirror_body (item_id TEXT PRIMARY KEY REFERENCES mirror_item(id) ON DELETE CASCADE ON UPDATE CASCADE, doc_id TEXT NOT NULL, confirmed_update BLOB NOT NULL, state_vector BLOB NOT NULL, head_seq TEXT, schema_version INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS mirror_body_request (item_id TEXT PRIMARY KEY REFERENCES mirror_item(id) ON DELETE CASCADE ON UPDATE CASCADE)',
  'CREATE TABLE IF NOT EXISTS mirror_pending (seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES mirror_item(id) ON DELETE CASCADE ON UPDATE CASCADE, doc_id TEXT, client_id TEXT NOT NULL UNIQUE, update_blob BLOB NOT NULL)',
  'CREATE TABLE IF NOT EXISTS mirror_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES mirror_item(id) ON DELETE CASCADE ON UPDATE CASCADE, operation_json TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS mirror_outbox_item ON mirror_outbox (workspace_id,item_id)',
  'CREATE TABLE IF NOT EXISTS mirror_conflict (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES mirror_item(id) ON DELETE CASCADE ON UPDATE CASCADE, kind TEXT NOT NULL, code TEXT NOT NULL, operation_json TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS mirror_conflict_recovery (conflict_id TEXT PRIMARY KEY REFERENCES mirror_conflict(id) ON DELETE CASCADE, update_blob BLOB NOT NULL)',
  'CREATE TABLE IF NOT EXISTS mirror_alias (local_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, server_id TEXT NOT NULL REFERENCES mirror_item(id) ON DELETE CASCADE ON UPDATE CASCADE)',
  'CREATE TABLE IF NOT EXISTS mirror_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE VIRTUAL TABLE IF NOT EXISTS mirror_search USING fts5(item_id UNINDEXED, title, body_text)',
  'CREATE TRIGGER IF NOT EXISTS mirror_item_deleted AFTER DELETE ON mirror_item BEGIN DELETE FROM mirror_search WHERE item_id=old.id; END',
];

function parseItem(value: string): MirrorItem {
  const decoded: unknown = JSON.parse(value);
  return nativeItemSnapshotSchema.parse(decoded);
}

function parseOperation(value: string): OutboxOperation {
  const decoded: unknown = JSON.parse(value);
  return outboxOperationSchema.parse(decoded);
}

function assertWorkspace(item: MirrorItem, workspaceId: string): void {
  if (item.workspaceId !== workspaceId) throw new Error('Mirror page belongs to another workspace');
}

async function rawItem(
  tx: SqliteTransaction,
  workspaceId: string,
  itemId: string,
): Promise<MirrorItem | null> {
  const rows = itemRows.parse(
    await tx.execute('SELECT snapshot FROM mirror_item WHERE workspace_id=? AND id=?', [
      workspaceId,
      itemId,
    ]),
  );
  const row = rows[0];
  return row ? parseItem(row.snapshot) : null;
}

async function purgeItem(
  tx: SqliteTransaction,
  workspaceId: string,
  itemId: string,
): Promise<void> {
  await tx.execute(
    'WITH RECURSIVE removed(id) AS (SELECT id FROM mirror_item WHERE workspace_id=? AND id=? UNION SELECT item.id FROM mirror_item item JOIN removed ON item.parent_id=removed.id WHERE item.workspace_id=?) DELETE FROM mirror_item WHERE id IN (SELECT id FROM removed)',
    [workspaceId, itemId, workspaceId],
  );
}

async function purgeBody(tx: SqliteTransaction, itemId: string): Promise<void> {
  await tx.execute('DELETE FROM mirror_body WHERE item_id=?', [itemId]);
  await tx.execute('DELETE FROM mirror_pending WHERE item_id=?', [itemId]);
  await tx.execute('DELETE FROM mirror_body_request WHERE item_id=?', [itemId]);
  await tx.execute("DELETE FROM mirror_conflict WHERE item_id=? AND kind='body'", [itemId]);
  await tx.execute("UPDATE mirror_search SET body_text='' WHERE item_id=?", [itemId]);
}

async function projectedTitle(tx: SqliteTransaction, item: MirrorItem): Promise<string> {
  const row = textRows.parse(
    await tx.execute(
      "SELECT operation_json AS value FROM mirror_outbox WHERE workspace_id=? AND item_id=? AND json_extract(operation_json,'$.kind')='rename' ORDER BY seq DESC LIMIT 1",
      [item.workspaceId, item.id],
    ),
  )[0];
  const operation = row ? parseOperation(row.value) : null;
  return operation?.kind === 'rename' ? operation.payload.title : item.title;
}

async function projectItems(
  tx: SqliteTransaction,
  workspaceId: string,
  items: MirrorItem[],
): Promise<MirrorItem[]> {
  const operations = textRows
    .parse(
      await tx.execute(
        'SELECT operation_json AS value FROM mirror_outbox WHERE workspace_id=? ORDER BY seq',
        [workspaceId],
      ),
    )
    .map((row) => parseOperation(row.value));
  const byItem = new Map<string, OutboxOperation[]>();
  for (const operation of operations) {
    const group = byItem.get(operation.itemId) ?? [];
    group.push(operation);
    byItem.set(operation.itemId, group);
  }
  return items.map((item) => {
    let current = item;
    for (const operation of byItem.get(item.id) ?? []) {
      switch (operation.kind) {
        case 'daily-note':
        case 'create':
          break;
        case 'rename':
          current = { ...current, title: operation.payload.title };
          break;
        case 'move':
          current = { ...current, parentId: operation.payload.parentId };
          break;
        case 'archive':
          current = { ...current, lifecycleState: 'archived' };
          break;
        case 'properties': {
          const properties = { ...current.properties };
          for (const [key, value] of Object.entries(operation.payload.changes)) {
            if (value === null) Reflect.deleteProperty(properties, key);
            else properties[key] = value;
          }
          current = {
            ...current,
            properties,
          };
          break;
        }
      }
    }
    return current;
  });
}

async function saveItem(tx: SqliteTransaction, item: MirrorItem, local = false): Promise<void> {
  if (item.canPersistBody) {
    const old = bodyRows.parse(
      await tx.execute(
        'SELECT doc_id,confirmed_update,schema_version,head_seq FROM mirror_body WHERE item_id=?',
        [item.id],
      ),
    )[0];
    const changedPending = pendingRows.parse(
      await tx.execute(
        'SELECT client_id,update_blob FROM mirror_pending WHERE item_id=? AND doc_id IS NOT NULL AND (? IS NULL OR doc_id<>?) ORDER BY seq',
        [item.id, item.bodyDocId, item.bodyDocId],
      ),
    );
    if (changedPending.length > 0) {
      const recovery = Y.mergeUpdates([
        ...(old ? [new Uint8Array(old.confirmed_update)] : []),
        ...changedPending.map((pending) => new Uint8Array(pending.update_blob)),
      ]);
      const conflictId = `body:${item.id}`;
      await tx.execute(
        "INSERT INTO mirror_conflict(id,workspace_id,item_id,kind,code,operation_json,created_at) VALUES(?,?,?,'body','document_changed',NULL,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code",
        [conflictId, item.workspaceId, item.id, new Date().toISOString()],
      );
      await tx.execute(
        'INSERT INTO mirror_conflict_recovery(conflict_id,update_blob) VALUES(?,?) ON CONFLICT(conflict_id) DO UPDATE SET update_blob=excluded.update_blob',
        [conflictId, recovery],
      );
    }
  }
  await tx.execute(
    'INSERT INTO mirror_item(id, workspace_id, parent_id, title, snapshot, expires_at, local) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id, parent_id=excluded.parent_id, title=excluded.title, snapshot=excluded.snapshot, expires_at=excluded.expires_at, local=excluded.local',
    [
      item.id,
      item.workspaceId,
      item.parentId,
      item.title,
      JSON.stringify(item),
      item.metadataExpiresAt === null ? null : Date.parse(item.metadataExpiresAt),
      local ? 1 : 0,
    ],
  );
  if (!item.canPersistBody) {
    await purgeBody(tx, item.id);
  } else if (item.bodyDocId === null) {
    await tx.execute('DELETE FROM mirror_body WHERE item_id=?', [item.id]);
    await tx.execute('DELETE FROM mirror_pending WHERE item_id=? AND doc_id IS NOT NULL', [
      item.id,
    ]);
    await tx.execute("UPDATE mirror_search SET body_text='' WHERE item_id=?", [item.id]);
  } else {
    await tx.execute('DELETE FROM mirror_body WHERE item_id=? AND doc_id<>?', [
      item.id,
      item.bodyDocId,
    ]);
    await tx.execute('DELETE FROM mirror_pending WHERE item_id=? AND doc_id<>?', [
      item.id,
      item.bodyDocId,
    ]);
    await tx.execute(
      "UPDATE mirror_search SET body_text='' WHERE item_id=? AND NOT EXISTS (SELECT 1 FROM mirror_body WHERE item_id=?)",
      [item.id, item.id],
    );
  }
  const existing = z
    .array(z.object({ body_text: z.string() }))
    .parse(await tx.execute('SELECT body_text FROM mirror_search WHERE item_id=?', [item.id]));
  await tx.execute('DELETE FROM mirror_search WHERE item_id=?', [item.id]);
  await tx.execute('INSERT INTO mirror_search(item_id,title,body_text) VALUES(?,?,?)', [
    item.id,
    await projectedTitle(tx, item),
    existing[0]?.body_text ?? '',
  ]);
}

async function bodyForItem(tx: SqliteTransaction, item: MirrorItem): Promise<MirrorBody> {
  if (!item.canPersistBody)
    return {
      item,
      docId: null,
      schemaVersion: null,
      headSeq: null,
      confirmedUpdate: null,
      pending: [],
    };
  const bodies = bodyRows.parse(
    await tx.execute(
      'SELECT doc_id, confirmed_update,schema_version,head_seq FROM mirror_body WHERE item_id=?',
      [item.id],
    ),
  );
  const body = bodies[0];
  const pending = pendingRows.parse(
    await tx.execute(
      'SELECT client_id, update_blob FROM mirror_pending WHERE item_id=? ORDER BY seq',
      [item.id],
    ),
  );
  return {
    item,
    docId: body?.doc_id ?? item.bodyDocId,
    schemaVersion: body?.schema_version ?? null,
    headSeq: body?.head_seq ?? null,
    confirmedUpdate: body ? new Uint8Array(body.confirmed_update) : null,
    pending: pending.map((row) => ({
      clientId: row.client_id,
      update: new Uint8Array(row.update_blob),
    })),
  };
}

async function refreshBodySearch(tx: SqliteTransaction, item: MirrorItem): Promise<void> {
  const body = await bodyForItem(tx, item);
  const doc = new Y.Doc();
  try {
    if (body.confirmedUpdate) Y.applyUpdate(doc, body.confirmedUpdate);
    for (const pending of body.pending) Y.applyUpdate(doc, pending.update);
    const text = [
      z.string().parse(doc.getXmlFragment('default').toJSON()),
      doc.getText('content').toJSON(),
    ]
      .join(' ')
      .replace(/<[^>]*>/g, ' ');
    await tx.execute('UPDATE mirror_search SET body_text=? WHERE item_id=?', [text, item.id]);
  } finally {
    doc.destroy();
  }
}

function remapOperation(
  operation: OutboxOperation,
  localId: string,
  serverId: string,
  revision: string,
): OutboxOperation {
  const itemId = operation.itemId === localId ? serverId : operation.itemId;
  switch (operation.kind) {
    case 'daily-note':
      return { ...operation, itemId };
    case 'create':
      return {
        ...operation,
        itemId,
        payload: {
          ...operation.payload,
          parentId: operation.payload.parentId === localId ? serverId : operation.payload.parentId,
        },
      };
    case 'move':
      return {
        ...operation,
        itemId,
        expectedRevision: itemId === serverId ? revision : operation.expectedRevision,
        payload: {
          ...operation.payload,
          parentId: operation.payload.parentId === localId ? serverId : operation.payload.parentId,
          ...(operation.payload.afterId === localId ? { afterId: serverId } : {}),
        },
      };
    case 'rename':
    case 'archive':
    case 'properties':
      return {
        ...operation,
        itemId,
        expectedRevision: itemId === serverId ? revision : operation.expectedRevision,
      };
  }
}

export interface OpenSqliteMirrorOptions {
  driver: SqliteDriver;
  scope: MirrorScope;
  protectFiles?: () => Promise<void>;
}

export class SqliteMirrorStore implements MirrorStore {
  private tail: Promise<void> = Promise.resolve();
  private sealed = false;
  private closed = false;
  private deleted = false;
  private readonly listeners = new Set<() => void>();
  private readonly disabledWorkspaces = new Set<string>();
  private readonly sealedWorkspaces = new Set<string>();

  private constructor(
    readonly scope: MirrorScope,
    private readonly database: SqliteConnection,
    private readonly protectFiles: (() => Promise<void>) | undefined,
  ) {}

  static async open({
    driver,
    scope: input,
    protectFiles,
  }: OpenSqliteMirrorOptions): Promise<SqliteMirrorStore> {
    const scope = mirrorScopeSchema.parse(input);
    const database = driver.open();
    const store = new SqliteMirrorStore(scope, database, protectFiles);
    try {
      await database.execute('PRAGMA foreign_keys=ON');
      await database.execute('PRAGMA journal_mode=WAL');
      await database.execute('PRAGMA synchronous=FULL');
      await database.execute('PRAGMA secure_delete=ON');
      await store.transact(
        async (tx) => {
          for (const statement of schema) await tx.execute(statement);
          await tx.execute(
            "INSERT INTO mirror_search(mirror_search,rank) VALUES('secure-delete',1)",
          );
          const account = JSON.stringify([scope.serverOrigin, scope.tenantId, scope.principalId]);
          const existing = textRows.parse(
            await tx.execute("SELECT value FROM mirror_meta WHERE key='account'"),
          );
          if (existing[0] && existing[0].value !== account)
            throw new Error('SQLite database belongs to another account');
          await tx.execute(
            "INSERT INTO mirror_meta(key,value) VALUES('account',?) ON CONFLICT(key) DO NOTHING",
            [account],
          );
          await tx.execute(
            "INSERT INTO mirror_meta(key,value) VALUES('schema','1') ON CONFLICT(key) DO NOTHING",
          );
          const disabled = textRows.parse(
            await tx.execute(
              "SELECT key AS value FROM mirror_setting WHERE key LIKE 'mirrorOff:%' AND value='true'",
            ),
          );
          for (const setting of disabled)
            store.disabledWorkspaces.add(setting.value.slice('mirrorOff:'.length));
          const sealed = textRows.parse(
            await tx.execute('SELECT workspace_id AS value FROM mirror_checkpoint WHERE sealed=1'),
          );
          for (const workspace of sealed) store.sealedWorkspaces.add(workspace.value);
        },
        true,
        false,
      );
      return store;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private async transact<T>(
    work: (tx: SqliteTransaction) => Promise<T>,
    changed = false,
    expire = true,
  ): Promise<T> {
    const task = this.tail.then(async () => {
      this.assertAccountAdmission();
      const result = await this.database.transaction(async (tx) => {
        if (this.sealed) throw new MirrorAccessRevokedError();
        let expiredRows = false;
        if (expire) {
          await tx.execute(
            'WITH RECURSIVE expired(id) AS (SELECT id FROM mirror_item WHERE expires_at<=? UNION SELECT item.id FROM mirror_item item JOIN expired ON item.parent_id=expired.id) DELETE FROM mirror_item WHERE id IN (SELECT id FROM expired)',
            [Date.now()],
          );
          expiredRows =
            z
              .tuple([z.object({ count: z.number() })])
              .parse(await tx.execute('SELECT changes() AS count'))[0].count > 0;
        }
        const value = await work(tx);
        this.assertAccountAdmission();
        return { value, expiredRows };
      });
      try {
        await this.protectFiles?.();
      } catch (error) {
        this.sealed = true;
        throw error;
      }
      this.assertAccountAdmission();
      return result;
    });
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    const result = await task;
    if (changed || result.expiredRows) this.notify();
    return result.value;
  }

  private notify(): void {
    for (const listener of this.listeners) queueMicrotask(listener);
  }

  private assertAccountAdmission(): void {
    if (this.sealed) throw new MirrorAccessRevokedError();
  }

  private async forWorkspace<T>(
    workspaceId: string,
    work: (tx: SqliteTransaction) => Promise<T>,
    changed = false,
  ): Promise<T> {
    const admitted = () => {
      if (this.disabledWorkspaces.has(workspaceId)) throw new MirrorAccessRevokedError('workspace');
    };
    admitted();
    const result = await this.transact(async (tx) => {
      admitted();
      const value = await work(tx);
      admitted();
      return value;
    }, changed);
    admitted();
    return result;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  acquireLease(lease: WorkspaceLease): Promise<boolean> {
    return this.forWorkspace(lease.workspaceId, async (tx) => {
      await tx.execute(
        'INSERT INTO mirror_lease(workspace_id,owner_id,expires_at) VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET owner_id=excluded.owner_id, expires_at=excluded.expires_at WHERE mirror_lease.expires_at<=? OR mirror_lease.owner_id=?',
        [lease.workspaceId, lease.ownerId, lease.expiresAtMs, lease.nowMs, lease.ownerId],
      );
      const rows = textRows.parse(
        await tx.execute('SELECT owner_id AS value FROM mirror_lease WHERE workspace_id=?', [
          lease.workspaceId,
        ]),
      );
      return rows[0]?.value === lease.ownerId;
    });
  }

  renewLease(lease: WorkspaceLease): Promise<boolean> {
    return this.forWorkspace(lease.workspaceId, async (tx) => {
      await tx.execute(
        'UPDATE mirror_lease SET expires_at=? WHERE workspace_id=? AND owner_id=? AND expires_at>?',
        [lease.expiresAtMs, lease.workspaceId, lease.ownerId, lease.nowMs],
      );
      const rows = z
        .tuple([z.object({ count: z.number() })])
        .parse(await tx.execute('SELECT changes() AS count'));
      return rows[0].count === 1;
    });
  }

  async releaseLease(workspaceId: string, ownerId: string): Promise<void> {
    await this.transact(async (tx) => {
      await tx.execute('DELETE FROM mirror_lease WHERE workspace_id=? AND owner_id=?', [
        workspaceId,
        ownerId,
      ]);
    });
  }

  getCheckpoint(workspaceId: string): Promise<MirrorCheckpoint> {
    return this.forWorkspace(workspaceId, async (tx) => {
      const row = checkpointRows.parse(
        await tx.execute(
          'SELECT cursor,boundary,next_cursor,sealed FROM mirror_checkpoint WHERE workspace_id=?',
          [workspaceId],
        ),
      )[0];
      return {
        cursor: row?.cursor ?? null,
        sealed: row?.sealed === 1,
        snapshot:
          row?.boundary && row.next_cursor
            ? { boundary: row.boundary, nextCursor: row.next_cursor }
            : null,
      };
    });
  }

  async sealWorkspace(workspaceId: string): Promise<void> {
    this.sealedWorkspaces.add(workspaceId);
    await this.forWorkspace(
      workspaceId,
      async (tx) => {
        await tx.execute(
          'INSERT INTO mirror_checkpoint(workspace_id,sealed) VALUES(?,1) ON CONFLICT(workspace_id) DO UPDATE SET sealed=1',
          [workspaceId],
        );
      },
      true,
    );
  }

  async unsealWorkspace(workspaceId: string): Promise<void> {
    await this.forWorkspace(workspaceId, async (tx) => {
      const progress = checkpointRows.parse(
        await tx.execute(
          'SELECT cursor,boundary,next_cursor,sealed FROM mirror_checkpoint WHERE workspace_id=?',
          [workspaceId],
        ),
      )[0];
      if (progress?.cursor == null || progress.boundary !== null)
        throw new Error('Cannot unseal an incomplete workspace snapshot');
      await tx.execute('UPDATE mirror_checkpoint SET sealed=0 WHERE workspace_id=?', [workspaceId]);
    });
    this.sealedWorkspaces.delete(workspaceId);
    this.notify();
  }

  async applySnapshotPage(
    workspaceId: string,
    input: NativeSnapshotPage,
    reset: boolean,
  ): Promise<void> {
    const page = nativeSnapshotPageSchema.parse(input);
    for (const item of page.items) assertWorkspace(item, workspaceId);
    await this.forWorkspace(
      workspaceId,
      async (tx) => {
        if (reset || page.resync) {
          await tx.execute('DELETE FROM mirror_stage WHERE workspace_id=?', [workspaceId]);
          await tx.execute(
            'INSERT INTO mirror_checkpoint(workspace_id) VALUES(?) ON CONFLICT(workspace_id) DO UPDATE SET boundary=NULL,next_cursor=NULL',
            [workspaceId],
          );
        }
        if (page.resync) return;
        const checkpoint = checkpointRows.parse(
          await tx.execute(
            'SELECT cursor,boundary,next_cursor,sealed FROM mirror_checkpoint WHERE workspace_id=?',
            [workspaceId],
          ),
        )[0];
        if (checkpoint?.boundary && checkpoint.boundary !== page.boundary)
          throw new Error('Snapshot boundary changed without reset');
        if (!page.complete && page.nextCursor === null)
          throw new Error('Incomplete snapshot has no resume cursor');
        for (const item of page.items)
          await tx.execute(
            'INSERT INTO mirror_stage(workspace_id,id,snapshot) VALUES(?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET snapshot=excluded.snapshot',
            [workspaceId, item.id, JSON.stringify(item)],
          );
        if (page.complete) {
          const staged = itemRows.parse(
            await tx.execute('SELECT snapshot FROM mirror_stage WHERE workspace_id=? ORDER BY id', [
              workspaceId,
            ]),
          );
          for (const item of staged) await saveItem(tx, parseItem(item.snapshot));
          const missing = textRows.parse(
            await tx.execute(
              'SELECT id AS value FROM mirror_item WHERE workspace_id=? AND local=0 AND id NOT IN(SELECT id FROM mirror_stage WHERE workspace_id=?)',
              [workspaceId, workspaceId],
            ),
          );
          for (const item of missing) await purgeItem(tx, workspaceId, item.value);
          await tx.execute('DELETE FROM mirror_stage WHERE workspace_id=?', [workspaceId]);
          await tx.execute(
            'INSERT INTO mirror_checkpoint(workspace_id,cursor,boundary,next_cursor) VALUES(?,?,NULL,NULL) ON CONFLICT(workspace_id) DO UPDATE SET cursor=excluded.cursor,boundary=NULL,next_cursor=NULL',
            [workspaceId, page.boundary],
          );
        } else {
          await tx.execute(
            'INSERT INTO mirror_checkpoint(workspace_id,boundary,next_cursor) VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET boundary=excluded.boundary,next_cursor=excluded.next_cursor',
            [workspaceId, page.boundary, page.nextCursor],
          );
        }
      },
      true,
    );
  }

  async applyChangesPage(workspaceId: string, input: NativeChangesPage): Promise<void> {
    const page = nativeChangesPageSchema.parse(input);
    if (page.resync) throw new Error('A changes resync requires a fresh snapshot');
    for (const item of page.items) assertWorkspace(item, workspaceId);
    await this.forWorkspace(
      workspaceId,
      async (tx) => {
        for (const item of page.items) await saveItem(tx, item);
        await tx.execute(
          'INSERT INTO mirror_checkpoint(workspace_id,cursor) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET cursor=excluded.cursor',
          [workspaceId, page.cursor],
        );
      },
      true,
    );
  }

  async applyReconcilePage(workspaceId: string, input: NativeReconcilePage): Promise<void> {
    const page = nativeReconcilePageSchema.parse(input);
    for (const item of page.items) assertWorkspace(item, workspaceId);
    await this.forWorkspace(
      workspaceId,
      async (tx) => {
        for (const removed of page.removed) await purgeItem(tx, workspaceId, removed.itemId);
        for (const item of page.items) await saveItem(tx, item);
      },
      true,
    );
  }

  knownItemIds(workspaceId: string): Promise<string[]> {
    return this.forWorkspace(workspaceId, async (tx) =>
      textRows
        .parse(
          await tx.execute(
            'SELECT id AS value FROM mirror_item WHERE workspace_id=? AND local=0 ORDER BY id',
            [workspaceId],
          ),
        )
        .map((row) => row.value),
    );
  }

  async purgeExpired(workspaceId: string, nowMs: number): Promise<void> {
    const changed = await this.forWorkspace(workspaceId, async (tx) => {
      const expired = textRows.parse(
        await tx.execute(
          'SELECT id AS value FROM mirror_item WHERE workspace_id=? AND expires_at<=?',
          [workspaceId, nowMs],
        ),
      );
      for (const item of expired) await purgeItem(tx, workspaceId, item.value);
      return expired.length > 0;
    });
    if (changed) this.notify();
  }

  listBodyCandidates(
    workspaceId: string,
    afterItemId: string | null,
    limit: number,
  ): Promise<MirrorBody[]> {
    return this.forWorkspace(workspaceId, async (tx) => {
      const items = itemRows.parse(
        await tx.execute(
          "SELECT item.snapshot FROM mirror_item item LEFT JOIN mirror_body body ON body.item_id=item.id WHERE item.workspace_id=? AND item.local=0 AND item.id>? AND json_extract(item.snapshot,'$.canPersistBody')=1 AND (body.item_id IS NULL OR body.head_seq IS NULL OR json_extract(item.snapshot,'$.bodyHeadSeq') IS NULL OR body.head_seq<>json_extract(item.snapshot,'$.bodyHeadSeq') OR EXISTS(SELECT 1 FROM mirror_pending WHERE item_id=item.id) OR EXISTS(SELECT 1 FROM mirror_body_request WHERE item_id=item.id)) ORDER BY item.id LIMIT ?",
          [workspaceId, afterItemId ?? '', limit],
        ),
      );
      return Promise.all(items.map((row) => bodyForItem(tx, parseItem(row.snapshot))));
    });
  }

  async commitBodySync(workspaceId: string, input: BodySyncSuccess): Promise<void> {
    const response = bodySyncSuccessSchema.parse(input);
    await this.commitConfirmedBody(workspaceId, response, response.headSeq);
  }

  async commitLiveBodySync(workspaceId: string, input: LiveBodySyncSuccess): Promise<void> {
    const response = bodySyncSuccessSchema.omit({ headSeq: true }).parse(input);
    await this.commitConfirmedBody(workspaceId, response, null);
  }

  private async commitConfirmedBody(
    workspaceId: string,
    response: LiveBodySyncSuccess,
    responseHead: string | null,
  ): Promise<void> {
    const remoteUpdate = toByteArray(response.update);
    Y.decodeUpdate(remoteUpdate);
    await this.forWorkspace(
      workspaceId,
      async (tx) => {
        const item = await rawItem(tx, workspaceId, response.itemId);
        if (!item?.canPersistBody) throw new Error('Body is not admitted to persistent storage');
        if (item.bodyDocId !== null && item.bodyDocId !== response.docId)
          throw new Error('Body response belongs to a replaced document');
        const body = await bodyForItem(tx, item);
        const storedHead = body.docId === response.docId ? body.headSeq : null;
        const headSeq =
          responseHead === null
            ? storedHead
            : storedHead !== null && BigInt(storedHead) > BigInt(responseHead)
              ? storedHead
              : responseHead;
        const advertisedHead =
          responseHead === null
            ? item.bodyHeadSeq
            : item.bodyHeadSeq !== null && BigInt(item.bodyHeadSeq) > BigInt(responseHead)
              ? item.bodyHeadSeq
              : responseHead;
        const schemaVersion = Math.max(body.schemaVersion ?? 1, response.schemaVersion);
        const acknowledged = new Set(response.acknowledgedClientIds);
        const updates = [
          ...(body.confirmedUpdate ? [body.confirmedUpdate] : []),
          ...body.pending
            .filter((pending) => acknowledged.has(pending.clientId))
            .map((pending) => pending.update),
          remoteUpdate,
        ];
        const doc = new Y.Doc();
        try {
          for (const update of updates) Y.applyUpdate(doc, update);
          const confirmed = Y.encodeStateAsUpdate(doc);
          const vector = Y.encodeStateVector(doc);
          const nextItem = {
            ...item,
            bodyDocId: response.docId,
            bodyHeadSeq: advertisedHead,
            canWrite: item.canWrite && response.canWrite,
          };
          await saveItem(tx, nextItem);
          await tx.execute(
            'UPDATE mirror_pending SET doc_id=? WHERE item_id=? AND doc_id IS NULL',
            [response.docId, item.id],
          );
          await tx.execute(
            'INSERT INTO mirror_body(item_id,doc_id,confirmed_update,state_vector,head_seq,schema_version) VALUES(?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET doc_id=excluded.doc_id,confirmed_update=excluded.confirmed_update,state_vector=excluded.state_vector,head_seq=excluded.head_seq,schema_version=excluded.schema_version',
            [item.id, response.docId, confirmed, vector, headSeq, schemaVersion],
          );
          if (responseHead !== null)
            await tx.execute('DELETE FROM mirror_body_request WHERE item_id=?', [item.id]);
          for (const clientId of response.acknowledgedClientIds)
            await tx.execute(
              'DELETE FROM mirror_pending WHERE item_id=? AND doc_id=? AND client_id=?',
              [item.id, response.docId, clientId],
            );
          await refreshBodySearch(tx, nextItem);
        } finally {
          doc.destroy();
        }
      },
      true,
    );
  }

  async recordBodyFailure(workspaceId: string, input: BodySyncFailure): Promise<void> {
    const failure = bodySyncFailureSchema.parse(input);
    await this.forWorkspace(
      workspaceId,
      async (tx) => {
        if (failure.status === 'forbidden') {
          await purgeItem(tx, workspaceId, failure.itemId);
          return;
        }
        const item = await rawItem(tx, workspaceId, failure.itemId);
        if (!item) return;
        if (!item.canPersistBody) {
          await purgeBody(tx, item.id);
          return;
        }
        if (failure.status === 'rejected' && failure.code === 'document_read_only')
          await saveItem(tx, { ...item, canWrite: false });
        if (failure.status === 'rejected')
          await tx.execute(
            "INSERT INTO mirror_conflict(id,workspace_id,item_id,kind,code,operation_json,created_at) VALUES(?,?,?,'body',?,NULL,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code",
            [`body:${item.id}`, workspaceId, item.id, failure.code, new Date().toISOString()],
          );
      },
      true,
    );
  }

  listOutbox(workspaceId: string): Promise<OutboxOperation[]> {
    return this.forWorkspace(workspaceId, async (tx) => {
      if (this.sealedWorkspaces.has(workspaceId)) return [];
      return textRows
        .parse(
          await tx.execute(
            'SELECT operation_json AS value FROM mirror_outbox WHERE workspace_id=? ORDER BY seq',
            [workspaceId],
          ),
        )
        .map((row) => parseOperation(row.value));
    }).then((operations) => (this.sealedWorkspaces.has(workspaceId) ? [] : operations));
  }

  peekOutbox(workspaceId: string): Promise<OutboxOperation | null> {
    return this.forWorkspace(workspaceId, async (tx) => {
      const row = textRows.parse(
        await tx.execute(
          'SELECT operation_json AS value FROM mirror_outbox WHERE workspace_id=? ORDER BY seq LIMIT 1',
          [workspaceId],
        ),
      )[0];
      return row ? parseOperation(row.value) : null;
    });
  }

  async recordReplayResult(workspaceId: string, input: NativeReplayResult): Promise<void> {
    const response = nativeReplayResultSchema.parse(input);
    await this.forWorkspace(
      workspaceId,
      async (tx) => {
        const row = textRows.parse(
          await tx.execute(
            'SELECT operation_json AS value FROM mirror_outbox WHERE workspace_id=? AND operation_id=?',
            [workspaceId, response.operationId],
          ),
        )[0];
        if (!row) return;
        const operation = parseOperation(row.value);
        if (response.status !== 'applied') {
          if (response.item) {
            assertWorkspace(response.item, workspaceId);
            await saveItem(tx, response.item);
          }
          await tx.execute(
            "INSERT INTO mirror_conflict(id,workspace_id,item_id,kind,code,operation_json,created_at) VALUES(?,?,?,'metadata',?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,operation_json=excluded.operation_json",
            [
              operation.operationId,
              workspaceId,
              operation.itemId,
              response.code ?? response.status,
              JSON.stringify(operation),
              new Date().toISOString(),
            ],
          );
          await tx.execute('DELETE FROM mirror_outbox WHERE operation_id=?', [
            operation.operationId,
          ]);
          const current = await rawItem(tx, workspaceId, operation.itemId);
          if (current)
            await tx.execute('UPDATE mirror_search SET title=? WHERE item_id=?', [
              await projectedTitle(tx, current),
              current.id,
            ]);
          return;
        }
        if (operation.kind === 'archive' && response.item === null) {
          await purgeItem(tx, workspaceId, operation.itemId);
          return;
        }
        if (!response.item || response.revision === null)
          throw new Error('Applied replay lacks its authoritative item and revision');
        assertWorkspace(response.item, workspaceId);
        const localId = operation.itemId;
        const serverId = response.item.id;
        if (
          (operation.kind === 'create' || operation.kind === 'daily-note') &&
          localId !== serverId
        ) {
          await saveItem(tx, response.item);
          const descendants = itemRows.parse(
            await tx.execute(
              'SELECT snapshot FROM mirror_item WHERE workspace_id=? AND parent_id=?',
              [workspaceId, localId],
            ),
          );
          for (const child of descendants) {
            const item = parseItem(child.snapshot);
            await saveItem(tx, { ...item, parentId: serverId }, true);
          }
          await tx.execute('UPDATE mirror_pending SET item_id=?,doc_id=? WHERE item_id=?', [
            serverId,
            response.item.bodyDocId,
            localId,
          ]);
          await tx.execute('UPDATE mirror_outbox SET item_id=? WHERE item_id=?', [
            serverId,
            localId,
          ]);
          await tx.execute('UPDATE mirror_conflict SET item_id=? WHERE item_id=?', [
            serverId,
            localId,
          ]);
          await tx.execute('DELETE FROM mirror_item WHERE id=? AND workspace_id=?', [
            localId,
            workspaceId,
          ]);
          if (!response.item.canPersistBody) await purgeBody(tx, serverId);
          await tx.execute(
            'INSERT INTO mirror_alias(local_id,workspace_id,server_id) VALUES(?,?,?) ON CONFLICT(local_id) DO UPDATE SET server_id=excluded.server_id',
            [localId, workspaceId, serverId],
          );
        } else {
          if (serverId !== localId)
            throw new Error('Replay response changed a non-create item identity');
          await saveItem(tx, response.item);
        }
        await tx.execute('DELETE FROM mirror_outbox WHERE operation_id=?', [operation.operationId]);
        const remaining = textRows.parse(
          await tx.execute(
            "SELECT operation_json AS value FROM mirror_outbox WHERE workspace_id=? AND (item_id=? OR json_extract(operation_json,'$.payload.parentId')=? OR json_extract(operation_json,'$.payload.afterId')=?) ORDER BY seq",
            [workspaceId, serverId, localId, localId],
          ),
        );
        for (const entry of remaining) {
          const next = remapOperation(
            parseOperation(entry.value),
            localId,
            serverId,
            response.revision,
          );
          await tx.execute('UPDATE mirror_outbox SET operation_json=? WHERE operation_id=?', [
            JSON.stringify(next),
            next.operationId,
          ]);
        }
        const current = await rawItem(tx, workspaceId, serverId);
        if (current)
          await tx.execute('UPDATE mirror_search SET title=? WHERE item_id=?', [
            await projectedTitle(tx, current),
            current.id,
          ]);
      },
      true,
    );
  }

  listItems(workspaceId: string): Promise<MirrorItem[]> {
    return this.forWorkspace(workspaceId, async (tx) => {
      if (this.sealedWorkspaces.has(workspaceId)) return [];
      const items = itemRows
        .parse(
          await tx.execute(
            'SELECT snapshot FROM mirror_item WHERE workspace_id=? ORDER BY title,id',
            [workspaceId],
          ),
        )
        .map((row) => parseItem(row.snapshot));
      return projectItems(tx, workspaceId, items);
    }).then((items) => (this.sealedWorkspaces.has(workspaceId) ? [] : items));
  }

  searchItems(workspaceId: string, query: string): Promise<MirrorItem[]> {
    const phrase = `"${query.replace(/"/g, '""')}"`;
    if (query.trim() === '') return this.listItems(workspaceId);
    return this.forWorkspace(workspaceId, async (tx) => {
      if (this.sealedWorkspaces.has(workspaceId)) return [];
      const items = itemRows
        .parse(
          await tx.execute(
            'SELECT item.snapshot FROM mirror_search JOIN mirror_item item ON item.id=mirror_search.item_id WHERE item.workspace_id=? AND mirror_search MATCH ? ORDER BY rank LIMIT 200',
            [workspaceId, phrase],
          ),
        )
        .map((row) => parseItem(row.snapshot));
      return projectItems(tx, workspaceId, items);
    }).then((items) => (this.sealedWorkspaces.has(workspaceId) ? [] : items));
  }

  readBody(workspaceId: string, itemId: string): Promise<MirrorBody | null> {
    return this.forWorkspace(workspaceId, async (tx) => {
      if (this.sealedWorkspaces.has(workspaceId)) return null;
      const item = await rawItem(tx, workspaceId, itemId);
      if (!item) return null;
      const projected = (await projectItems(tx, workspaceId, [item]))[0];
      return projected ? bodyForItem(tx, projected) : null;
    }).then((body) => (this.sealedWorkspaces.has(workspaceId) ? null : body));
  }

  async requestBody(workspaceId: string, itemId: string): Promise<void> {
    const changed = await this.forWorkspace(workspaceId, async (tx) => {
      const item = await rawItem(tx, workspaceId, itemId);
      if (!item?.canPersistBody) throw new Error('Body is not admitted to persistent storage');
      await tx.execute(
        'INSERT INTO mirror_body_request(item_id) VALUES(?) ON CONFLICT(item_id) DO NOTHING',
        [item.id],
      );
      return (
        z
          .tuple([z.object({ count: z.number() })])
          .parse(await tx.execute('SELECT changes() AS count'))[0].count > 0
      );
    });
    if (changed) this.notify();
  }

  async enqueue(workspaceId: string, input: OutboxOperation): Promise<void> {
    const operation = outboxOperationSchema.parse(input);
    await this.forWorkspace(
      workspaceId,
      async (tx) => {
        if (this.sealedWorkspaces.has(workspaceId)) throw new MirrorAccessRevokedError('workspace');
        const existing = textRows.parse(
          await tx.execute(
            'SELECT operation_json AS value FROM mirror_outbox WHERE operation_id=?',
            [operation.operationId],
          ),
        )[0];
        if (existing) {
          if (existing.value !== JSON.stringify(operation))
            throw new Error('Outbox idempotency key was reused with different content');
          return;
        }
        if (operation.kind === 'create' || operation.kind === 'daily-note') {
          const parentId = operation.kind === 'create' ? operation.payload.parentId : null;
          if (parentId !== null) {
            const parent = await rawItem(tx, workspaceId, parentId);
            if (!parent?.canWrite || parent.noChildren)
              throw new Error('Parent is not admitted for offline creation');
          }
          if (await rawItem(tx, workspaceId, operation.itemId))
            throw new Error('Local create identity already exists');
          await saveItem(
            tx,
            {
              id: operation.itemId,
              workspaceId,
              parentId,
              type: operation.kind === 'create' ? operation.payload.type : 'prose',
              title: operation.kind === 'create' ? operation.payload.title : operation.payload.date,
              seq: 0,
              revision: '0',
              lifecycleState: 'active',
              properties: operation.kind === 'create' ? (operation.payload.properties ?? {}) : {},
              computedProperties: null,
              schema: null,
              views: null,
              recurrence: null,
              noDelete: false,
              noChildren: false,
              managedBy: null,
              createdAt: new Date().toISOString(),
              updatedAt: null,
              canWrite: true,
              locked: false,
              canPersistBody: true,
              metadataExpiresAt: null,
              bodyDocId: null,
              bodyHeadSeq: null,
              file: null,
            },
            true,
          );
        } else {
          const item = await rawItem(tx, workspaceId, operation.itemId);
          if (!item?.canWrite) throw new Error('Item is not admitted for offline writes');
          if (operation.kind === 'archive' && item.noDelete)
            throw new Error('Item is protected against archive');
          if (operation.kind === 'move' && operation.payload.parentId !== null) {
            const parent = await rawItem(tx, workspaceId, operation.payload.parentId);
            if (!parent?.canWrite || parent.noChildren)
              throw new Error('Destination is not admitted for offline writes');
          }
        }
        await tx.execute(
          'INSERT INTO mirror_outbox(operation_id,workspace_id,item_id,operation_json) VALUES(?,?,?,?)',
          [operation.operationId, workspaceId, operation.itemId, JSON.stringify(operation)],
        );
        if (operation.kind === 'rename')
          await tx.execute('UPDATE mirror_search SET title=? WHERE item_id=?', [
            operation.payload.title,
            operation.itemId,
          ]);
      },
      true,
    );
  }

  async enqueueBodyUpdate(
    workspaceId: string,
    itemId: string,
    pending: PendingBodyUpdate,
  ): Promise<void> {
    z.string().min(1).max(200).parse(pending.clientId);
    if (pending.update.byteLength > BODY_SYNC_LIMITS.updateBytes)
      throw new Error('Body update exceeds the synchronization limit');
    Y.decodeUpdate(pending.update);
    await this.forWorkspace(
      workspaceId,
      async (tx) => {
        if (this.sealedWorkspaces.has(workspaceId)) throw new MirrorAccessRevokedError('workspace');
        const item = await rawItem(tx, workspaceId, itemId);
        if (!item?.canWrite || !item.canPersistBody)
          throw new Error('Body is not admitted for offline edits');
        const existing = z
          .array(z.object({ item_id: z.string(), workspace_id: z.string(), update_blob: blob }))
          .parse(
            await tx.execute(
              'SELECT pending.item_id,item.workspace_id,pending.update_blob FROM mirror_pending pending JOIN mirror_item item ON item.id=pending.item_id WHERE pending.client_id=?',
              [pending.clientId],
            ),
          )[0];
        if (existing) {
          const bytes = new Uint8Array(existing.update_blob);
          if (
            existing.item_id !== itemId ||
            existing.workspace_id !== workspaceId ||
            bytes.length !== pending.update.length ||
            !bytes.every((byte, index) => byte === pending.update[index])
          )
            throw new Error('Body update idempotency key was reused with different content');
          return;
        }
        await tx.execute(
          'INSERT INTO mirror_pending(item_id,doc_id,client_id,update_blob) VALUES(?,?,?,?)',
          [itemId, item.bodyDocId, pending.clientId, pending.update],
        );
        await refreshBodySearch(tx, item);
      },
      true,
    );
  }

  listConflicts(workspaceId: string): Promise<MirrorConflict[]> {
    return this.forWorkspace(workspaceId, async (tx) => {
      if (this.sealedWorkspaces.has(workspaceId)) return [];
      const rows = z
        .array(
          z.object({
            id: z.string(),
            workspace_id: z.string(),
            item_id: z.string(),
            kind: z.enum(['metadata', 'body']),
            code: z.string(),
            operation_json: z.string().nullable(),
            created_at: z.string(),
          }),
        )
        .parse(
          await tx.execute(
            'SELECT * FROM mirror_conflict WHERE workspace_id=? ORDER BY created_at,id',
            [workspaceId],
          ),
        );
      return rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        itemId: row.item_id,
        kind: row.kind,
        code: row.code,
        operation: row.operation_json ? parseOperation(row.operation_json) : null,
        createdAt: row.created_at,
      }));
    }).then((conflicts) => (this.sealedWorkspaces.has(workspaceId) ? [] : conflicts));
  }

  /** Forgets one conflict and its recovery data; the person has seen it (and copied what they need). */
  async dismissConflict(workspaceId: string, conflictId: string): Promise<void> {
    await this.forWorkspace(
      workspaceId,
      async (tx) => {
        await tx.execute(
          'DELETE FROM mirror_conflict_recovery WHERE conflict_id IN (SELECT id FROM mirror_conflict WHERE workspace_id=? AND id=?)',
          [workspaceId, conflictId],
        );
        await tx.execute('DELETE FROM mirror_conflict WHERE workspace_id=? AND id=?', [
          workspaceId,
          conflictId,
        ]);
      },
      true,
    );
  }

  resolveItemId(workspaceId: string, itemId: string): Promise<string> {
    return this.forWorkspace(workspaceId, async (tx) => {
      if (this.sealedWorkspaces.has(workspaceId)) return itemId;
      return (
        textRows.parse(
          await tx.execute(
            'SELECT server_id AS value FROM mirror_alias WHERE workspace_id=? AND local_id=?',
            [workspaceId, itemId],
          ),
        )[0]?.value ?? itemId
      );
    });
  }

  readConflictRecovery(workspaceId: string, conflictId: string): Promise<Uint8Array | null> {
    return this.forWorkspace(workspaceId, async (tx) => {
      if (this.sealedWorkspaces.has(workspaceId)) return null;
      const rows = z
        .array(z.object({ update_blob: blob }))
        .parse(
          await tx.execute(
            'SELECT recovery.update_blob FROM mirror_conflict_recovery recovery JOIN mirror_conflict conflict ON conflict.id=recovery.conflict_id WHERE conflict.workspace_id=? AND conflict.id=?',
            [workspaceId, conflictId],
          ),
        );
      return rows[0] ? new Uint8Array(rows[0].update_blob) : null;
    });
  }

  readWorkspaceList(): Promise<{ id: string; name: string }[]> {
    return this.transact(async (tx) =>
      workspaceListSchema.parse(
        await tx.execute('SELECT id,name FROM mirror_workspace ORDER BY name,id'),
      ),
    );
  }

  readItems(input: string[]): Promise<MirrorItem[]> {
    const itemIds = z.array(z.uuid()).max(200).parse(input);
    if (itemIds.length === 0) return Promise.resolve([]);
    const placeholders = itemIds.map(() => '?').join(',');
    return this.transact(async (tx) => {
      const items = itemRows
        .parse(
          await tx.execute(
            `SELECT snapshot FROM mirror_item WHERE id IN (${placeholders}) OR id IN (SELECT server_id FROM mirror_alias WHERE local_id IN (${placeholders}))`,
            [...itemIds, ...itemIds],
          ),
        )
        .map((row) => parseItem(row.snapshot));
      const byWorkspace = new Map<string, MirrorItem[]>();
      for (const item of items) {
        if (
          this.disabledWorkspaces.has(item.workspaceId) ||
          this.sealedWorkspaces.has(item.workspaceId)
        )
          continue;
        const group = byWorkspace.get(item.workspaceId) ?? [];
        group.push(item);
        byWorkspace.set(item.workspaceId, group);
      }
      const projected: MirrorItem[] = [];
      for (const [workspaceId, group] of byWorkspace)
        projected.push(...(await projectItems(tx, workspaceId, group)));
      return projected;
    }).then((items) =>
      items.filter(
        (item) =>
          !this.disabledWorkspaces.has(item.workspaceId) &&
          !this.sealedWorkspaces.has(item.workspaceId),
      ),
    );
  }

  async replaceWorkspaceList(input: { id: string; name: string }[]): Promise<void> {
    const workspaces = workspaceListSchema.parse(input);
    await this.transact(async (tx) => {
      const admitted = new Set(workspaces.map((workspace) => workspace.id));
      const existing = textRows.parse(
        await tx.execute(
          'SELECT id AS value FROM mirror_workspace UNION SELECT workspace_id AS value FROM mirror_item',
        ),
      );
      for (const workspace of existing)
        if (!admitted.has(workspace.value)) await this.dropWorkspace(tx, workspace.value);
      await tx.execute('DELETE FROM mirror_workspace');
      for (const workspace of workspaces)
        await tx.execute('INSERT INTO mirror_workspace(id,name) VALUES(?,?)', [
          workspace.id,
          workspace.name,
        ]);
    }, true);
  }

  getSetting(key: string): Promise<string | null> {
    return this.transact(
      async (tx) =>
        textRows.parse(await tx.execute('SELECT value FROM mirror_setting WHERE key=?', [key]))[0]
          ?.value ?? null,
    );
  }

  async setSetting(key: string, value: string | null): Promise<void> {
    const workspaceId = key.startsWith('mirrorOff:')
      ? z.uuid().parse(key.slice('mirrorOff:'.length))
      : null;
    if (workspaceId !== null && value === 'true') this.disabledWorkspaces.add(workspaceId);
    await this.transact(async (tx) => {
      if (workspaceId !== null && value === 'true') await this.dropWorkspace(tx, workspaceId);
      if (value === null) await tx.execute('DELETE FROM mirror_setting WHERE key=?', [key]);
      else
        await tx.execute(
          'INSERT INTO mirror_setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          [key, value],
        );
    }, true);
    if (workspaceId !== null && value !== 'true') this.disabledWorkspaces.delete(workspaceId);
  }

  private async dropWorkspace(tx: SqliteTransaction, workspaceId: string): Promise<void> {
    await tx.execute('DELETE FROM mirror_item WHERE workspace_id=?', [workspaceId]);
    await tx.execute('DELETE FROM mirror_outbox WHERE workspace_id=?', [workspaceId]);
    await tx.execute('DELETE FROM mirror_conflict WHERE workspace_id=?', [workspaceId]);
    await tx.execute('DELETE FROM mirror_alias WHERE workspace_id=?', [workspaceId]);
    await tx.execute('DELETE FROM mirror_stage WHERE workspace_id=?', [workspaceId]);
    await tx.execute('DELETE FROM mirror_checkpoint WHERE workspace_id=?', [workspaceId]);
    await tx.execute('DELETE FROM mirror_lease WHERE workspace_id=?', [workspaceId]);
    await tx.execute('DELETE FROM mirror_workspace WHERE id=?', [workspaceId]);
  }

  async wipeWorkspace(workspaceId: string): Promise<void> {
    await this.transact((tx) => this.dropWorkspace(tx, workspaceId), true);
  }

  async close(): Promise<void> {
    this.sealed = true;
    await this.tail;
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
    this.notify();
  }

  async wipe(): Promise<void> {
    await this.close();
    if (!this.deleted) {
      await this.database.delete();
      this.deleted = true;
    }
  }
}

export function openSqliteMirror(options: OpenSqliteMirrorOptions): Promise<SqliteMirrorStore> {
  return SqliteMirrorStore.open(options);
}
