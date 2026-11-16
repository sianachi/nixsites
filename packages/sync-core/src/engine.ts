import { fromByteArray, toByteArray } from './base64.js';
import * as Y from 'yjs';
import { z } from 'zod';
import {
  BODY_SYNC_LIMITS,
  bodySyncRequestSchema,
  bodySyncResponseSchema,
  MirrorAccessRevokedError,
  MirrorHttpError,
  nativeChangesPageSchema,
  nativeReconcilePageSchema,
  nativeReplayResultSchema,
  nativeSnapshotPageSchema,
  type BodySyncRequest,
  type BodySyncResponse,
  type MirrorApi,
  type MirrorBody,
  type MirrorItem,
  type MirrorStore,
} from './mirror.js';

const pageSize = 200;
const leaseDurationMs = 60_000;
const maxOperationsPerPass = 200;

export interface SyncPassInput {
  workspaceId: string;
  ownerId: string;
  store: MirrorStore;
  api: MirrorApi;
  now?: () => number;
}

export type SyncPassResult =
  | { status: 'busy' }
  | { status: 'revoked'; scope: 'account' | 'workspace' }
  | {
      status: 'complete' | 'partial';
      /** Queued changes or note edits were left for another pass (a batch limit, not a conflict). */
      more: boolean;
      cursor: string;
      replayedOperations: number;
      syncedBodies: number;
      conflicts: number;
    };

class LeaseLostError extends Error {}

function checkItems(items: MirrorItem[], workspaceId: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.workspaceId !== workspaceId || seen.has(item.id)) {
      throw new Error('Mirror response contains an unexpected item');
    }
    if (item.locked && (item.canPersistBody || item.bodyDocId !== null || item.file !== null)) {
      throw new Error('Locked metadata cannot contain a body capability');
    }
    seen.add(item.id);
  }
}

function buildBodyRequest(body: MirrorBody): BodySyncRequest['documents'][number] {
  const doc = new Y.Doc();
  try {
    if (body.confirmedUpdate !== null) Y.applyUpdate(doc, body.confirmedUpdate);
    for (const pending of body.pending) Y.applyUpdate(doc, pending.update);
    const stateVector = fromByteArray(Y.encodeStateVector(doc));
    const updates: { clientId: string; update: string }[] = [];
    let encodedUpdateBytes = 0;
    if (body.docId !== null && body.item.canWrite) {
      for (const pending of body.pending.slice(0, BODY_SYNC_LIMITS.updatesPerDocument)) {
        const update = fromByteArray(pending.update);
        const bytes = update.length + 1024;
        if (encodedUpdateBytes + bytes > BODY_SYNC_LIMITS.requestBytes - 4096) break;
        updates.push({ clientId: pending.clientId, update });
        encodedUpdateBytes += bytes;
      }
    }
    const expectedDocId = body.docId ?? body.item.bodyDocId;
    return {
      itemId: body.item.id,
      stateVector,
      ...(expectedDocId === null ? {} : { expectedDocId }),
      updates,
    };
  } finally {
    doc.destroy();
  }
}

/** One document's share of a request: its JSON, plus room for non-ASCII client IDs in UTF-8. */
function documentBytes(document: BodySyncRequest['documents'][number]): number {
  return JSON.stringify(document).length + (document.updates?.length ?? 0) * 400;
}

/** `{"documents":[` and `]}` around the documents, with a comma between each pair. */
export function requestBytes(request: BodySyncRequest): number {
  return (
    16 +
    Math.max(0, request.documents.length - 1) +
    request.documents.reduce((sum, document) => sum + documentBytes(document), 0)
  );
}

