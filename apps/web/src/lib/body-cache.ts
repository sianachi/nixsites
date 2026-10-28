import { z } from 'zod';
import * as Y from 'yjs';

import { browserStorage } from './browser-storage';
import { clearFrecency } from './frecency';
import { clearRecentItems } from './recent-items';
import { clearSuggestionDismissals } from './suggestion-dismissals';

/**
 * Complete confirmed document copies for the signed-in account. Offline access uses the last
 * authorized metadata; Core still authorizes every reconnect. Sign-out, locks, lost workspaces
 * and refused document access erase copies. Document identity is checked before reconciliation.
 */

const DB = 'nix-document-cache';
const STORE = 'bodies';
const MAX_BYTES = 8 * 1024 * 1024;
/** Who the store currently belongs to. Absent means closed. */
const SUBJECT_MARKER = 'nix.body-cache.subject';
const DRAFT_OWNER_MARKER = 'nix.draft.owner';
const DRAFT_EPOCH_MARKER = 'nix.draft.epoch.';
const SEALED_ACCOUNT_MARKER = 'nix.body-cache.sealed-account.';
const ACCOUNT_EPOCH_MARKER = 'nix.body-cache.epoch.';
const OPENING_MARKER = 'nix.body-cache.opening';
const SEALED_ITEM_MARKER = 'nix.body-cache.sealed-item.';
const scopeSchema = z.tuple([z.string(), z.string(), z.string(), z.string()]);
const itemSchema = z.tuple([z.string(), z.string(), z.string()]);

const recordSchema = z.object({
  scope: z.string().min(1),
  docId: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  serverSeq: z.string().regex(/^\d+$/u).max(20).optional(),
  savedAt: z.number().nonnegative(),
  // Checked by tag rather than `instanceof`: a structured clone can come back from another realm.
  update: z
    .custom<Uint8Array>((value) => Object.prototype.toString.call(value) === '[object Uint8Array]')
    .transform((value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
});

export interface BodyCacheRecord {
  readonly scope: string;
  readonly docId: string;
  readonly schemaVersion: number;
  /** A confirmed HTTP log cursor covered by this full state, retained across socket snapshots. */
  readonly serverSeq?: string | undefined;
  readonly savedAt: number;
  readonly update: Uint8Array;
}

export interface BodyCacheStore {
  read: (scope: string) => Promise<BodyCacheRecord | null>;
  write: (record: BodyCacheRecord, admitted?: () => boolean) => Promise<void>;
  discard: (scope: string) => Promise<void>;
  /** Known access refusal, which must also refuse later writes from another provider. */
  seal?: (scope: string, reason?: 'refused' | 'locked') => Promise<void>;
}

let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'scope' });
      store.createIndex('savedAt', 'savedAt');
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error ?? new Error('Document cache could not be opened.'));
    };
    request.onblocked = () => {
      database = undefined;
      reject(new Error('Document cache is blocked.'));
    };
  });
  return database;
}

function currentSubject(): string | null {
  try {
    return browserStorage()?.getItem(SUBJECT_MARKER) ?? null;
  } catch {
    return null;
  }
}

/** Admission identity shared across tabs; signing in again starts another lifecycle. */
export function bodyCacheAccountEpoch(subject: string): string | null {
  try {
    return browserStorage()?.getItem(ACCOUNT_EPOCH_MARKER + JSON.stringify(subject)) ?? null;
  } catch {
    return null;
  }
}

/** Destructive cleanup belongs only to the lifecycle captured by its caller. */
export function bodyCacheCleanupCurrent(subject: string, epoch: string | null): boolean {
  try {
    const storage = browserStorage();
    return storage?.getItem(ACCOUNT_EPOCH_MARKER + JSON.stringify(subject)) === epoch;
  } catch {
    return false;
  }
}

/** Pending edits retain their owner lifetime when confirmed-body access is refused. */
export function bodyCacheDraftEpoch(subject: string): string | null {
  try {
    return browserStorage()?.getItem(DRAFT_EPOCH_MARKER + JSON.stringify(subject)) ?? null;
  } catch {
    return null;
  }
}

