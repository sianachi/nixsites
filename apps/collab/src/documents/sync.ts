import * as Y from 'yjs';

import type { ContentDocRow } from '../db/documents.ts';
import { lockedAmong } from '../db/locks.ts';
import type { ScopedQuery } from '../db/tenant-scope.ts';
import { strategyFor } from './body-kinds.ts';
import { LIMITS } from './limits.ts';
import { applyUpdate, loadDocument, openDocument } from './service.ts';

export const SYNC_LIMITS = {
  documents: 20,
  updatesPerDocument: 64,
  stateVectorBytes: 64 * 1024,
  requestBytes: 8 * 1024 * 1024,
  responseBytes: 32 * 1024 * 1024,
} as const;

export interface DocumentSyncInput {
  readonly itemId: string;
  readonly expectedDocId?: string;
  readonly stateVector: Uint8Array;
  readonly updates: readonly { clientId: string; update: Uint8Array }[];
}

export interface DocumentSyncSuccess {
  readonly itemId: string;
  readonly status: 'ok';
  readonly docId: string;
  readonly headSeq: string;
  readonly schemaVersion: number;
  readonly canWrite: boolean;
  readonly update: string;
  readonly stateVector: string;
  readonly acknowledgedClientIds: readonly string[];
}

export type DocumentSyncResult =
  | DocumentSyncSuccess
  | { readonly itemId: string; readonly status: 'forbidden' }
  | {
      readonly itemId: string;
      readonly status: 'unavailable' | 'rejected';
      readonly code: string;
    };

/** Throwing keeps a refused upload group from committing an earlier accepted update. */
export class DocumentSyncRefusal extends Error {
  readonly result: Exclude<DocumentSyncResult, DocumentSyncSuccess>;

  constructor(result: Exclude<DocumentSyncResult, DocumentSyncSuccess>) {
    super(result.status);
    this.name = 'DocumentSyncRefusal';
    this.result = result;
  }
}

/** Runs inside one tenant transaction; callers publish its acknowledgement only after commit. */
export async function syncDocument(
  sql: ScopedQuery,
  input: {
    document: DocumentSyncInput;
    tenantId: string;
    principalId: string;
    workspaceId: string;
    canWrite: boolean;
    bodyKind: string;
    newDocId: () => string;
    responseBytesAvailable: number;
  },
): Promise<DocumentSyncSuccess> {
  const { document, tenantId } = input;
  // Core's lock and move writers hold this workspace key exclusively.
  await sql.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
    `finance-workspace:${input.workspaceId.toLowerCase()}`,
  ]);
  if ((await lockedAmong(sql, tenantId, [document.itemId])).has(document.itemId)) {
    throw new DocumentSyncRefusal({ itemId: document.itemId, status: 'forbidden' });
  }

  const opened = await openDocument(
    sql,
    tenantId,
    document.itemId,
    input.workspaceId,
    input.newDocId,
  );
  if (opened === null) {
    throw new DocumentSyncRefusal({ itemId: document.itemId, status: 'forbidden' });
  }

  // Hold the body replacement fence through validation, append and delta reconstruction.
  const { rows } = await sql.query<ContentDocRow>(
    `SELECT doc_id, item_id, workspace_id, schema_version, head_seq
       FROM content_doc
      WHERE tenant_id = $1 AND item_id = $2
      FOR UPDATE`,
    [tenantId, document.itemId],
  );
  let doc = rows[0];
  if (doc?.workspace_id !== input.workspaceId) {
    throw new DocumentSyncRefusal({ itemId: document.itemId, status: 'forbidden' });
  }
  if (document.expectedDocId !== undefined && document.expectedDocId !== doc.doc_id) {
    throw new DocumentSyncRefusal({
      itemId: document.itemId,
      status: 'rejected',
      code: 'document_changed',
    });
  }

  for (const update of document.updates) {
    const applied = await applyUpdate(sql, {
      tenantId,
      doc,
      updateBytes: update.update,
      actorId: input.principalId,
      clientId: update.clientId,
      snapshotEvery: 1,
      strategy: strategyFor(input.bodyKind),
    });
    if (!applied.ok) {
      throw new DocumentSyncRefusal({
        itemId: document.itemId,
        status: 'rejected',
        code: applied.error.code,
      });
    }
    doc = { ...doc, head_seq: applied.value.seq.toString() };
  }

  const state = await loadDocument(sql, tenantId, doc);
  let result: DocumentSyncSuccess;
  try {
    const update = Y.encodeStateAsUpdate(state, document.stateVector);
    if (update.byteLength > LIMITS.snapshotBytes) {
      throw new DocumentSyncRefusal({
        itemId: document.itemId,
        status: 'rejected',
        code: 'response_too_large',
      });
    }
    result = {
      itemId: document.itemId,
      status: 'ok',
      docId: doc.doc_id,
      headSeq: doc.head_seq,
      schemaVersion: doc.schema_version,
      canWrite: input.canWrite,
      update: Buffer.from(update).toString('base64'),
      stateVector: Buffer.from(Y.encodeStateVector(state)).toString('base64'),
      acknowledgedClientIds: document.updates.map((update) => update.clientId),
    };
  } finally {
    state.destroy();
  }

  if (Buffer.byteLength(JSON.stringify(result)) > input.responseBytesAvailable) {
    throw new DocumentSyncRefusal({
      itemId: document.itemId,
      status: 'rejected',
      code: 'response_too_large',
    });
  }
  return result;
}
