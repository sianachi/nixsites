import { randomUUID } from 'node:crypto';

import { SCHEMA_VERSION } from '@nix/editor-schema';
import type { Pool } from 'pg';

import type { DocumentLocks } from '../db/advisory-lock.ts';
import { withTenantScope } from '../db/tenant-scope.ts';
import type { CollabMetrics } from '../metrics.ts';
import { CLOSE_CODES } from '../ws/protocol.ts';
import type { JoinResult, SessionHub, SocketSession } from '../ws/server.ts';
import { strategyFor } from './body-kinds.ts';
import { LIMITS, type RateWindow } from './limits.ts';
import { openDocument } from './service.ts';
import { DocumentSession, type SessionConfig } from './session.ts';

export interface RegistryConfig extends SessionConfig {
  /** How many documents may be resident at once. Past it, loads are refused, honestly. */
  readonly maxDocs: number;

  /** How many estimated resident bytes the process may hold. The second capacity wall. */
  readonly maxResidentBytes: number;

  /** How long a document may sit without sockets before it drains. */
  readonly idleEvictMs: number;

  /** How often the idle sweep runs. */
  readonly sweepMs: number;

  /** Unsent bytes all sockets may hold together. Defaults to `LIMITS.processBufferedBytes`. */
  readonly maxBufferedBytes?: number | undefined;

  /** How often that total is checked. Defaults to a second. */
  readonly backlogSweepMs?: number | undefined;
}

export interface DocumentHub extends SessionHub {
  /** Documents currently resident. For tests and gauges. */
  readonly size: number;

  /** Current accounted Yjs state plus pending update bytes. For capacity evidence. */
  readonly residentBytes: number;

  /** Drains everything: final flushes, snapshots, released claims. For shutdown. */
  shutdown(): Promise<void>;

  /**
   * Drops everything without owning it any longer: the lock session died, so every claim
   * this process held is already released and another instance may own these documents.
   * Best-effort flush, then sockets close with `ownedElsewhere` so clients re-route.
   */
  dropAll(): Promise<void>;

  /** Flushes resident documents from a staged operation before its atomic metadata swap. */
  flushItems(itemIds: readonly string[]): Promise<void>;

  /** Drains and closes staged documents so no socket can write after their atomic activation. */
  sealItems(itemIds: readonly string[]): Promise<void>;

  /** Evicts bodies Core already deleted, without flushing their abandoned pending state. */
  invalidateItems(itemIds: readonly string[]): Promise<void>;
}

/**
 * The registry: which documents are resident, and the front door for making one so.
 *
 * Everything scale-shaped funnels through `join`: the capacity walls (documents and
 * bytes), the ownership claim, the single load per document however many sockets arrive
 * at once, and the schema pin. Past the door, `DocumentSession` does the work; the
 * registry only decides what is allowed to exist.
 */