export function bodyCacheDraftCurrent(subject: string, epoch: string | null): boolean {
  return bodyCacheAccountAdmits(subject) && bodyCacheDraftEpoch(subject) === epoch;
}

/** Cache lifecycle shared by every read, provider, and mutation of one document. */
export function bodyCacheScopeEpoch(scope: string): string | null {
  const subject = scopePart(scope, 0);
  return subject === null ? null : bodyCacheAccountEpoch(subject);
}

export function bodyCacheScopeCurrent(scope: string, epoch: string | null): boolean {
  const subject = scopePart(scope, 0);
  return subject !== null && bodyCacheCleanupCurrent(subject, epoch) && admits(scope);
}

function accountPrefix(subject: string): string {
  return `${JSON.stringify([subject]).slice(0, -1)},`;
}

/** One element of a scope's JSON array: 0 is the subject, 1 the workspace. */
function scopePart(scope: string, index: 0 | 1): string | null {
  try {
    const parsed: unknown = JSON.parse(scope);
    return Array.isArray(parsed) && typeof parsed[index] === 'string' ? parsed[index] : null;
  } catch {
    return null;
  }
}

/**
 * Known locks and access refusals survive reloads and are shared with other tabs. The in-memory
 * set also closes this page immediately if the browser refuses to persist the shared marker.
 * An explicit account-cache reset clears the fences along with every confirmed copy.
 */
const sealedItems = new Map<string, string>();
const sealedAccounts = new Map<string, string | null>();

function sealReason(value: string | null): 'refused' | 'locked' | 'open' | null {
  if (value === null) return null;
  if (value.startsWith('refused:')) return 'refused';
  if (value.startsWith('open:')) return 'open';
  return 'locked';
}

function sealKey(subject: string, workspaceId: string, itemId: string): string {
  return SEALED_ITEM_MARKER + JSON.stringify([subject, workspaceId, itemId]);
}

/** Changes when an item is refused, even when fresh Core authorization later reopens it. */
export function bodyCacheFenceVersion(scope: string): string | null {
  try {
    const parts = scopeSchema.parse(JSON.parse(scope));
    return browserStorage()?.getItem(sealKey(parts[0], parts[1], parts[2])) ?? null;
  } catch {
    return 'storage-unavailable';
  }
}

/** The scope prefix every body of one item shares: `["subject","workspace","item",`. */
function itemPrefix(subject: string, workspaceId: string, itemId: string): string {
  return `${JSON.stringify([subject, workspaceId, itemId]).slice(0, -1)},`;
}

/** Whether the store is open for this scope's person right now, and the item is not sealed. */
function admits(scope: string): boolean {
  const subject = scopePart(scope, 0);
  if (subject === null || subject !== currentSubject()) return false;
  return !bodyCacheSealed(scope);
}

function bodyCacheSealedAccount(subject: string): boolean {
  const epoch = bodyCacheAccountEpoch(subject);
  if (sealedAccounts.has(subject) && sealedAccounts.get(subject) === epoch) return true;
  try {
    return (
      browserStorage()?.getItem(SEALED_ACCOUNT_MARKER + JSON.stringify(subject)) ===
      JSON.stringify(epoch)
    );
  } catch {
    return true;
  }
}

/** A known refusal, independent of whether this account's store is currently open. */
export function bodyCacheSealed(scope: string): boolean {
  const subject = scopePart(scope, 0);
  if (subject === null || bodyCacheSealedAccount(subject)) return true;
  for (const [prefix, value] of sealedItems)
    if (scope.startsWith(prefix) && sealReason(value) !== 'open') return true;
  try {
    const reason = sealReason(bodyCacheFenceVersion(scope));
    return reason !== null && reason !== 'open';
  } catch {
    return true;
  }
}

/**
 * Runs `run` in a transaction created in the same task as the `admitted` check, so a sign-out in
 * any tab either happens before the check (and refuses this) or queues its clear after this
 * transaction - IndexedDB runs overlapping read-write transactions in creation order.
 */