function validateBodyResponse(response: BodySyncResponse, request: BodySyncRequest): void {
  const requested = new Map(request.documents.map((document) => [document.itemId, document]));
  const received = new Set<string>();
  let responseBytes = 0;
  for (const document of response.documents) {
    const input = requested.get(document.itemId);
    if (input === undefined || received.has(document.itemId)) {
      throw new Error('Body response contains an unexpected document');
    }
    received.add(document.itemId);
    if (document.status === 'ok') {
      responseBytes += document.update.length + document.stateVector.length + 4096;
      if (responseBytes > BODY_SYNC_LIMITS.responseBytes) {
        throw new Error('Body response exceeds the response limit');
      }
      if (input.expectedDocId !== undefined && input.expectedDocId !== document.docId) {
        throw new Error('Body response changed the confirmed document identity');
      }
      const submitted = new Set(input.updates?.map((update) => update.clientId));
      if (document.acknowledgedClientIds.some((clientId) => !submitted.has(clientId))) {
        throw new Error('Body response acknowledges an update that was not submitted');
      }
      Y.decodeUpdate(toByteArray(document.update));
      Y.decodeStateVector(toByteArray(document.stateVector));
    }
  }
  if (received.size !== requested.size || responseBytes > BODY_SYNC_LIMITS.responseBytes) {
    throw new Error('Body response is incomplete or exceeds the response limit');
  }
}

