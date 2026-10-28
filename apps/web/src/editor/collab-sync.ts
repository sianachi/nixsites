import { registerPendingWork } from '@nix/web-foundation/lib/pending-work';
import {
  bodyCacheFenceVersion,
  bodyCacheSealed,
  bodyCacheScopeCurrent,
  bodyCacheScopeEpoch,
  indexedBodyCache,
  onBodyForgetting,
  type BodyCacheStore,
} from '@nix/web-foundation/lib/body-cache';
import {
  createDraftJournal,
  type DraftState,
  type DraftRecord,
} from '@nix/web-foundation/lib/draft-journal';
import { SCHEMA_VERSION } from '@nix/editor-schema';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';

/**
 * The document body's transport: a WebSocket speaking the Yjs sync and awareness
 * protocols to the collaboration service.
 *
 * **Local edits apply to the document immediately.** The network is propagation, never the
 * thing between a keystroke and the screen - and the document itself is the offline queue:
 * a CRDT needs no buffer of unsent updates, because reconnecting replays the difference
 * through sync step 1 exactly as if nothing had been missed.
 *
 * **The handshake carries the token in the first frame**, not in the URL: browsers cannot
 * set headers on a WebSocket, and a token in a query string would land in every proxy log
 * between here and the server. Until the server answers `ready`, nothing else is sent.
 *
 * The connection state is reported in terms a writer can act on, and honestly: `live`
 * means edits are streaming, `pending` means edits exist that the server does not have
 * yet, `readonly` means the server said so, and `degraded` means the server is up but
 * cannot take this document right now.
 */

export type SyncState = 'connecting' | 'live' | 'pending' | 'readonly' | 'degraded' | 'offline';

/**
 * The Yjs root the prose editor binds to. One name, agreed with the collaboration
 * service; a mismatch would produce two documents that merge cleanly and share no text.
 */
/**
 * How long local updates are held before they are merged and sent.
 *
 * Short enough that a colleague sees typing as typing rather than in bursts - well inside the
 * ~100ms at which a delay stops feeling instant - and long enough that a pointer drag emitting
 * sixty updates a second leaves as roughly twelve frames rather than sixty. The server's ceiling
 * is ten a second per document, so this keeps a legitimate client an order of magnitude clear of
 * a limit that exists to catch a broken one.
 */
const FLUSH_MS = 80;

export const FRAGMENT_NAME = 'default';

/** Protocol frame types, mirrored from the collaboration service. */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_NOTICE = 2;
const MESSAGE_PERSISTENCE_BARRIER = 3;
const BARRIER_TIMEOUT_MS = 15_000;
/**
 * How the local copy is refreshed: once changes stop arriving for `SNAPSHOT_QUIET_MS`, and at
 * least every `SNAPSHOT_MAX_WAIT_MS` while they keep coming. Encoding a large document is tens of
 * milliseconds on the main thread, so a session watching a colleague type must not pay it on every
 * burst - and an unchanged document never pays it at all.
 */
const SNAPSHOT_QUIET_MS = 2_000;
const SNAPSHOT_MAX_WAIT_MS = 30_000;
/** The body cache's per-document ceiling; a larger document stops being encoded for it. */
const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

/** Close codes the provider reacts to by name. Everything else is a plain drop. */
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_REVOKED = 4403;
/** No such item, or not one this caller may see - the service's uniform non-answer at join. */
const CLOSE_NOT_FOUND = 4404;
/** The item is visible but its body is locked to this session; the page shows the lock prompt. */
const CLOSE_BODY_LOCKED = 4405;
const CLOSE_SCHEMA_MISMATCH = 4409;
const CLOSE_AT_CAPACITY = 4413;
const CLOSE_OWNED_ELSEWHERE = 4423;
const CLOSE_DRAINING = 1012;

/**
 * The socket surface this module needs - the browser's WebSocket satisfies it, and a test
 * can supply a fake without reaching for a network.
 */
export interface ProviderSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface CollabSyncOptions {
  readonly draftScope?: string;
  /**
   * Keeps a local copy of this body's last confirmed state under this scope, and paints it before
   * the connection opens. See `body-cache.ts` for what the copy may and may not be trusted with.
   */
  readonly cacheScope?: string | undefined;
  /** The store behind `cacheScope`. Defaults to IndexedDB; tests supply an in-memory one. */
  readonly bodyCache?: BodyCacheStore;
  /** Told when the saved copy has been painted, so the footer can say what is on screen. */
  readonly onLocalCopy?: () => void;
  readonly onDraftState?: (state: DraftState) => void;
  readonly itemId: string;
  /** Overrides the ordinary item WebSocket route for staged or library-only document aliases. */
  readonly documentPath?: string | undefined;
  readonly doc: Y.Doc;
  readonly fragmentName: string;
  readonly getAccessToken: (forceRefresh?: boolean) => Promise<string | null>;
  readonly onState: (state: SyncState) => void;
  readonly baseUrl?: string;