async function transaction<T>(
  mode: IDBTransactionMode,
  admitted: () => boolean,
  refused: T,
  run: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  const db = await open();
  if (!admitted()) return refused;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result: T = refused;
    tx.oncomplete = () => {
      resolve(result);
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('Document cache transaction failed.'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('Document cache write aborted.'));
    };
    run(tx.objectStore(STORE), (value) => {
      result = value;
    });
  });
}

const always = (): boolean => true;

/**
 * What must be forgotten, said to anything in memory that was derived from body copies.
 *
 * The phrase library (`phrase-library.ts`) learns from bodies this store admits, and what it
 * learned is document content in another shape. It has to follow every rule this store follows,
 * and the only way to guarantee that is to hear about every forgetting from the place that does
 * it - so each forgetting below announces itself, synchronously and before its IndexedDB work, so
 * memory is cleared even when the disk refuses.
 */
export type BodyForgetting =
  /** Sign-out, or a different person signing in: every body. */
  | {
      readonly kind: 'everything';
      readonly subject?: string;
      readonly epoch?: string | null;
      readonly sealed?: true;
    }
  /** One body: refused by the collaboration service, or joined to a different document. */
  | { readonly kind: 'scope'; readonly scope: string }
  /** Every body of one item, which is now known to carry a lock. `prefix` is its scope prefix. */
  | { readonly kind: 'item'; readonly prefix: string; readonly sealed?: true }
  /** Every body outside the workspaces this person can still reach. */
  | {
      readonly kind: 'unreachable';
      readonly subject: string;
      readonly reachableWorkspaceIds: ReadonlySet<string>;
    };

const forgettingListeners = new Set<(forgetting: BodyForgetting) => void>();

/** Hears every forgetting this store performs. Returns the unsubscribe. */
export function onBodyForgetting(listener: (forgetting: BodyForgetting) => void): () => void {
  forgettingListeners.add(listener);
  return () => {
    forgettingListeners.delete(listener);
  };
}

function announceForgetting(forgetting: BodyForgetting): void {
  for (const listener of forgettingListeners) {
    try {
      listener(forgetting);
    } catch (cause) {
      // One listener failing must not stop the others forgetting, or the store itself.
      console.warn('A body-forgetting listener failed.', cause);
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === SUBJECT_MARKER && event.newValue !== event.oldValue) {
      // Storage events can arrive after another account has already opened its store.
      if (event.newValue === currentSubject() && event.oldValue !== null) {
        const subject = event.oldValue;
        for (const prefix of sealedItems.keys())
          if (prefix.startsWith(accountPrefix(subject))) sealedItems.delete(prefix);
        announceForgetting({
          kind: 'everything',
          subject,
          epoch: bodyCacheAccountEpoch(subject),
          sealed: true,
        });
      }
    }
    if (event.key?.startsWith(SEALED_ACCOUNT_MARKER) && event.newValue !== null) {
      try {
        const subject = z.string().parse(JSON.parse(event.key.slice(SEALED_ACCOUNT_MARKER.length)));
        if (browserStorage()?.getItem(event.key) !== event.newValue) return;
        const epoch = z.string().nullable().parse(JSON.parse(event.newValue));
        if (!bodyCacheCleanupCurrent(subject, epoch)) return;
        sealedAccounts.set(subject, epoch);
        announceForgetting({ kind: 'everything', subject, epoch, sealed: true });
      } catch {
        // Malformed or superseded lifecycle events cannot change current admission.
      }
    }
    if (event.key?.startsWith(SEALED_ITEM_MARKER) && event.newValue !== null) {
      if (browserStorage()?.getItem(event.key) !== event.newValue) return;
      try {
        const item = itemSchema.parse(JSON.parse(event.key.slice(SEALED_ITEM_MARKER.length)));
        const prefix = itemPrefix(item[0], item[1], item[2]);
        sealedItems.set(prefix, event.newValue);
        if (sealReason(event.newValue) !== 'open')
          announceForgetting({ kind: 'item', prefix, sealed: true });
      } catch {
        // A malformed browser-storage entry cannot authorize a body or identify one to forget.
      }
    }
  });
}