export function createDocumentRegistry(deps: {
  pool: Pool;
  locks: DocumentLocks;
  config: RegistryConfig;
  metrics?: CollabMetrics | undefined;
  newDocId?: (() => string) | undefined;
  onFlushed?: ((session: DocumentSession) => void) | undefined;
  rateWindow?: RateWindow | undefined;
  log?: ((message: string) => void) | undefined;
}): DocumentHub {
  const sessions = new Map<string, DocumentSession>();
  const sessionGenerations = new Map<string, number>();
  const generations = new Map<string, number>();
  const loading = new Map<string, LoadSlot>();
  let reservedDocuments = 0;
  let reservedBytes = 0;
  let residentBytes = 0;
  const accountedBytes = new Map<string, number>();
  const newDocId = deps.newDocId ?? randomUUID;

  const sweeper = setInterval(() => {
    void sweep();
  }, deps.config.sweepMs);
  sweeper.unref();

  const backlogSweeper = setInterval(() => {
    shedBacklog();
  }, deps.config.backlogSweepMs ?? 1_000);
  backlogSweeper.unref();

  /**
   * Holds every socket's unsent bytes, together, under one bound - cutting off the slowest first.
   *
   * Each socket is already bounded on its own as it is sent to; this is the bound on how many of
   * them can be near that at once. Checked on a clock rather than per send, because summing every
   * socket on every broadcast would cost more than the memory it protects.
   */
  function shedBacklog(): void {
    const budget = deps.config.maxBufferedBytes ?? LIMITS.processBufferedBytes;
    const backlogs = [...sessions.values()].flatMap((session) =>
      session.backlogs().map((backlog) => ({ ...backlog, session })),
    );
    let total = backlogs.reduce((sum, backlog) => sum + backlog.bytes, 0);
    if (total <= budget) {
      return;
    }
    for (const backlog of backlogs.sort((a, b) => b.bytes - a.bytes)) {
      if (total <= budget || backlog.bytes === 0) {
        break;
      }
      backlog.session.cutOff(backlog.socket);
      total -= backlog.bytes;
    }
  }

  function totalEstimatedBytes(): number {
    return residentBytes;
  }

  function publishGauges(): void {
    deps.metrics?.loadedDocuments.set(sessions.size);
    deps.metrics?.residentBytes.set(totalEstimatedBytes());
  }

  function addResident(session: DocumentSession): void {
    const bytes = session.estimatedBytes;
    residentBytes += bytes;
    accountedBytes.set(session.itemId, bytes);
  }

  function removeResident(itemId: string): void {
    residentBytes -= accountedBytes.get(itemId) ?? 0;
    accountedBytes.delete(itemId);
  }

  function resizeResident(
    session: DocumentSession,
    nextEstimatedBytes: number,
    force = false,
  ): boolean {
    const current = accountedBytes.get(session.itemId);
    if (current === undefined) {
      // Loads cannot receive frames before publication. A direct DocumentSession test has no
      // registry account at all, so there is likewise nothing process-wide to move.
      return true;
    }

    const nextTotal = residentBytes - current + nextEstimatedBytes;
    if (
      !force &&
      nextEstimatedBytes > current &&
      nextTotal + reservedBytes > deps.config.maxResidentBytes
    ) {
      return false;
    }

    residentBytes = nextTotal;
    accountedBytes.set(session.itemId, nextEstimatedBytes);
    publishGauges();
    return true;
  }

  async function sweep(): Promise<void> {
    const deadline = Date.now() - deps.config.idleEvictMs;
    for (const [itemId, session] of sessions) {
      const idleSince = session.idleSince;
      if (idleSince === null || idleSince > deadline || session.state === 'draining') {
        continue;
      }

      // One document failing to drain - its flush refused, its lock release lost - must not stop
      // the sweep from reaching the rest, or end the process from an unwatched timer. It stays
      // resident and the next sweep tries again.
      try {
        const unloaded = await session.drain();
        if (unloaded) {
          sessions.delete(itemId);
          sessionGenerations.delete(itemId);
          removeResident(itemId);
          await deps.locks.release(session.docRow.doc_id);
        }
      } catch (cause) {
        deps.log?.(`Could not evict idle item ${itemId}; will retry: ${describe(cause)}`);
      }
    }
    publishGauges();
  }

  async function acquire(socket: SocketSession): Promise<DocumentSession | JoinResult> {
    for (;;) {
      const generation = generations.get(socket.itemId) ?? 0;
      const existing = sessions.get(socket.itemId);
      if (existing !== undefined && existing.state !== 'unloaded') {
        return existing;
      }

      const inFlight = loading.get(socket.itemId);
      if (inFlight !== undefined) {
        // A reconnect authorized after a draft-save fence must not share the stale load. It waits
        // for that load to release its ownership claim, then starts under the new generation.
        if (inFlight.generation !== generation) {
          await inFlight.promise.catch(() => undefined);
          continue;
        }
        try {
          const settled = await inFlight.promise;
          return settled ?? notFound();
        } catch (cause) {
          return loadRefusal(cause);
        }
      }

      // Reserve both walls before the first await. Otherwise a burst of cold loads all observes
      // the same empty registry and can publish far beyond either configured capacity.
      const byteReservation = Math.min(LIMITS.documentBytes, deps.config.maxResidentBytes);
      if (sessions.size + reservedDocuments >= deps.config.maxDocs) {
        return documentCapacity();
      }
      if (
        byteReservation <= 0 ||
        totalEstimatedBytes() + reservedBytes + byteReservation > deps.config.maxResidentBytes
      ) {
        return memoryCapacity();
      }
      reservedDocuments += 1;
      reservedBytes += byteReservation;

      const slot: LoadSlot = {
        generation,
        promise: Promise.resolve(null),
        cancelled: false,
      };
      const load = (async (): Promise<DocumentSession | null> => {
        const { authorization } = socket;
        const scope = { tenantId: authorization.tenantId, principalId: authorization.principalId };
        const docRow = await withTenantScope(deps.pool, scope, (sql) =>
          openDocument(sql, scope.tenantId, socket.itemId, authorization.workspaceId, newDocId),
        );
        if (docRow === null) return null;

        const claimed = await deps.locks.acquire(docRow.doc_id);
        if (!claimed) throw new OwnedElsewhere(docRow.doc_id);

        try {
          const session = await DocumentSession.load(
            socket.itemId,
            docRow,
            scope,
            {
              pool: deps.pool,
              config: deps.config,
              metrics: deps.metrics,
              onFlushed: deps.onFlushed,
              resizeResident,
              rateWindow: deps.rateWindow,
              log: deps.log,
            },
            strategyFor(socket.authorization.bodyKind),
          );
          if (slot.cancelled || (generations.get(socket.itemId) ?? 0) !== generation) {
            session.invalidate();
            throw new LoadCancelled();
          }
          // Reservations are pessimistic; actual state is authoritative immediately before the
          // session becomes reachable from message dispatch.
          if (sessions.size >= deps.config.maxDocs) {
            session.invalidate();
            throw new AtCapacity('documents');
          }
          if (
            totalEstimatedBytes() + reservedBytes - byteReservation + session.estimatedBytes >
            deps.config.maxResidentBytes
          ) {
            session.invalidate();
            throw new AtCapacity('memory');
          }
          sessions.set(socket.itemId, session);
          sessionGenerations.set(socket.itemId, generation);
          addResident(session);
          return session;
        } catch (cause) {
          await deps.locks.release(docRow.doc_id);
          throw cause;
        }
      })();

      slot.promise = load;
      loading.set(socket.itemId, slot);
      try {
        const session = await load;
        return session ?? notFound();
      } catch (cause) {
        return loadRefusal(cause);
      } finally {
        reservedDocuments -= 1;
        reservedBytes -= byteReservation;
        if (loading.get(socket.itemId) === slot) loading.delete(socket.itemId);
        publishGauges();
      }
    }
  }

  return {
    get size(): number {
      return sessions.size;
    },

    get residentBytes(): number {
      return residentBytes;
    },

    async join(socket: SocketSession): Promise<JoinResult> {
      const acquired = await acquire(socket);
      if (!(acquired instanceof DocumentSession)) {
        return acquired;
      }

      if (socket.clientSchemaVersion < acquired.docRow.schema_version) {
        return {
          ok: false,
          closeCode: CLOSE_CODES.schemaMismatch,
          reason: `This document is pinned to schema version ${String(acquired.docRow.schema_version)}.`,
        };
      }

      // And the same question asked of this process. A replica left behind by a deploy that
      // has already migrated the corpus past it must refuse the document rather than
      // reinterpret it - which is exactly what the HTTP path does, and until now the socket
      // path did not, so the same document was writable over one transport and refused over
      // the other.
      if (acquired.docRow.schema_version > SCHEMA_VERSION) {
        return {
          ok: false,
          closeCode: CLOSE_CODES.schemaMismatch,
          reason:
            `This document is pinned to schema version ` +
            `${String(acquired.docRow.schema_version)} and this server speaks ` +
            `${String(SCHEMA_VERSION)}.`,
        };
      }

      acquired.attach(socket);
      publishGauges();
      return {
        ok: true,
        docId: acquired.docRow.doc_id,
        schemaVersion: acquired.docRow.schema_version,
      };
    },

    ready(socket: SocketSession): void {
      sessions.get(socket.itemId)?.beginSync(socket);
    },

    reauthorized(socket: SocketSession): void {
      sessions.get(socket.itemId)?.arbitrate();
    },

    handleMessage(socket: SocketSession, data: Uint8Array): void {
      sessions.get(socket.itemId)?.handleMessage(socket, data);
    },

    leave(socket: SocketSession): void {
      sessions.get(socket.itemId)?.detach(socket);
      publishGauges();
    },

    async refresh(itemId: string): Promise<void> {
      await sessions.get(itemId)?.catchUp();
    },

    async shutdown(): Promise<void> {
      clearInterval(sweeper);
      clearInterval(backlogSweeper);
      for (const [itemId, session] of [...sessions]) {
        session.closeSockets(CLOSE_CODES.draining, 'The server is shutting down.');
        try {
          await session.drain();
        } catch (cause) {
          // Every other document still deserves its final flush. What this one could not write is
          // still on its clients, which re-send it to whichever instance they reach next.
          deps.log?.(`Could not drain item ${itemId} at shutdown: ${describe(cause)}`);
        }
        sessions.delete(itemId);
        sessionGenerations.delete(itemId);
        removeResident(itemId);
        await deps.locks.release(session.docRow.doc_id).catch(() => undefined);
      }
      publishGauges();
    },

    async dropAll(): Promise<void> {
      clearInterval(sweeper);
      clearInterval(backlogSweeper);
      for (const [itemId, session] of [...sessions]) {
        sessions.delete(itemId);
        sessionGenerations.delete(itemId);
        removeResident(itemId);
        // Flushing is still safe - sequence allocation serialises on the head_seq row
        // lock whoever owns the document - and it is the last chance these updates get.
        await session.flush().catch(() => undefined);
        session.closeSockets(CLOSE_CODES.ownedElsewhere, 'This server lost its ownership session.');
        // Out of the registry, so nothing would ever evict it. What its last flush could not write
        // is on its clients, which re-send it to whichever instance owns the document now.
        session.invalidate();
      }
      publishGauges();
    },

    async flushItems(itemIds): Promise<void> {
      for (const itemId of itemIds) {
        await sessions.get(itemId)?.flush();
      }
    },

    async sealItems(itemIds): Promise<void> {
      for (const itemId of new Set(itemIds)) {
        const generation = (generations.get(itemId) ?? 0) + 1;
        generations.set(itemId, generation);
        const inFlight = loading.get(itemId);
        if (inFlight !== undefined && inFlight.generation < generation) {
          inFlight.cancelled = true;
          await inFlight.promise.catch(() => undefined);
        }
        const session = sessions.get(itemId);
        if (session === undefined || (sessionGenerations.get(itemId) ?? 0) >= generation) continue;
        // Remove the dispatch target first: a frame already queued behind this request cannot
        // enter the document while the close handshake and final drain are in progress.
        sessions.delete(itemId);
        sessionGenerations.delete(itemId);
        removeResident(itemId);
        session.closeSockets(CLOSE_CODES.revoked, 'This template draft is being saved.');
        try {
          await session.drain();
        } finally {
          // Out of the registry already, so nothing else would ever unload it. A drain that failed,
          // or that a socket still closing kept from unloading, would otherwise leave it retrying
          // and holding memory for the life of the process. The save sees the failure and refuses.
          if (session.state !== 'unloaded') {
            session.invalidate();
          }
          await deps.locks.release(session.docRow.doc_id);
        }
      }
      publishGauges();
    },

    async invalidateItems(itemIds): Promise<void> {
      for (const itemId of new Set(itemIds)) {
        generations.set(itemId, (generations.get(itemId) ?? 0) + 1);
        const inFlight = loading.get(itemId);
        if (inFlight !== undefined) {
          inFlight.cancelled = true;
          await inFlight.promise.catch(() => undefined);
        }
        const session = sessions.get(itemId);
        if (session === undefined) continue;
        sessions.delete(itemId);
        sessionGenerations.delete(itemId);
        removeResident(itemId);
        session.closeSockets(CLOSE_CODES.revoked, 'This template draft expired.');
        session.invalidate();
        await deps.locks.release(session.docRow.doc_id);
      }
      publishGauges();
    },
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface LoadSlot {
  readonly generation: number;
  promise: Promise<DocumentSession | null>;
  cancelled: boolean;
}

function notFound(): JoinResult {
  return { ok: false, closeCode: CLOSE_CODES.notFound, reason: 'No document body is visible.' };
}

function documentCapacity(): JoinResult {
  return {
    ok: false,
    closeCode: CLOSE_CODES.atCapacity,
    reason: 'This server is at its resident-document capacity. Retry shortly.',
  };
}

function memoryCapacity(): JoinResult {
  return {
    ok: false,
    closeCode: CLOSE_CODES.atCapacity,
    reason: 'This server is at its resident-memory capacity. Retry shortly.',
  };
}

function loadRefusal(cause: unknown): JoinResult {
  if (cause instanceof OwnedElsewhere) {
    return {
      ok: false,
      closeCode: CLOSE_CODES.ownedElsewhere,
      reason: 'Another instance owns this document.',
    };
  }
  if (cause instanceof AtCapacity) {
    return cause.wall === 'documents' ? documentCapacity() : memoryCapacity();
  }
  if (cause instanceof LoadCancelled) return notFound();
  throw cause;
}

class LoadCancelled extends Error {}

class AtCapacity extends Error {
  readonly wall: 'documents' | 'memory';

  constructor(wall: 'documents' | 'memory') {
    super(`The ${wall} capacity changed while this document was loading.`);
    this.wall = wall;
  }
}

class OwnedElsewhere extends Error {
  constructor(docId: string) {
    super(`Another instance holds the claim on document ${docId}.`);
    this.name = 'OwnedElsewhere';
  }
}