  /**
   * An awareness instance to carry, when the caller's editor plugins need it before the
   * provider exists. Owned by the caller, so destroying the provider leaves it alive.
   */
  readonly awareness?: awarenessProtocol.Awareness;

  /** Builds the socket. Defaults to the browser's WebSocket against the same origin. */
  readonly createSocket?: (url: string) => ProviderSocket;

  /** Reconnect backoff bounds, exposed for tests that should not wait real seconds. */
  readonly minRetryMs?: number;
  readonly maxRetryMs?: number;

  /**
   * Every notice the server sends, not only the `read_only` one this module already acts
   * on. A refused update carries a code (`document_too_many_nodes`, `document_too_large`,
   * `document_does_not_parse`, `rate_limited`) that `SyncState`'s six values have no room
   * for - they describe the connection, not one refused edit - so a caller that needs to
   * say something more specific than "saving locally" reads it here instead. Optional
   * because most editors have nothing more specific to say.
   */
  readonly onNotice?: (notice: { code: string; detail: string }) => void;

  /**
   * Told each time a connection has received the server's full copy of the document - on the
   * first connection and again after every reconnect. `live` alone does not say this: it is
   * reported when the socket is ready, before the server's state has arrived, and anything written
   * in that gap would be merged with a document the writer has not yet seen.
   */
  readonly onInitialSync?: () => void;
}

export interface CollabSync {
  /**
   * Presence: this client's cursor and everyone else's. Never persisted anywhere - the
   * server broadcasts it and forgets it.
   */
  readonly awareness: awarenessProtocol.Awareness;

  /** Flushes local frames and resolves only after the server has persisted every prior update. */
  readonly flushAndWait: () => Promise<void>;
  /** Waits for durable local draft writes, including storage failure reporting. */
  readonly flushLocal: () => Promise<void>;

  /** Closes the socket and stops reconnecting. The document itself keeps every edit. */
  destroy: () => void;
}

const DEFAULT_BASE_URL = '/collab';
const localProviders = new Map<string, Set<CollabSync>>();

/** Drains this account's editors before pending-edit inventory or sign-out. */
export async function flushLocalDraftsForAccount(subject: string): Promise<void> {
  const prefix = `${JSON.stringify([subject]).slice(0, -1)},`;
  await Promise.all(
    [...localProviders.entries()]
      .filter(([scope]) => scope.startsWith(prefix))
      .flatMap(([, providers]) => [...providers].map((provider) => provider.flushLocal())),
  );
}