function clearItemSeals(storage: Storage | undefined, subject?: string): void {
  if (subject === undefined) sealedItems.clear();
  else {
    for (const prefix of sealedItems.keys())
      if (prefix.startsWith(accountPrefix(subject))) sealedItems.delete(prefix);
  }
  if (storage === undefined) return;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (
      key?.startsWith(SEALED_ITEM_MARKER) &&
      (subject === undefined || key.startsWith(SEALED_ITEM_MARKER + accountPrefix(subject)))
    )
      keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

/**
 * Whether a body under `scope` may be held right now: its person is the one signed in and its
 * item is not sealed. The same rule every read and write here applies, for derived holders to ask.
 */
export function bodyCacheAdmits(scope: string): boolean {
  return admits(scope);
}

/** Account admission for pending-edit recovery; this does not grant access to a sealed body. */
export function bodyCacheAccountAdmits(subject: string): boolean {
  try {
    const storage = browserStorage();
    return (storage?.getItem(DRAFT_OWNER_MARKER) ?? currentSubject()) === subject;
  } catch {
    return false;
  }
}

/**
 * The scopes of the most recently saved copies in one workspace, newest first, at most `limit`.
 *
 * Keys only: the index cursor never loads a body, so listing costs the same however large the
 * bodies are. Reading one is still `readBodyCache`, with every check that applies.
 */
export async function listBodyCacheScopes(
  subject: string,
  workspaceId: string,
  limit: number,
): Promise<string[]> {
  const prefix = `${JSON.stringify([subject, workspaceId]).slice(0, -1)},`;
  const epoch = bodyCacheAccountEpoch(subject);
  return transaction<string[]>(
    'readonly',
    () => currentSubject() === subject && bodyCacheCleanupCurrent(subject, epoch),
    [],
    (store, done) => {
      const found: string[] = [];
      const cursor = store.index('savedAt').openKeyCursor(null, 'prev');
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (current === null || found.length >= limit) {
          done(
            currentSubject() === subject && bodyCacheCleanupCurrent(subject, epoch) ? found : [],
          );
          return;
        }
        const scope = current.primaryKey;
        if (typeof scope === 'string' && scope.startsWith(prefix) && admits(scope)) {
          found.push(scope);
        }
        current.continue();
      };
    },
  );
}

export async function readBodyCache(scope: string): Promise<BodyCacheRecord | null> {
  const epoch = bodyCacheScopeEpoch(scope);
  const record = await transaction<BodyCacheRecord | null>(
    'readonly',
    () => bodyCacheScopeCurrent(scope, epoch),
    null,
    (store, done) => {
      const request = store.get(scope);
      request.onsuccess = () => {
        const parsed = recordSchema.safeParse(request.result);
        done(
          parsed.success &&
            parsed.data.scope === scope &&
            parsed.data.update.byteLength <= MAX_BYTES
            ? parsed.data
            : null,
        );
      };
    },
  );
  return bodyCacheScopeCurrent(scope, epoch) ? record : null;
}