export async function runSyncPass(input: SyncPassInput): Promise<SyncPassResult> {
  const workspaceId = z.uuid().parse(input.workspaceId);
  const { api, store, ownerId } = input;
  const now = input.now ?? Date.now;
  function lease(): {
    workspaceId: string;
    ownerId: string;
    nowMs: number;
    expiresAtMs: number;
  } {
    const nowMs = now();
    return { workspaceId, ownerId, nowMs, expiresAtMs: nowMs + leaseDurationMs };
  }
  if (!(await store.acquireLease(lease()))) return { status: 'busy' };

  let revoked = false;
  const stats = { partial: false, replayedOperations: 0, syncedBodies: 0, conflicts: 0 };
  async function keepLease(): Promise<void> {
    if (!(await store.renewLease(lease()))) throw new LeaseLostError();
  }
  async function request<T>(send: () => Promise<T>): Promise<T> {
    await keepLease();
    const result = await send();
    await keepLease();
    return result;
  }

  async function bootstrap(forceRestart: boolean): Promise<void> {
    const checkpoint = await store.getCheckpoint(workspaceId);
    let boundary = forceRestart ? undefined : checkpoint.snapshot?.boundary;
    let cursor = forceRestart ? undefined : checkpoint.snapshot?.nextCursor;
    let reset = forceRestart || checkpoint.snapshot === null;
    let restarts = 0;
    for (;;) {
      const page = nativeSnapshotPageSchema.parse(
        await request(() =>
          api.snapshot({
            workspaceId,
            limit: pageSize,
            ...(boundary === undefined ? {} : { boundary }),
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
      );
      checkItems(page.items, workspaceId);
      if (page.resync) {
        if (++restarts > 3) throw new Error('Workspace changed repeatedly during bootstrap');
        await store.sealWorkspace(workspaceId);
        await reconcileKnownItems();
        await store.applySnapshotPage(workspaceId, page, true);
        boundary = undefined;
        cursor = undefined;
        reset = true;
        continue;
      }
      if (
        (boundary !== undefined && page.boundary !== boundary) ||
        (page.complete
          ? page.nextCursor !== null
          : page.nextCursor === null || page.nextCursor === cursor)
      ) {
        throw new Error('Snapshot response does not advance the captured boundary');
      }
      await store.applySnapshotPage(workspaceId, page, reset);
      if (page.complete) return;
      boundary = page.boundary;
      cursor = page.nextCursor ?? undefined;
      reset = false;
    }
  }

  async function pullChanges(): Promise<string> {
    let checkpoint = await store.getCheckpoint(workspaceId);
    if (checkpoint.sealed) {
      await reconcileKnownItems();
      await bootstrap(checkpoint.snapshot === null);
      checkpoint = await store.getCheckpoint(workspaceId);
    }
    if (checkpoint.cursor === null || checkpoint.snapshot !== null) {
      await bootstrap(false);
      checkpoint = await store.getCheckpoint(workspaceId);
    }
    let cursor = checkpoint.cursor;
    if (cursor === null) throw new Error('Bootstrap did not commit a mirror cursor');
    let restarts = 0;
    for (;;) {
      const after = cursor;
      const page = nativeChangesPageSchema.parse(
        await request(() => api.changes({ workspaceId, after, limit: pageSize })),
      );
      checkItems(page.items, workspaceId);
      if (page.resync) {
        if (++restarts > 3) throw new Error('Workspace changed repeatedly during reconciliation');
        await store.sealWorkspace(workspaceId);
        await reconcileKnownItems();
        await bootstrap(true);
        const rebuilt = await store.getCheckpoint(workspaceId);
        if (rebuilt.cursor === null) throw new Error('Rebuilt mirror has no cursor');
        cursor = rebuilt.cursor;
        continue;
      }
      if (BigInt(page.cursor) < BigInt(after) || (page.hasMore && page.cursor === after)) {
        throw new Error('Change feed cursor did not advance');
      }
      await store.applyChangesPage(workspaceId, page);
      cursor = page.cursor;
      if (!page.hasMore) return cursor;
    }
  }

  async function reconcileKnownItems(): Promise<void> {
    const known = await store.knownItemIds(workspaceId);
    for (let offset = 0; offset < known.length; offset += 500) {
      const itemIds = known.slice(offset, offset + 500);
      const page = nativeReconcilePageSchema.parse(
        await request(() => api.reconcile({ workspaceId, itemIds })),
      );
      checkItems(page.items, workspaceId);
      const requested = new Set(itemIds);
      const received = [
        ...page.items.map((item) => item.id),
        ...page.removed.map((item) => item.itemId),
      ];
      if (
        received.length !== requested.size ||
        new Set(received).size !== received.length ||
        received.some((itemId) => !requested.has(itemId))
      ) {
        throw new Error('Reconciliation did not account for the requested items');
      }
      await store.applyReconcilePage(workspaceId, page);
    }
  }

  async function replayOutbox(): Promise<void> {
    for (let count = 0; count < maxOperationsPerPass; count++) {
      const operation = await store.peekOutbox(workspaceId);
      if (operation === null) return;
      const result = nativeReplayResultSchema.parse(
        await request(() => api.replay({ workspaceId, operation })).catch((error: unknown) => {
          // The server will never take this operation as written (malformed, too large, its id
          // reused). Left at the head of the queue it would block every change behind it, so it
          // becomes a refusal the person can see, like one the server judged itself.
          if (error instanceof MirrorHttpError && [400, 409, 413, 422].includes(error.status))
            return {
              operationId: operation.operationId,
              status: 'refused',
              itemId: operation.itemId,
              revision: null,
              item: null,
              code: 'sync.replay_rejected',
            };
          throw error;
        }),
      );
      if (
        result.operationId !== operation.operationId ||
        (operation.kind !== 'create' &&
          operation.kind !== 'daily-note' &&
          result.itemId !== operation.itemId)
      ) {
        throw new Error('Replay response does not match the submitted operation');
      }
      if (result.item !== null) {
        checkItems([result.item], workspaceId);
        if (result.item.id !== result.itemId || result.item.revision !== result.revision) {
          throw new Error('Replay response contains inconsistent item metadata');
        }
      }
      if (result.status === 'applied' && operation.kind !== 'archive' && result.item === null) {
        throw new Error('An applied mutation must return its authoritative item');
      }
      await store.recordReplayResult(workspaceId, result);
      if (result.status === 'applied') stats.replayedOperations++;
      else stats.conflicts++;
    }
    if ((await store.peekOutbox(workspaceId)) !== null) stats.partial = true;
  }

  async function syncBatch(
    bodies: MirrorBody[],
    documents: BodySyncRequest['documents'],
  ): Promise<string[]> {
    const wireRequest = bodySyncRequestSchema.parse({ documents });
    if (requestBytes(wireRequest) > BODY_SYNC_LIMITS.requestBytes) {
      throw new Error('Body request exceeds the batch limit');
    }
    const response = bodySyncResponseSchema.parse(await request(() => api.syncBodies(wireRequest)));
    validateBodyResponse(response, wireRequest);
    const submitted = new Map(bodies.map((body) => [body.item.id, body]));
    const initialized: string[] = [];
    for (const document of response.documents) {
      if (document.status === 'ok') {
        await store.commitBodySync(workspaceId, document);
        stats.syncedBodies++;
        const body = submitted.get(document.itemId);
        if (body === undefined) throw new Error('Body response has no submitted document');
        if (body.docId !== null) {
          const remaining = await store.readBody(workspaceId, document.itemId);
          if ((remaining?.pending.length ?? 0) > 0) stats.partial = true;
        }
        if (body.docId === null && body.pending.length > 0 && document.canWrite) {
          initialized.push(document.itemId);
        }
        if (!document.canWrite && body.pending.length > 0) {
          await store.recordBodyFailure(workspaceId, {
            itemId: document.itemId,
            status: 'rejected',
            code: 'document_read_only',
          });
          stats.conflicts++;
        }
      } else {
        await store.recordBodyFailure(workspaceId, document);
        if (document.status === 'unavailable') stats.partial = true;
        else stats.conflicts++;
      }
    }
    return initialized;
  }

  async function syncBodies(): Promise<void> {
    let afterItemId: string | null = null;
    for (;;) {
      const candidates = await store.listBodyCandidates(
        workspaceId,
        afterItemId,
        BODY_SYNC_LIMITS.documents,
      );
      if (candidates.length === 0) return;
      const last = candidates.at(-1);
      if (last === undefined || last.item.id === afterItemId) {
        throw new Error('Body candidate pagination did not advance');
      }
      afterItemId = last.item.id;
      let batch: MirrorBody[] = [];
      let documents: BodySyncRequest['documents'] = [];
      let batchBytes = 16;
      const initialized: string[] = [];
      for (const body of candidates) {
        if (body.item.workspaceId !== workspaceId)
          throw new Error('Body candidate belongs to another workspace');
        if (!body.item.canPersistBody || body.item.locked || body.item.lifecycleState !== 'active')
          continue;
        let document: BodySyncRequest['documents'][number];
        try {
          const [parsed] = bodySyncRequestSchema.parse({
            documents: [buildBodyRequest(body)],
          }).documents;
          if (parsed === undefined) throw new Error('Missing body request');
          document = parsed;
        } catch {
          await store.recordBodyFailure(workspaceId, {
            itemId: body.item.id,
            status: 'rejected',
            code: 'invalid_local_update',
          });
          stats.conflicts++;
          continue;
        }
        // A running size: serializing the whole batch again for each candidate grew with its square.
        const bytes = documentBytes(document);
        if (documents.length > 0 && batchBytes + 1 + bytes > BODY_SYNC_LIMITS.requestBytes) {
          initialized.push(...(await syncBatch(batch, documents)));
          batch = [];
          documents = [];
          batchBytes = 16;
        }
        batchBytes += bytes + (documents.length > 0 ? 1 : 0);
        batch.push(body);
        documents.push(document);
      }
      if (documents.length > 0) initialized.push(...(await syncBatch(batch, documents)));
      for (const itemId of initialized) {
        const body = await store.readBody(workspaceId, itemId);
        if (
          body !== null &&
          body.docId !== null &&
          body.item.canWrite &&
          body.item.canPersistBody &&
          !body.item.locked
        ) {
          await syncBatch([body], [buildBodyRequest(body)]);
        }
      }
    }
  }

  try {
    // Once a pass, not around every request: the store also drops expired rows in each of its
    // own transactions, so repeating it here only doubled the cost of keeping the lease.
    await store.purgeExpired(workspaceId, now());
    const cursor = await pullChanges();
    await reconcileKnownItems();
    await store.unsealWorkspace(workspaceId);
    await replayOutbox();
    await syncBodies();
    return {
      status: stats.partial || stats.conflicts > 0 ? 'partial' : 'complete',
      more: stats.partial,
      cursor,
      replayedOperations: stats.replayedOperations,
      syncedBodies: stats.syncedBodies,
      conflicts: stats.conflicts,
    };
  } catch (error) {
    if (error instanceof MirrorAccessRevokedError) {
      revoked = true;
      if (error.scope === 'workspace') await store.wipeWorkspace(workspaceId);
      else await store.wipe();
      return { status: 'revoked', scope: error.scope };
    }
    if (error instanceof LeaseLostError) return { status: 'busy' };
    throw error;
  } finally {
    if (!revoked) await store.releaseLease(workspaceId, ownerId);
  }
}