export function startCollabSync(options: CollabSyncOptions): CollabSync {
  const {
    itemId,
    documentPath,
    doc,
    getAccessToken,
    onState,
    onNotice,
    baseUrl = DEFAULT_BASE_URL,
    minRetryMs = 1_000,
    maxRetryMs = 30_000,
  } = options;

  const createSocket =
    options.createSocket ??
    ((url: string): ProviderSocket => new WebSocket(resolveUrl(url)) as unknown as ProviderSocket);

  const draft =
    options.draftScope && typeof indexedDB !== 'undefined'
      ? createDraftJournal(options.draftScope, (state) => options.onDraftState?.(state))
      : null;
  let restoredDrafts: DraftRecord[] = [];
  const draftsReady = draft
    ?.read()
    .then((records) => {
      restoredDrafts = records;
    })
    .catch(() => {
      options.onDraftState?.('error');
      halted = true;
      failInitial(
        'Local drafts could not be read. Keep this device’s data until they can be recovered.',
      );
    });
  const cacheScope = options.cacheScope;
  const cache: BodyCacheStore | null =
    cacheScope === undefined
      ? null
      : (options.bodyCache ?? (typeof indexedDB === 'undefined' ? null : indexedBodyCache));
  const sharedScope = options.draftScope ?? cacheScope;
  const sharedCache = cache === indexedBodyCache || options.bodyCache === undefined;
  const initialCacheFence =
    sharedCache && sharedScope !== undefined ? bodyCacheFenceVersion(sharedScope) : null;
  const initialAccountEpoch =
    sharedCache && sharedScope !== undefined ? bodyCacheScopeEpoch(sharedScope) : null;
  let cacheInvalid = false;

  function cacheWriteAdmitted(): boolean {
    return (
      !cacheInvalid &&
      (!sharedCache ||
        sharedScope === undefined ||
        (bodyCacheFenceVersion(sharedScope) === initialCacheFence &&
          bodyCacheScopeCurrent(sharedScope, initialAccountEpoch)))
    );
  }
  /** The server document the cached copy was taken from, compared against the one we join. */
  let cachedDocId: string | null = null;
  /** The server document this connection joined, known once `ready` arrives. */
  let serverDocId: string | null = null;
  /** Whether this connection has received the server's full state since `ready`. */
  let initialSynced = false;
  /** Set when the cached copy turned out to belong to a different document; no further syncing. */
  let halted = false;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the document holds a confirmed change the local copy does not have yet. */
  let snapshotDirty = false;
  /** When the oldest unsaved change arrived, for the max-wait ceiling. */
  let dirtySince = 0;
  /** Latched once the document outgrows the cache, so it is not re-encoded only to be refused. */
  let oversize = false;
  const cacheReady =
    cache === null || cacheScope === undefined
      ? undefined
      : cache
          .read(cacheScope)
          .then((record) => {
            if (record === null || isDestroyed()) return;
            if (sharedCache && !cacheWriteAdmitted()) return;
            if (record.schemaVersion !== SCHEMA_VERSION) {
              void cache.discard(cacheScope).catch(() => undefined);
              return;
            }
            Y.applyUpdate(doc, record.update, CACHE_ORIGIN);
            cachedDocId = record.docId;
          })
          .catch(() => {
            // An unreadable copy is only a slower first paint; drop it and sync normally.
            void cache.discard(cacheScope).catch(() => undefined);
          });
  let localRevision = 0;
  let confirmedRevision = 0;
  let confirming: Promise<void> | null = null;
  let writeRefused = false;
  const hasWriteRefusal = (): boolean => writeRefused;
  const browserWindow = typeof window === 'undefined' ? undefined : window;
  const browserDocument = typeof document === 'undefined' ? undefined : document;
  let connecting = false;
  let forceTokenRefresh = false;
  const restoreOrigin = Symbol('restored-draft');

  const ownsAwareness = options.awareness === undefined;
  const awareness = options.awareness ?? new awarenessProtocol.Awareness(doc);

  let socket: ProviderSocket | null = null;
  let destroyed = false;
  let mode: 'write' | 'read' = 'write';
  let ready = false;
  let retryMs = minRetryMs;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether local edits exist the server has not seen - the honest half of "saved". */
  let unsynced = false;
  let initialFailure: Error | null = null;
  const initialWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

  function failInitial(message: string): void {
    initialFailure = new Error(message);
    for (const waiter of initialWaiters) waiter.reject(initialFailure);
    initialWaiters.clear();
  }

  const localReady = Promise.all([draftsReady, cacheReady])
    .then(async () => {
      if (isDestroyed()) return;
      if (halted) return;
      if (initialCacheFence === 'storage-unavailable') {
        halted = true;
        mode = 'read';
        failInitial('This device’s offline storage could not be read. Reconnect before editing.');
        onState('readonly');
        onNotice?.({ code: 'offline_copy_unavailable', detail: initialFailure?.message ?? '' });
        return;
      }
      if (
        sharedScope !== undefined &&
        sharedCache &&
        (bodyCacheSealed(sharedScope) || !cacheWriteAdmitted())
      ) {
        halted = true;
        mode = 'read';
        failInitial(
          'Access to this note was refused. Pending edits remain on this device for export and recovery.',
        );
        onState('readonly');
        onNotice?.({ code: 'body_access_unavailable', detail: initialFailure?.message ?? '' });
        return;
      }
      for (const record of restoredDrafts) {
        if (record.docId !== undefined && cachedDocId !== null && record.docId !== cachedDocId) {
          halted = true;
          failInitial('A local draft belongs to a different document.');
          onNotice?.({ code: 'local_copy_stale', detail: initialFailure?.message ?? '' });
          options.onDraftState?.('error');
          return;
        }
        try {
          Y.applyUpdate(doc, record.update, restoreOrigin);
        } catch {
          halted = true;
          failInitial('A saved draft could not be recovered.');
          options.onDraftState?.('error');
          onNotice?.({ code: 'local_draft_unreadable', detail: initialFailure?.message ?? '' });
          return;
        }
      }
      if (restoredDrafts.length > 0) {
        localRevision += 1;
        unsynced = true;
        report();
      }
      if (cachedDocId !== null) await draft?.bindDocument(cachedDocId, cacheWriteAdmitted);
      if (
        cachedDocId !== null ||
        restoredDrafts.some((record) => record.id === `${options.draftScope ?? ''}:published-local`)
      )
        options.onLocalCopy?.();
    })
    .catch((cause: unknown) => {
      options.onDraftState?.('error');
      failInitial(cause instanceof Error ? cause.message : 'Local document recovery failed.');
    });

  function isDestroyed(): boolean {
    return destroyed;
  }

  function isHalted(): boolean {
    return halted;
  }

  function report(): void {
    if (destroyed) {
      return;
    }
    if (ready) {
      onState(mode === 'read' ? 'readonly' : 'live');
    } else if (unsynced) {
      onState('pending');
    }
  }

  const stopBodyForgetting = onBodyForgetting((forgetting) => {
    if (!sharedCache || sharedScope === undefined) return;
    const matches =
      forgetting.kind === 'item'
        ? forgetting.sealed && sharedScope.startsWith(forgetting.prefix)
        : forgetting.kind === 'everything' &&
          forgetting.sealed &&
          forgetting.subject !== undefined &&
          sharedScope.startsWith(`${JSON.stringify([forgetting.subject]).slice(0, -1)},`) &&
          (forgetting.epoch === undefined || forgetting.epoch === initialAccountEpoch);
    if (!matches) return;
    haltForAccess();
  });

  function haltForAccess(): void {
    if (cacheInvalid) return;
    cacheInvalid = true;
    halted = true;
    mode = 'read';
    ready = false;
    initialSynced = false;
    if (snapshotTimer !== null) clearTimeout(snapshotTimer);
    snapshotTimer = null;
    rejectBarriers('Access to the document was refused.');
    failInitial('Access to the note was refused. Pending edits remain on this device.');
    onState('readonly');
    onNotice?.({ code: 'body_access_unavailable', detail: initialFailure?.message ?? '' });
    socket?.close(1000, 'Access to the note was refused.');
  }

  function ensureAccess(): boolean {
    if (cacheWriteAdmitted()) return true;
    haltForAccess();
    return false;
  }

  function sendFrame(bytes: Uint8Array): void {
    if (ensureAccess() && ready && socket?.readyState === 1) {
      socket.send(bytes);
    }
  }

  /**
   * Local updates waiting to go out, and the timer that will send them.
   *
   * **Why they wait at all.** Yjs emits one update per transaction, and this used to put one
   * WebSocket frame on the wire for each. For prose that is roughly a frame per keystroke, which
   * is fine. For a canvas it is not: pointer movement reports a scene change on every frame, so
   * dragging one shape produces about sixty updates a second - and the server's per-principal
   * ceiling is six hundred a minute. Ten seconds of dragging spent a whole minute's budget, and
   * one person on their own was refused as if they were a runaway client.
   *
   * Merging first is free, because that is what Yjs updates are: `mergeUpdates` produces one
   * update with the same effect as applying them in order, so a coalesced flush is not an
   * approximation of the sixty frames it replaces - it is the same edit, sent once.
   */
  let pending: Uint8Array[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let barrierSequence = 0;
  const barriers = new Map<
    string,
    {
      readonly resolve: () => void;
      readonly reject: (reason: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();

  function rejectBarriers(detail: string): void {
    for (const barrier of barriers.values()) {
      clearTimeout(barrier.timer);
      barrier.reject(new Error(detail));
    }
    barriers.clear();
  }

  function persistenceBarrier(): Promise<void> {
    const current = socket;
    if (current === null || !ready || current.readyState !== 1)
      return Promise.reject(new Error('The document is not connected.'));
    barrierSequence += 1;
    const barrierId = `${String(doc.clientID)}-${String(barrierSequence)}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        barriers.delete(barrierId);
        reject(new Error('The document changes were not confirmed in time.'));
      }, BARRIER_TIMEOUT_MS);
      barriers.set(barrierId, { resolve, reject, timer });
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_PERSISTENCE_BARRIER);
      encoding.writeVarString(encoder, barrierId);
      try {
        current.send(encoding.toUint8Array(encoder));
      } catch (reason) {
        clearTimeout(timer);
        barriers.delete(barrierId);
        reject(reason instanceof Error ? reason : new Error('The document could not be saved.'));
      }
    });
  }

  async function cacheConfirmed(update: Uint8Array): Promise<void> {
    if (cache === null || cacheScope === undefined || serverDocId === null)
      throw new Error('The document has no offline storage or confirmed identity.');
    if (!cacheWriteAdmitted()) throw new Error('This provider’s offline access was refused.');
    if (update.byteLength > SNAPSHOT_MAX_BYTES)
      throw new Error('This note exceeds the 8 MiB offline storage limit.');
    const savedAt = Date.now();
    const docId = serverDocId;
    try {
      await cache.write(
        { scope: cacheScope, docId, schemaVersion: SCHEMA_VERSION, savedAt, update },
        cacheWriteAdmitted,
      );
      const saved = await cache.read(cacheScope);
      if (!cacheWriteAdmitted() || saved?.docId !== docId || saved.savedAt < savedAt)
        throw new Error('The document could not be retained on this device.');
    } catch (cause) {
      options.onDraftState?.('error');
      throw cause;
    }
  }

  function flushPending(): void {
    flushTimer = null;

    if (pending.length === 0 || !ensureAccess()) {
      return;
    }

    if (socket === null || !ready || socket.readyState !== 1 || mode === 'read') {
      // Kept, not dropped. They go out on the next flush after the socket comes back, and until
      // then `unsynced` is what makes the footer say so rather than claiming everything is saved.
      unsynced = true;
      report();
      return;
    }

    const merged = pending.length === 1 ? pending[0] : Y.mergeUpdates(pending);
    pending = [];

    if (merged === undefined) {
      return;
    }

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, merged);
    socket.send(encoding.toUint8Array(encoder));
  }

  function onDocUpdate(update: Uint8Array, origin: unknown): void {
    if (origin === REMOTE_ORIGIN) {
      // Only a change the server actually sent: an empty resync applies nothing and emits nothing.
      markSnapshotDirty();
      return;
    }
    if (origin === CACHE_ORIGIN) {
      return;
    }

    localRevision += 1;
    if (origin !== restoreOrigin) draft?.append(update);
    pending.push(update);
    if (!ensureAccess()) return;

    if (socket === null || !ready || socket.readyState !== 1 || mode === 'read') {
      unsynced = true;
      report();
      return;
    }

    flushTimer ??= setTimeout(flushPending, FLUSH_MS);
  }

  function onAwarenessUpdate(
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void {
    if (origin === REMOTE_ORIGIN) {
      return;
    }
    const changed = [...change.added, ...change.updated, ...change.removed];
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
    );
    sendFrame(encoding.toUint8Array(encoder));
  }

  doc.on('update', onDocUpdate);
  awareness.on('update', onAwarenessUpdate);

  /** Whether every edit made here is confirmed persisted, so the document is the server's state. */
  function settled(): boolean {
    return (
      ready &&
      initialSynced &&
      !writeRefused &&
      !unsynced &&
      pending.length === 0 &&
      localRevision === confirmedRevision
    );
  }

  function saveSnapshot(): void {
    if (snapshotTimer !== null) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    if (
      cache === null ||
      !cacheWriteAdmitted() ||
      cacheScope === undefined ||
      serverDocId === null ||
      !snapshotDirty ||
      oversize ||
      !settled()
    )
      return;
    const update = Y.encodeStateAsUpdate(doc);
    if (update.byteLength > SNAPSHOT_MAX_BYTES) {
      oversize = true;
      options.onDraftState?.('error');
      onNotice?.({
        code: 'offline_document_too_large',
        detail: 'This note exceeds the 8 MiB offline storage limit.',
      });
      return;
    }
    snapshotDirty = false;
    void cache
      .write(
        {
          scope: cacheScope,
          docId: serverDocId,
          schemaVersion: SCHEMA_VERSION,
          savedAt: Date.now(),
          update,
        },
        cacheWriteAdmitted,
      )
      .catch(() => {
        // The copy is derived and only speeds up the next open; a refused write loses nothing.
        snapshotDirty = true;
      });
  }

  function markSnapshotDirty(): void {
    if (cache === null || oversize) return;
    if (!snapshotDirty) dirtySince = Date.now();
    snapshotDirty = true;
    scheduleSnapshot();
  }

  /** A trailing debounce with a ceiling: quiet for a moment, or long enough that it must. */
  function scheduleSnapshot(): void {
    if (cache === null || destroyed || !snapshotDirty || oversize) return;
    if (snapshotTimer !== null) clearTimeout(snapshotTimer);
    const overdue = Date.now() - dirtySince >= SNAPSHOT_MAX_WAIT_MS;
    snapshotTimer = setTimeout(saveSnapshot, overdue ? 0 : SNAPSHOT_QUIET_MS);
  }

  function discardCache(refused = false, reason: 'refused' | 'locked' = 'refused'): void {
    cachedDocId = null;
    if (snapshotTimer !== null) {
      clearTimeout(snapshotTimer);
      snapshotTimer = null;
    }
    if (refused && sharedScope !== undefined && sharedCache && typeof indexedDB !== 'undefined') {
      void indexedBodyCache.seal?.(sharedScope, reason).catch(() => undefined);
      return;
    }
    if (cache !== null && cacheScope !== undefined)
      void (
        refused && cache.seal ? cache.seal(cacheScope, reason) : cache.discard(cacheScope)
      ).catch(() => undefined);
  }

  function scheduleReconnect(delayMs: number): void {
    if (destroyed || halted || retryTimer !== null) {
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, jittered(delayMs));
  }

  async function connect(): Promise<void> {
    if (destroyed || halted || connecting) {
      return;
    }

    connecting = true;
    await localReady;
    if (isHalted()) {
      connecting = false;
      return;
    }
    const token = await getAccessToken(forceTokenRefresh).catch(() => null);
    if (token !== null) forceTokenRefresh = false;
    connecting = false;
    if (!ensureAccess()) return;
    if (isDestroyed()) {
      // destroy() may have run while the token was being fetched; the narrowing above
      // cannot see that, so the check goes through a call the compiler treats as opaque.
      return;
    }
    if (token === null) {
      onState('offline');
      scheduleReconnect(retryMs);
      retryMs = Math.min(retryMs * 2, maxRetryMs);
      return;
    }

    const next = createSocket(documentPath ?? `${baseUrl}/documents/${itemId}/ws`);
    next.binaryType = 'arraybuffer';
    socket = next;
    ready = false;

    next.onopen = () => {
      next.send(JSON.stringify({ type: 'auth', token, schemaVersion: SCHEMA_VERSION }));
    };

    next.onmessage = (event) => {
      handleMessage(next, event.data);
    };

    next.onerror = () => {
      // onclose follows; reacting twice would double the backoff bookkeeping.
    };

    next.onclose = (event) => {
      if (socket !== next) {
        return;
      }
      socket = null;
      ready = false;
      initialSynced = false;
      rejectBarriers('The document disconnected before its changes were confirmed.');
      failInitial('The document disconnected before its download was confirmed.');

      if (destroyed || halted) {
        return;
      }

      // Everyone else's presence is stale the moment the wire is gone; keeping their
      // cursors on screen would be showing people who may have left.
      awarenessProtocol.removeAwarenessStates(
        awareness,
        [...awareness.getStates().keys()].filter((id) => id !== doc.clientID),
        REMOTE_ORIGIN,
      );

      const verdict = classifyClose(event.code);
      if (event.code === CLOSE_UNAUTHENTICATED) forceTokenRefresh = true;
      onState(verdict.state);
      if (event.code === CLOSE_SCHEMA_MISMATCH) {
        onNotice?.({
          code: 'schema_version_mismatch',
          detail:
            'This document requires a newer version of Nix. Reload to update before making more changes.',
        });
      }
      if (
        event.code === CLOSE_REVOKED ||
        event.code === CLOSE_NOT_FOUND ||
        event.code === CLOSE_BODY_LOCKED
      ) {
        // No body this device may no longer read stays readable from it.
        cacheInvalid = true;
        discardCache(true, event.code === CLOSE_BODY_LOCKED ? 'locked' : 'refused');
        halted = true;
        mode = 'read';
        onState('readonly');
        onNotice?.({
          code: event.code === CLOSE_REVOKED ? 'access_revoked' : 'body_access_unavailable',
          detail:
            event.code === CLOSE_BODY_LOCKED
              ? 'This note is locked. Pending edits remain on this device.'
              : 'Access to this note is unavailable. Pending edits remain on this device.',
        });
      }
      scheduleReconnect(verdict.delayMs ?? retryMs);
      if (verdict.delayMs === undefined) {
        retryMs = Math.min(retryMs * 2, maxRetryMs);
      }
    };
  }

  function handleMessage(from: ProviderSocket, data: unknown): void {
    if (destroyed || halted || from !== socket || !ensureAccess()) return;
    if (typeof data === 'string') {
      const frame = JSON.parse(data) as { type?: string; mode?: string; docId?: unknown };
      if (frame.type === 'ready') {
        const joined = typeof frame.docId === 'string' ? frame.docId : null;
        const draftIdentities = restoredDrafts.map((record) => record.docId);
        const localIdentity = `local:${itemId}`;
        if (
          (cachedDocId !== null && joined !== cachedDocId) ||
          (serverDocId !== null && joined !== serverDocId) ||
          draftIdentities.some((identity) =>
            identity === undefined
              ? cachedDocId === null
              : identity !== joined && identity !== localIdentity,
          )
        ) {
          // The copy painted on open belongs to a different server document than the one this
          // item now has - or the service did not say which document it joined, which is the same
          // question left unanswered. Syncing would push its content into the new one, so stop here, drop
          // the copy, and ask for a reload, which opens the current document from scratch.
          halted = true;
          failInitial('The local copy belongs to another document.');
          discardCache();
          onState('degraded');
          onNotice?.({
            code: 'local_copy_stale',
            detail: 'This page changed while you were away. Reload to open the current version.',
          });
          from.close(1000, 'The local copy belongs to another document.');
          return;
        }
        serverDocId = joined;
        if (joined !== null)
          void draft?.bindDocument(joined, cacheWriteAdmitted).catch(() => {
            options.onDraftState?.('error');
          });
        initialFailure = null;
        initialSynced = false;
        ready = true;
        writeRefused = false;
        retryMs = minRetryMs;
        mode = frame.mode === 'read' ? 'read' : 'write';

        // Both sides open with sync step 1: the server's pulls this document's offline
        // edits, and this one pulls everything the server holds.
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(encoder, doc);
        from.send(encoding.toUint8Array(encoder));

        // Anything that accumulated while the socket was away goes out now. Sync step 1 above
        // would eventually reconcile it anyway, but not until the server answers - and until then
        // the footer would be claiming a connection while the edits sat here.
        if (pending.length > 0) {
          flushTimer ??= setTimeout(flushPending, FLUSH_MS);
        }

        // Presence resumes with the connection.
        const state = awareness.getLocalState();
        if (state !== null) {
          const awarenessEncoder = encoding.createEncoder();
          encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
          encoding.writeVarUint8Array(
            awarenessEncoder,
            awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]),
          );
          from.send(encoding.toUint8Array(awarenessEncoder));
        }

        unsynced = false;
        report();
      }
      return;
    }

    const bytes = toBytes(data);
    if (bytes === null || !ready) {
      return;
    }

    const decoder = decoding.createDecoder(bytes);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        const kind = syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE_ORIGIN);
        // Not after a refusal: the server's resync would be answered with the same refused
        // content, refused again, and resynced again at network speed.
        if (mode === 'write' && !writeRefused && encoding.length(encoder) > 1) {
          from.send(encoding.toUint8Array(encoder));
        }
        if (kind === syncProtocol.messageYjsSyncStep2) {
          initialSynced = true;
          for (const waiter of initialWaiters) waiter.resolve();
          initialWaiters.clear();
          options.onInitialSync?.();
          // The first copy of a document this device has none of is worth making even if the
          // server sent it as one unchanged-looking state; an existing copy waits for a change.
          if (cachedDocId === null) markSnapshotDirty();
          else scheduleSnapshot();
        }
        return;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          decoding.readVarUint8Array(decoder),
          REMOTE_ORIGIN,
        );
        return;
      }
      case MESSAGE_NOTICE: {
        const notice = JSON.parse(decoding.readVarString(decoder)) as {
          code?: string;
          detail?: string;
        };
        // A rate limit is not a refusal: the server resyncs once the window resets and the edit
        // is saved then, so it must not block confirmation, sign-out or updates meanwhile.
        if (notice.code === 'editable') {
          // The editor of a file with collaboration off left, and this session holds it now.
          mode = 'write';
          writeRefused = false;
          report();
          return;
        } else if (notice.code !== 'rate_limited') writeRefused = true;
        if (notice.code === 'read_only' || notice.code === 'editing_elsewhere') {
          // The server stopped accepting this session's writes - a revoked grant, told
          // honestly instead of silently dropping edits.
          mode = 'read';
          report();
        }
        if (typeof notice.code === 'string') {
          onNotice?.({ code: notice.code, detail: notice.detail ?? '' });
        }
        return;
      }
      case MESSAGE_PERSISTENCE_BARRIER: {
        const barrierId = decoding.readVarString(decoder);
        const barrier = barriers.get(barrierId);
        if (barrier === undefined) return;
        clearTimeout(barrier.timer);
        barriers.delete(barrierId);
        barrier.resolve();
        return;
      }
      default:
        return;
    }
  }

  onState('connecting');
  void connect();

  const sync: CollabSync = {
    awareness,
    flushAndWait(): Promise<void> {
      const current = socket;
      if (current === null || !ready || current.readyState !== 1 || mode === 'read') {
        return Promise.reject(
          new Error('The document must be connected and editable before its changes can be saved.'),
        );
      }
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushPending();

      return persistenceBarrier();
    },
    async flushLocal(): Promise<void> {
      await localReady;
      await draft?.snapshot();
      if (destroyed) unregisterLocalProvider();
      else if (halted && !cacheInvalid && initialFailure !== null) throw initialFailure;
    },
    destroy(): void {
      // Last chance for anything still waiting on the flush timer. Closing the editor is exactly
      // when a person expects their last keystroke to have counted, and up to `FLUSH_MS` of it is
      // held here by design.
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushPending();

      // Closing a settled document is the most useful moment to keep its copy: it is exactly what
      // the next open would otherwise wait for. Only if something changed since the last one.
      saveSnapshot();

      destroyed = true;
      stopBodyForgetting();
      // Keep a closing editor in the flush registry until its final owner edits are durable.
      // Refusal can unmount it synchronously while its IndexedDB writes are still queued.
      void (draft?.snapshot() ?? Promise.resolve()).then(unregisterLocalProvider, () => undefined);
      failInitial('The document was closed before its download completed.');
      unregisterPending();
      clearInterval(confirmationTimer);
      browserWindow?.removeEventListener('online', resume);
      browserWindow?.removeEventListener('pagehide', hidePresence);
      browserDocument?.removeEventListener('visibilitychange', visible);
      rejectBarriers('The editor closed before its changes were confirmed.');
      doc.off('update', onDocUpdate);
      awareness.off('update', onAwarenessUpdate);
      if (ownsAwareness) {
        awareness.destroy();
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
      socket?.close(1000, 'The editor closed.');
      socket = null;
    },
  };

  function unregisterLocalProvider(): void {
    if (options.draftScope === undefined) return;
    const providers = localProviders.get(options.draftScope);
    providers?.delete(sync);
    if (providers?.size === 0) localProviders.delete(options.draftScope);
  }
  async function confirm(): Promise<void> {
    if (confirming !== null) return confirming;
    if (localRevision === confirmedRevision || destroyed) return;
    confirming = (async () => {
      if (!initialSynced || serverDocId === null)
        throw new Error('The initial document sync has not completed.');
      await draft?.bindDocument(serverDocId, cacheWriteAdmitted);
      const revision = localRevision;
      const records = (await draft?.snapshot()) ?? [];
      const update = cache === null ? null : Y.encodeStateAsUpdate(doc);
      if (hasWriteRefusal()) throw new Error('The server refused an edit.');
      await sync.flushAndWait();
      if (hasWriteRefusal()) throw new Error('The server refused an edit.');
      if (update !== null) await cacheConfirmed(update);
      await draft?.acknowledge(records, cacheWriteAdmitted);
      restoredDrafts = restoredDrafts.filter(
        (record) =>
          !records.some((acked) => acked.id === record.id && acked.revision === record.revision),
      );
      confirmedRevision = revision;
      markSnapshotDirty();
    })();
    try {
      await confirming;
    } finally {
      confirming = null;
    }
  }
  const unregisterPending = registerPendingWork(async () => {
    if (hasWriteRefusal()) throw new Error('Resolve the refused edit before updating.');
    if (localRevision !== confirmedRevision) {
      await sync.flushAndWait();
      if (hasWriteRefusal()) throw new Error('Resolve the refused edit before updating.');
    }
  });
  const confirmationTimer = setInterval(() => {
    void confirm().catch(() => undefined);
  }, 2_000);
  let checkingConnection = false;
  const resume = (): void => {
    if (destroyed || halted || connecting) return;
    if (socket?.readyState === 1 && ready) {
      if (checkingConnection) return;
      checkingConnection = true;
      const current = socket;
      void persistenceBarrier()
        .catch(() => {
          if (socket !== current || destroyed || halted) return;
          current.close(1000, 'The editor did not respond.');
          resume();
        })
        .finally(() => {
          checkingConnection = false;
        });
      return;
    }
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const previous = socket;
    socket = null;
    ready = false;
    rejectBarriers('Reconnecting to confirm pending edits.');
    previous?.close(1000, 'Resuming the editor.');
    onState('connecting');
    void connect();
  };
  // Peers drop this person's presence the moment the page is hidden or leaves, not when the
  // awareness timeout finally expires.
  let hiddenPresence: Record<string, unknown> | null = null;
  const hidePresence = (): void => {
    const state = awareness.getLocalState();
    if (state === null) return;
    hiddenPresence = state;
    awareness.setLocalState(null);
  };
  const visible = (): void => {
    if (browserDocument?.visibilityState === 'visible') {
      if (hiddenPresence !== null && awareness.getLocalState() === null) {
        awareness.setLocalState(hiddenPresence);
      }
      hiddenPresence = null;
      resume();
    } else {
      hidePresence();
      // Hidden may be the last this page is seen alive - a phone reclaims a background tab without
      // an unload - so keep what is pending now rather than on a timer that may never fire.
      saveSnapshot();
    }
  };
  browserWindow?.addEventListener('online', resume);
  browserWindow?.addEventListener('pagehide', hidePresence);
  browserDocument?.addEventListener('visibilitychange', visible);
  if (options.draftScope !== undefined) {
    const providers = localProviders.get(options.draftScope) ?? new Set<CollabSync>();
    providers.add(sync);
    localProviders.set(options.draftScope, providers);
  }
  return sync;
}

/** How a close code translates into a state and a retry cadence. */
function classifyClose(code: number): { state: SyncState; delayMs?: number } {
  switch (code) {
    case CLOSE_UNAUTHENTICATED:
    case CLOSE_REVOKED:
      // The fix is a fresh token, which the next connect fetches anyway.
      return { state: 'offline' };
    case CLOSE_BODY_LOCKED:
      // Retrying cannot open it - only an unlock can, and the page re-reads the lock and closes
      // this editor itself. Back off rather than hammering a refusal that will not change.
      return { state: 'offline', delayMs: 30_000 };
    case CLOSE_SCHEMA_MISMATCH:
      // This build is older than the document. Retrying will not change that; reloading
      // the app will, and the footer copy says so.
      return { state: 'degraded', delayMs: 60_000 };
    case CLOSE_AT_CAPACITY:
    case CLOSE_OWNED_ELSEWHERE:
      // The server is up and said "not this document, not right now" - back off harder
      // than for a network blip, and keep the edits local meanwhile.
      return { state: 'degraded', delayMs: 5_000 };
    case CLOSE_DRAINING:
      // A rollout. The replacement is seconds away.
      return { state: 'offline', delayMs: 1_000 };
    default:
      return { state: 'offline' };
  }
}

function jittered(delayMs: number): number {
  return delayMs / 2 + Math.random() * (delayMs / 2);
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return null;
}

function resolveUrl(path: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${path}`;
}

/**
 * Marks updates that came from the server, so the local handler does not send them
 * straight back.
 *
 * A symbol rather than a string: origins are compared by identity, and a string could
 * collide with one some other plugin chose.
 */
const REMOTE_ORIGIN = Symbol('nix.collab.remote');

/**
 * Marks the cached copy applied on open. Like a remote update it is never sent or journalled as a
 * local edit: the server already holds it, and sync step 1 reconciles anything newer either way.
 */
const CACHE_ORIGIN = Symbol('nix.collab.cache');