export async function writeBodyCache(
  record: BodyCacheRecord,
  admitted?: () => boolean,
): Promise<void> {
  if (record.update.byteLength > MAX_BYTES)
    throw new Error('This document exceeds the 8 MiB offline storage limit.');
  const subject = scopePart(record.scope, 0);
  const epoch = subject === null ? null : bodyCacheAccountEpoch(subject);
  await transaction<undefined>(
    'readwrite',
    () =>
      subject !== null &&
      bodyCacheCleanupCurrent(subject, epoch) &&
      admits(record.scope) &&
      (admitted?.() ?? true),
    undefined,
    (store, done) => {
      const request = store.get(record.scope);
      request.onsuccess = () => {
        const existing = recordSchema.safeParse(request.result);
        try {
          const compatible =
            existing.success &&
            existing.data.docId === record.docId &&
            existing.data.schemaVersion === record.schemaVersion;
          const update = compatible
            ? Y.mergeUpdates([existing.data.update, record.update])
            : record.update;
          const previousSeq = compatible ? existing.data.serverSeq : undefined;
          const serverSeq =
            previousSeq !== undefined &&
            (record.serverSeq === undefined || BigInt(previousSeq) > BigInt(record.serverSeq))
              ? previousSeq
              : record.serverSeq;
          if (update.byteLength > MAX_BYTES) {
            store.transaction.abort();
            return;
          }
          store.put({
            ...record,
            serverSeq,
            update,
            savedAt: Math.max(record.savedAt, existing.success ? existing.data.savedAt : 0),
          });
        } catch {
          store.transaction.abort();
        }
      };
      done(undefined);
    },
  );
}

/** Generic discards belong to their captured lifecycle, without refusing future authorization. */
export async function discardBodyCache(
  scope: string,
  expectedEpoch = bodyCacheScopeEpoch(scope),
): Promise<void> {
  const subject = scopePart(scope, 0);
  if (subject === null || !bodyCacheCleanupCurrent(subject, expectedEpoch))
    throw new Error('Offline cache cleanup was superseded by another session.');
  announceForgetting({ kind: 'scope', scope });
  const cleared = await transaction<boolean>(
    'readwrite',
    () => bodyCacheCleanupCurrent(subject, expectedEpoch),
    false,
    (store, done) => {
      store.delete(scope);
      done(true);
    },
  );
  if (!cleared) throw new Error('Offline cache cleanup was superseded by another session.');
}

/** An authoritative account refusal closes confirmed bodies immediately, preserving owned drafts. */
export async function sealAccountBodies(
  subject: string,
  expectedEpoch = bodyCacheAccountEpoch(subject),
): Promise<void> {
  if (!bodyCacheCleanupCurrent(subject, expectedEpoch))
    throw new Error('Offline cache closure was superseded by another session.');
  sealedAccounts.set(subject, expectedEpoch);
  const storage = browserStorage();
  try {
    storage?.setItem(
      SEALED_ACCOUNT_MARKER + JSON.stringify(subject),
      JSON.stringify(expectedEpoch),
    );
  } finally {
    if (storage?.getItem(SUBJECT_MARKER) === subject) storage.removeItem(SUBJECT_MARKER);
    announceForgetting({ kind: 'everything', subject, epoch: expectedEpoch, sealed: true });
  }
  if (typeof indexedDB !== 'undefined') await clearRecords(subject, expectedEpoch);
}

/** Fresh Core authentication may reopen a refused account; cached fallback never does. */
export async function openBodyCache(
  subject: string,
  options?: { readonly reauthorized?: boolean },
): Promise<void> {
  const storage = browserStorage();
  if (storage === undefined) return;
  const previousSubject = currentSubject();
  const previousOwner = storage.getItem(DRAFT_OWNER_MARKER);
  if (previousSubject === subject && !bodyCacheSealedAccount(subject)) {
    if (bodyCacheAccountEpoch(subject) === null)
      storage.setItem(ACCOUNT_EPOCH_MARKER + JSON.stringify(subject), crypto.randomUUID());
    if (bodyCacheDraftEpoch(subject) === null)
      storage.setItem(DRAFT_EPOCH_MARKER + JSON.stringify(subject), crypto.randomUUID());
    storage.setItem(DRAFT_OWNER_MARKER, subject);
    return;
  }
  const restoringOwner = previousSubject === null && previousOwner === subject;
  if (restoringOwner && !options?.reauthorized) return;
  const departingSubject = previousSubject ?? previousOwner;
  const departingEpoch = departingSubject === null ? null : bodyCacheAccountEpoch(departingSubject);
  const opening = crypto.randomUUID();
  storage.setItem(OPENING_MARKER, opening);
  storage.setItem(ACCOUNT_EPOCH_MARKER + JSON.stringify(subject), crypto.randomUUID());
  if (!restoringOwner || bodyCacheDraftEpoch(subject) === null)
    storage.setItem(DRAFT_EPOCH_MARKER + JSON.stringify(subject), crypto.randomUUID());
  storage.removeItem(SUBJECT_MARKER);
  if (!restoringOwner) storage.removeItem(DRAFT_OWNER_MARKER);
  if (departingSubject !== null)
    announceForgetting({
      kind: 'everything',
      subject: departingSubject,
      epoch: departingEpoch,
      sealed: true,
    });
  clearFrecency();
  clearSuggestionDismissals();
  clearRecentItems();
  const ownsOpening = (): boolean => storage.getItem(OPENING_MARKER) === opening;
  if (typeof indexedDB !== 'undefined')
    await clearRecords(restoringOwner ? subject : undefined, undefined, ownsOpening);
  if (!ownsOpening()) throw new Error('Offline cache admission was superseded by another session.');
  if (!restoringOwner) clearItemSeals(storage);
  sealedAccounts.delete(subject);
  storage.removeItem(SEALED_ACCOUNT_MARKER + JSON.stringify(subject));
  storage.setItem(DRAFT_OWNER_MARKER, subject);
  storage.setItem(SUBJECT_MARKER, subject);
}

