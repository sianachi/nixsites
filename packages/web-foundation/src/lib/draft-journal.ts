import * as Y from 'yjs';
import { z } from 'zod';

import {
  bodyCacheAdmits,
  bodyCacheAccountAdmits,
  bodyCacheAccountEpoch,
  bodyCacheCleanupCurrent,
  bodyCacheDraftCurrent,
  bodyCacheDraftEpoch,
} from './body-cache';

const DB = 'nix-pending-drafts';
const STORE = 'updates';
const MIGRATIONS = 'migrations';
const MAX_BYTES = 8 * 1024 * 1024;
const recordSchema = z.object({
  id: z.string(),
  scope: z.string(),
  revision: z.number().int().nonnegative(),
  docId: z.string().min(1).optional(),
  update: z.custom<Uint8Array>(
    (value) => Object.prototype.toString.call(value) === '[object Uint8Array]',
  ),
});
export type DraftRecord = z.infer<typeof recordSchema>;
export type DraftState = 'saving' | 'local' | 'synced' | 'error';
let generation = 0;
const subjectGenerations = new Map<string, number>();
let channel: BroadcastChannel | undefined;
let database: Promise<IDBDatabase> | undefined;
const scopeSchema = z.tuple([z.string(), z.string(), z.string(), z.string()]);
const migrationSchema = z.object({ fromScope: z.string(), toScope: z.string(), docId: z.string() });
const lifecycleMessageSchema = z.object({
  type: z.literal('signed-out'),
  subject: z.string().optional(),
  epoch: z.string().nullable().optional(),
});

function draftGeneration(scope: string): string {
  try {
    const subject = scopeSchema.parse(JSON.parse(scope))[0];
    return JSON.stringify([
      generation,
      subjectGenerations.get(subject) ?? 0,
      bodyCacheDraftEpoch(subject),
    ]);
  } catch {
    return String(generation);
  }
}

function closeDraftGeneration(subject?: string): void {
  if (subject === undefined) generation += 1;
  else subjectGenerations.set(subject, (subjectGenerations.get(subject) ?? 0) + 1);
}

/** Owner updates may finish persisting after access refusal, for recovery without body replay. */
function admitsDraftWrite(scope: string): boolean {
  try {
    const parts = scopeSchema.parse(JSON.parse(scope));
    return bodyCacheAccountAdmits(parts[0]);
  } catch {
    return false;
  }
}
function open(): Promise<IDBDatabase> {
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('nix-draft-lifecycle');
    channel.onmessage = (event) => {
      const parsed = lifecycleMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const detail = parsed.data;
      if (
        detail.subject !== undefined &&
        !bodyCacheCleanupCurrent(detail.subject, detail.epoch ?? null)
      )
        return;
      closeDraftGeneration(detail.subject);
      window.dispatchEvent(new CustomEvent('nix:signed-out-elsewhere', { detail }));
    };
  }
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 2);
    let refused = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('scope', 'scope');
      }
      const migrations = request.result.createObjectStore(MIGRATIONS, { keyPath: 'fromScope' });
      migrations.createIndex('toScope', 'toScope');
    };
    request.onsuccess = () => {
      if (refused) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      refused = true;
      database = undefined;
      reject(request.error ?? new Error('Draft storage could not be opened.'));
    };
    request.onblocked = () => {
      refused = true;
      database = undefined;
      reject(new Error('Draft storage is blocked.'));
    };
  });
  return database;
}
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void) => void,
  admitted: () => boolean = () => true,
): Promise<T> {
  const db = await open();
  if (!admitted()) throw new Error('This account’s local draft storage is closed.');
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, MIGRATIONS], mode);
    let result: T;
    tx.oncomplete = () => {
      resolve(result);
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('Draft transaction failed.'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('Draft write aborted.'));
    };
    run(tx.objectStore(STORE), (value) => {
      result = value;
    });
  });
}
export async function readDrafts(scope: string): Promise<DraftRecord[]> {
  return transaction('readonly', (store, done) => {
    const request = store.index('scope').getAll(scope);
    request.onsuccess = () => {
      const records = z.array(recordSchema).safeParse(request.result);
      if (!records.success || records.data.some((record) => record.update.byteLength > MAX_BYTES)) {
        store.transaction.abort();
        return;
      }
      done(records.data);
    };
  });
}
export async function writeDraft(record: DraftRecord): Promise<void> {
  if (record.update.byteLength > MAX_BYTES)
    throw new Error('The draft exceeds local storage limits.');
  const subject = scopeSchema.parse(JSON.parse(record.scope))[0];
  const epoch = bodyCacheDraftEpoch(subject);
  await transaction<undefined>(
    'readwrite',
    (store, done) => {
      const request = store.transaction.objectStore(MIGRATIONS).get(record.scope);
      request.onsuccess = () => {
        const migration = migrationSchema.safeParse(request.result);
        if (migration.success && !admitsDraftWrite(migration.data.toScope)) {
          store.transaction.abort();
          return;
        }
        store.put(
          migration.success
            ? { ...record, scope: migration.data.toScope, docId: migration.data.docId }
            : record,
        );
        done(undefined);
      };
    },
    () => bodyCacheDraftCurrent(subject, epoch) && admitsDraftWrite(record.scope),
  );
  draftsChanged();
}
/** Compare revisions so acknowledgement never deletes a newer edit from another tab. */
export async function acknowledgeDrafts(
  records: readonly DraftRecord[],
  admitted: () => boolean = () => true,
): Promise<void> {
  await transaction<undefined>(
    'readwrite',
    (store, done) => {
      for (const record of records) {
        const request = store.get(record.id);
        request.onsuccess = () => {
          const current = recordSchema.safeParse(request.result);
          if (current.success && current.data.revision === record.revision) store.delete(record.id);
        };
      }
      done(undefined);
    },
    () => admitted() && records.every((record) => bodyCacheAdmits(record.scope)),
  );
  draftsChanged();
}

