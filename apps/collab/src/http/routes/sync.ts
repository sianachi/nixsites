import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';

import { withTenantScope } from '../../db/tenant-scope.ts';
import { LIMITS } from '../../documents/limits.ts';
import {
  DocumentSyncRefusal,
  SYNC_LIMITS,
  syncDocument,
  type DocumentSyncResult,
} from '../../documents/sync.ts';
import { requestToken } from '../auth.ts';
import { refreshResident, type RouteDependencies } from '../context.ts';
import { decodeBase64 } from '../params.ts';
import { problem } from '../replies.ts';

interface SyncBody {
  documents: {
    itemId: string;
    expectedDocId?: string;
    stateVector: string;
    updates?: { clientId: string; update: string }[];
  }[];
}

const uuid = {
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
};
const base64 = (bytes: number) => ({
  type: 'string',
  minLength: 4,
  maxLength: 4 * Math.ceil(bytes / 3),
  pattern: '^[A-Za-z0-9+/]*={0,2}$',
});

/** Offline body copies use fresh, credential-specific Core authorization for every requested item. */
export function registerSyncRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  app.post<{ Body: SyncBody }>(
    '/documents/sync',
    {
      bodyLimit: SYNC_LIMITS.requestBytes,
      schema: {
        body: {
          type: 'object',
          required: ['documents'],
          additionalProperties: false,
          properties: {
            documents: {
              type: 'array',
              minItems: 1,
              maxItems: SYNC_LIMITS.documents,
              items: {
                type: 'object',
                required: ['itemId', 'stateVector'],
                additionalProperties: false,
                properties: {
                  itemId: uuid,
                  expectedDocId: uuid,
                  stateVector: base64(SYNC_LIMITS.stateVectorBytes),
                  updates: {
                    type: 'array',
                    maxItems: SYNC_LIMITS.updatesPerDocument,
                    items: {
                      type: 'object',
                      required: ['clientId', 'update'],
                      additionalProperties: false,
                      properties: {
                        clientId: { type: 'string', minLength: 1, maxLength: 200 },
                        update: base64(LIMITS.updateBytes),
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const token = requestToken(request, reply);
      if (token === null) return reply;

      const documents = request.body.documents;
      if (new Set(documents.map((doc) => doc.itemId.toLowerCase())).size !== documents.length) {
        return problem(reply, 400, 'invalid_body', 'Each item may be requested once per batch.');
      }

      const results: DocumentSyncResult[] = [];
      let responseBytes = Buffer.byteLength('{"documents":[]}');
      for (const requested of documents) {
        const itemId = requested.itemId.toLowerCase();
        const authorization = await deps.sessions.authenticate(token, itemId, true);
        if (!authorization.ok) {
          if (authorization.reason === 'unauthenticated') {
            return problem(reply, 401, 'unauthenticated', 'The token could not be validated.');
          }
          results.push(
            authorization.reason === 'unavailable'
              ? { itemId, status: 'unavailable', code: 'authorization_unavailable' }
              : { itemId, status: 'forbidden' },
          );
          continue;
        }

        const { tenantId, principalId, workspaceId, canWrite, bodyKind } = authorization.value;
        const pending = requested.updates ?? [];
        if (pending.length > 0 && !canWrite) {
          results.push({ itemId, status: 'rejected', code: 'read_only' });
          continue;
        }
        if (pending.length > 0 && requested.expectedDocId === undefined) {
          results.push({ itemId, status: 'rejected', code: 'expected_doc_id_required' });
          continue;
        }
        const stateVector = decodeBase64(requested.stateVector);
        const updates: { clientId: string; update: Uint8Array }[] = [];
        let invalid = stateVector === null || stateVector.byteLength > SYNC_LIMITS.stateVectorBytes;
        try {
          if (stateVector !== null) Y.decodeStateVector(stateVector);
          for (const pendingUpdate of pending) {
            const update = decodeBase64(pendingUpdate.update);
            if (update === null || update.byteLength > LIMITS.updateBytes) {
              invalid = true;
              break;
            }
            Y.decodeUpdate(update);
            updates.push({ clientId: pendingUpdate.clientId, update });
          }
        } catch {
          invalid = true;
        }
        if (invalid || stateVector === null) {
          results.push({ itemId, status: 'rejected', code: 'invalid_body' });
          continue;
        }
        if (updates.some(() => deps.rateWindow.exceeded(principalId, itemId))) {
          results.push({ itemId, status: 'rejected', code: 'rate_limited' });
          continue;
        }

        deps.onTenantSeen?.({ tenantId, principalId });
        let result: DocumentSyncResult;
        try {
          result = await withTenantScope(deps.pool, { tenantId, principalId }, (sql) =>
            syncDocument(sql, {
              document: {
                itemId,
                ...(requested.expectedDocId === undefined
                  ? {}
                  : { expectedDocId: requested.expectedDocId.toLowerCase() }),
                stateVector,
                updates,
              },
              tenantId,
              principalId,
              workspaceId,
              canWrite,
              bodyKind,
              newDocId: deps.newDocId,
              responseBytesAvailable: SYNC_LIMITS.responseBytes - responseBytes - 4096,
            }),
          );
        } catch (error) {
          if (error instanceof DocumentSyncRefusal) {
            result = error.result;
          } else {
            request.log.warn({ err: error, itemId }, 'Could not synchronize the document.');
            result = { itemId, status: 'unavailable', code: 'persistence_unavailable' };
          }
        }
        if (result.status === 'ok' && updates.length > 0) {
          await refreshResident(request, deps, itemId);
        }
        responseBytes += Buffer.byteLength(JSON.stringify(result)) + 1;
        results.push(result);
      }
      return reply.send({ documents: results });
    },
  );
}