/** Closes the store and removes every cached body. Called on sign-out, here or in another tab. */
export async function clearBodyCache(
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
    throw new Error('Offline cache cleanup was superseded by another session.');
  announceForgetting(
    expectedSubject === undefined
      ? { kind: 'everything' }
      : { kind: 'everything', subject: expectedSubject, epoch: epoch ?? null },
  );
  for (const key of [SUBJECT_MARKER, DRAFT_OWNER_MARKER]) {
    try {
      const storage = browserStorage();
      if (expectedSubject === undefined || storage?.getItem(key) === expectedSubject)
        storage?.removeItem(key);
    } catch {
      // Storage refused: records are still cleared below and journal sign-out fences remain.
    }
  }
  await clearRecords(expectedSubject, epoch);
  if (expectedSubject === undefined || bodyCacheCleanupCurrent(expectedSubject, epoch ?? null))
    clearItemSeals(browserStorage(), expectedSubject);
}

async function clearRecords(
  expectedSubject?: string,
  epoch?: string | null,
  admitted: () => boolean = expectedSubject === undefined
    ? always
    : () => bodyCacheCleanupCurrent(expectedSubject, epoch ?? null),
): Promise<void> {
  const cleared = await transaction<boolean>('readwrite', admitted, false, (store, done) => {
    if (expectedSubject === undefined) store.clear();
    else {
      const prefix = accountPrefix(expectedSubject);
      store.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    }
    done(true);
  });
  if (!cleared) throw new Error('Offline cache cleanup was superseded by another session.');
}

/**
 * Removes every body copy of an item that carries a lock - note, canvas, sheet or any other body
 * path - and refuses new ones until the account cache resets. Called whenever it reads a lock, open
 * or not, so a copy taken before the lock was applied does not outlive it.
 */