async function bindDrafts(
  scope: string,
  docId: string,
  admitted: () => boolean = () => true,
): Promise<void> {
  const parts = scopeSchema.parse(JSON.parse(scope));
  await transaction<undefined>(
    'readwrite',
    (store, done) => {
      const cursor = store.index('scope').openCursor(scope);
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (current === null) {
          done(undefined);
          return;
        }
        const record = recordSchema.safeParse(current.value);
        if (
          !record.success ||
          (record.data.docId !== undefined &&
            record.data.docId !== docId &&
            record.data.docId !== `local:${parts[2]}`)
        ) {
          store.transaction.abort();
          return;
        }
        current.update({ ...record.data, docId });
        current.continue();
      };
      const migrations = store.transaction
        .objectStore(MIGRATIONS)
        .index('toScope')
        .openCursor(scope);
      migrations.onsuccess = () => {
        const current = migrations.result;
        if (current === null) return;
        const migration = migrationSchema.safeParse(current.value);
        if (migration.success) current.update({ ...migration.data, docId });
        current.continue();
      };
    },
    () => admitted() && bodyCacheAdmits(scope),
  );
}
export async function clearDrafts(
  expectedSubject?: string,
  expectedEpoch?: string | null,
): Promise<void> {
  const epoch =
    expectedSubject === undefined
      ? undefined
      : expectedEpoch === undefined
        ? bodyCacheAccountEpoch(expectedSubject)
        : expectedEpoch;
  if (expectedSubject !== undefined && !bodyCacheCleanupCurrent(expectedSubject, epoch ?? null))
    throw new Error('Local draft cleanup was superseded by another session.');
  closeDraftGeneration(expectedSubject);
  const ready = open();
  channel?.postMessage({ type: 'signed-out', subject: expectedSubject, epoch });
  await ready;
  await transaction<undefined>(
    'readwrite',
    (store, done) => {
      const migrations = store.transaction.objectStore(MIGRATIONS);
      if (expectedSubject === undefined) {
        store.clear();
        migrations.clear();
      } else {
        const prefix = `${JSON.stringify([expectedSubject]).slice(0, -1)},`;
        const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
        const records = store.index('scope').openKeyCursor(range);
        records.onsuccess = () => {
          const current = records.result;
          if (current === null) return;
          store.delete(current.primaryKey);
          current.continue();
        };
        migrations.delete(range);
        const destinations = migrations.index('toScope').openKeyCursor(range);
        destinations.onsuccess = () => {
          const current = destinations.result;
          if (current === null) return;
          migrations.delete(current.primaryKey);
          current.continue();
        };
      }
      done(undefined);
    },
    () => expectedSubject === undefined || bodyCacheCleanupCurrent(expectedSubject, epoch ?? null),
  );
  draftsChanged();
}

function draftsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('nix:offline-drafts-changed'));
}

/** Pending note scopes for the currently open account, without loading their Yjs bytes. */
export async function listDraftScopes(subject: string): Promise<string[]> {
  if (!bodyCacheAccountAdmits(subject)) return [];
  const epoch = bodyCacheDraftEpoch(subject);
  const prefix = `${JSON.stringify([subject]).slice(0, -1)},`;
  return transaction('readonly', (store, done) => {
    const scopes = new Set<string>();
    const cursor = store.index('scope').openKeyCursor();
    cursor.onsuccess = () => {
      const current = cursor.result;
      if (current === null) {
        done(bodyCacheDraftCurrent(subject, epoch) ? [...scopes] : []);
        return;
      }
      if (
        typeof current.key === 'string' &&
        current.key.startsWith(prefix) &&
        bodyCacheDraftCurrent(subject, epoch)
      )
        scopes.add(current.key);
      current.continue();
    };
  });
}