export async function sealItemBodies(
  subject: string,
  workspaceId: string,
  itemId: string,
  reason: 'locked' | 'refused' = 'locked',
): Promise<void> {
  const epoch = bodyCacheAccountEpoch(subject);
  const prefix = itemPrefix(subject, workspaceId, itemId);
  const key = sealKey(subject, workspaceId, itemId);
  let existing = sealedItems.get(prefix) ?? null;
  try {
    const stored = browserStorage()?.getItem(key) ?? null;
    if (sealReason(stored) === 'locked' || existing === null) existing = stored;
  } catch {
    // Cache admission already fails when the browser cannot read its account marker.
  }
  const value = `${sealReason(existing) === 'locked' ? 'locked' : reason}:${crypto.randomUUID()}`;
  sealedItems.set(prefix, value);
  announceForgetting({ kind: 'item', prefix, sealed: true });
  try {
    browserStorage()?.setItem(key, value);
  } catch {
    // A full localStorage can reject a new key while still permitting removal. Close all cache
    // admission across tabs rather than allow another editor to recreate this refused body.
    try {
      const storage = browserStorage();
      const owner = bodyCacheAccountAdmits(subject);
      if (storage?.getItem(SUBJECT_MARKER) === subject) storage.removeItem(SUBJECT_MARKER);
      // Older installations may lack this owner key. It is shorter than SUBJECT_MARKER, so
      // removing that existing key frees enough space for the same owner's recovery marker.
      if (owner && storage?.getItem(DRAFT_OWNER_MARKER) !== subject)
        storage?.setItem(DRAFT_OWNER_MARKER, subject);
    } catch {
      // Deletion on disk still runs even when browser storage also refuses removal.
    }
    announceForgetting({ kind: 'everything', subject, epoch, sealed: true });
  }
  const cleared = await transaction<boolean>(
    'readwrite',
    () => bodyCacheCleanupCurrent(subject, epoch),
    false,
    (store, done) => {
      store.delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      done(true);
    },
  );
  if (!cleared) throw new Error('Offline cache cleanup was superseded by another session.');
}

/** A collaboration refusal applies to the item's bodies; ordinary discards do not seal. */
export async function sealBodyCache(
  scope: string,
  reason: 'refused' | 'locked' = 'refused',
): Promise<void> {
  const parts = scopeSchema.parse(JSON.parse(scope));
  await sealItemBodies(parts[0], parts[1], parts[2], reason);
}

/** Caller must have fresh successful Core item authorization and a Core lock result of unlocked. */
export function reopenRefusedItemBodies(
  subject: string,
  workspaceId: string,
  itemId: string,
): void {
  if (currentSubject() !== subject) return;
  const key = sealKey(subject, workspaceId, itemId);
  const storage = browserStorage();
  const existing = storage?.getItem(key) ?? null;
  if (sealReason(sealedItems.get(itemPrefix(subject, workspaceId, itemId)) ?? null) === 'locked')
    return;
  if (sealReason(existing) !== 'refused') return;
  const value = `open:${existing?.slice('refused:'.length) ?? ''}`;
  storage?.setItem(key, value);
  sealedItems.set(itemPrefix(subject, workspaceId, itemId), value);
}

/**
 * Drops every copy that belongs to someone else or sits in a workspace this
 * person can no longer reach - run whenever the accessible workspace list arrives.
 */
export async function pruneBodyCache(
  subject: string,
  reachableWorkspaceIds: readonly string[],
): Promise<void> {
  const epoch = bodyCacheAccountEpoch(subject);
  if (currentSubject() !== subject) return;
  const reachable = new Set(reachableWorkspaceIds);
  announceForgetting({ kind: 'unreachable', subject, reachableWorkspaceIds: reachable });
  await transaction<undefined>(
    'readwrite',
    () => currentSubject() === subject && bodyCacheCleanupCurrent(subject, epoch),
    undefined,
    (store, done) => {
      const prefix = accountPrefix(subject);
      const cursor = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (current === null) return;
        const parsed = recordSchema.safeParse(current.value);
        const scope = typeof current.primaryKey === 'string' ? current.primaryKey : '';
        const workspace = scopePart(scope, 1);
        if (!parsed.success || workspace === null || !reachable.has(workspace)) {
          current.delete();
        }
        current.continue();
      };
      done(undefined);
    },
  );
}

export const indexedBodyCache: BodyCacheStore = {
  read: readBodyCache,
  write: writeBodyCache,
  discard: discardBodyCache,
  seal: sealBodyCache,
};

/**
 * The scope of one document body - who is reading it, where, and which body - shared by this
 * cache and the draft journal, so both stores agree on what "this person's copy" means.
 */
export function documentScope(
  subject: string | undefined,
  workspaceId: string | undefined,
  itemId: string,
  body: string,
): string | undefined {
  if (!subject || !workspaceId) return undefined;
  return JSON.stringify([subject, workspaceId, itemId, body]);
}