export interface DraftJournalStore {
  read: (scope: string) => Promise<DraftRecord[]>;
  write: (record: DraftRecord) => Promise<void>;
  acknowledge: (records: readonly DraftRecord[], admitted?: () => boolean) => Promise<void>;
  bind?: (scope: string, docId: string, admitted?: () => boolean) => Promise<void>;
}

export interface DraftJournal {
  read: () => Promise<DraftRecord[]>;
  append: (update: Uint8Array) => void;
  snapshot: () => Promise<DraftRecord[]>;
  acknowledge: (records: readonly DraftRecord[], admitted?: () => boolean) => Promise<void>;
  discard: () => Promise<void>;
  bindDocument: (docId: string, admitted?: () => boolean) => Promise<void>;
}
export function createDraftJournal(
  scope: string,
  onState: (state: DraftState) => void,
  store: DraftJournalStore = {
    read: readDrafts,
    write: writeDraft,
    acknowledge: acknowledgeDrafts,
    bind: bindDrafts,
  },
): DraftJournal {
  const id = `${scope}:${crypto.randomUUID()}`;
  const epoch = draftGeneration(scope);
  let restored: DraftRecord[] = [];
  let revision = 0;
  let merged: Uint8Array | null = null;
  let chain = Promise.resolve();
  let disabled = false;
  let docId: string | undefined;
  let failure: Error | null = null;
  return {
    async read(): Promise<DraftRecord[]> {
      restored = await store.read(scope);
      if (restored.length) onState('local');
      return restored;
    },
    append(update: Uint8Array): void {
      if (disabled || epoch !== draftGeneration(scope)) {
        onState('error');
        return;
      }
      if ((merged?.byteLength ?? 0) + update.byteLength > MAX_BYTES) {
        disabled = true;
        failure = new Error('The draft exceeds local storage limits.');
        onState('error');
        return;
      }
      merged = merged === null ? update : Y.mergeUpdates([merged, update]);
      revision += 1;
      const record = { id, scope, revision, docId, update: new Uint8Array(merged) };
      onState('saving');
      chain = chain
        .then(() => {
          if (epoch !== draftGeneration(scope))
            throw new Error('This account’s local draft storage is closed.');
          return store.write(record);
        })
        .then(() => {
          if (record.revision === revision) {
            failure = null;
            onState('local');
          }
        })
        .catch((cause: unknown) => {
          failure =
            cause instanceof Error ? cause : new Error('The local draft could not be saved.');
          onState('error');
        });
    },
    async snapshot(): Promise<DraftRecord[]> {
      await chain;
      if (failure !== null) throw failure;
      return [...restored, ...(await store.read(scope)).filter((record) => record.id === id)];
    },
    async acknowledge(records: readonly DraftRecord[], admitted?: () => boolean): Promise<void> {
      if (admitted?.() === false) throw new Error('This draft’s offline storage is closed.');
      await store.acknowledge(records, admitted);
      if (admitted?.() === false) throw new Error('This draft’s offline storage is closed.');
      restored = restored.filter(
        (record) =>
          !records.some((acked) => acked.id === record.id && acked.revision === record.revision),
      );
      if (records.some((record) => record.id === id && record.revision === revision)) {
        merged = null;
      }
      if (merged === null && restored.length === 0) onState('synced');
    },
    async discard(): Promise<void> {
      disabled = true;
      await chain;
      await store.acknowledge(await store.read(scope));
    },
    async bindDocument(identity: string, admitted?: () => boolean): Promise<void> {
      docId = identity;
      await chain;
      if (failure !== null) throw failure;
      if (admitted?.() === false) throw new Error('This draft’s offline storage is closed.');
      const records = await store.read(scope);
      if (admitted?.() === false) throw new Error('This draft’s offline storage is closed.');
      if (store.bind !== undefined) await store.bind(scope, identity, admitted);
      else
        for (const record of records) {
          if (admitted?.() === false) throw new Error('This draft’s offline storage is closed.');
          await store.write({ ...record, docId: identity });
        }
      if (admitted?.() === false) throw new Error('This draft’s offline storage is closed.');
      restored = restored.map((record) => ({ ...record, docId: identity }));
    },
  };
}
