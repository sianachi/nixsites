/**
 * Agent-facing record, reference and upload resources.
 *
 * Responses are validated for the fields callers rely on and pass everything else through
 * untouched, so a field Core adds later reaches an agent without a client release.
 */

import { z } from 'zod';
import { defineCommand, defineQuery, type CommandEndpoint } from '../endpoints.js';
import { referencedBySchema } from '../schemas/attachments.js';
import { itemSchema, noContentSchema } from '../schemas/index.js';
import { operationSchema, type Operation } from '../schemas/operations.js';

const loose = z.looseObject;
const page = <T extends z.ZodType>(row: T) =>
  z.object({ items: z.array(row), nextCursor: z.string().nullable() });

export type JsonObject = Readonly<Record<string, unknown>>;

// ---- Records -------------------------------------------------------------------------------

const lookupSchema = z.object({
  matches: z.array(z.object({ item: itemSchema, trashed: z.boolean() })),
  truncated: z.boolean().default(false),
});
export type LookupResult = z.infer<typeof lookupSchema>;

/** Exact property match; Core canonicalises the value (URL host lowercased and so on). */
export const lookupItems = (
  workspaceId: string,
  input: { key: string; value: string; parentId?: string | undefined },
): CommandEndpoint<LookupResult> =>
  defineCommand({
    operation: 'records.lookup',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/lookup`,
    body: { key: input.key, value: input.value, parentId: input.parentId ?? null },
    schema: lookupSchema,
  });

export interface UpsertRecordInput {
  readonly keyField: string;
  readonly keyValue: string;
  readonly title?: string | undefined;
  readonly properties?: JsonObject | undefined;
  readonly type?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly strict?: boolean | undefined;
}

const upsertSchema = z.object({
  outcome: z.enum(['created', 'updated', 'unchanged']),
  item: itemSchema,
});
export type UpsertResult = z.infer<typeof upsertSchema>;

export const upsertRecord = (
  parentId: string,
  input: UpsertRecordInput,
): CommandEndpoint<UpsertResult> =>
  defineCommand({
    operation: 'records.upsert',
    method: 'POST',
    path: `/api/v1/items/${parentId}/records/upsert`,
    body: {
      keyField: input.keyField,
      keyValue: input.keyValue,
      title: input.title ?? null,
      properties: input.properties ?? null,
      type: input.type ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      strict: input.strict ?? true,
    },
    schema: upsertSchema,
    invalidates: [['items']],
  });

export interface BatchRow {
  readonly parentId: string;
  readonly keyField?: string | undefined;
  readonly keyValue?: string | undefined;
  readonly itemId?: string | undefined;
  readonly title?: string | undefined;
  readonly properties?: JsonObject | undefined;
  readonly type?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

const batchSchema = z.object({
  rows: z.array(
    loose({
      index: z.number(),
      status: z.enum(['created', 'updated', 'unchanged', 'error']),
      error: loose({ code: z.string(), message: z.string() }).nullish(),
    }),
  ),
  created: z.coerce.number(),
  updated: z.coerce.number(),
  unchanged: z.coerce.number(),
  failed: z.coerce.number(),
});
export type BatchResult = z.infer<typeof batchSchema>;

export const batchRecords = (
  workspaceId: string,
  rows: readonly BatchRow[],
  strict = true,
): CommandEndpoint<BatchResult> =>
  defineCommand({
    operation: 'records.batch',
    method: 'POST',
    path: `/api/v1/workspaces/${workspaceId}/records/batch`,
    body: { rows, strict },
    schema: batchSchema,
    invalidates: [['items'], ['workspaces', workspaceId, 'items']],
  });

// ---- References and pins -------------------------------------------------------------------

const referenceSchema = loose({ id: z.uuid(), targetItemId: z.uuid() });
export type ItemReference = z.infer<typeof referenceSchema>;

export const addReference = (
  holderItemId: string,
  input: {
    targetItemId: string;
    targetFileVersionId?: string | undefined;
    role?: string | undefined;
  },
): CommandEndpoint<ItemReference> =>
  defineCommand({
    operation: 'references.add',
    method: 'POST',
    path: `/api/v1/items/${holderItemId}/references`,
    body: {
      targetItemId: input.targetItemId,
      targetFileVersionId: input.targetFileVersionId ?? null,
      role: input.role ?? null,
    },
    schema: referenceSchema,
    invalidates: [['items'], ['attachments']],
  });

export const removeReference = (
  holderItemId: string,
  referenceId: string,
): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'references.remove',
    method: 'DELETE',
    path: `/api/v1/items/${holderItemId}/references/${referenceId}`,
    schema: noContentSchema,
    invalidates: [['items'], ['attachments']],
  });

export const listReferences = (itemId: string, limit?: number, cursor?: string) =>
  defineQuery({
    operation: 'references.list',
    path: `/api/v1/items/${itemId}/references`,
    query: { limit, cursor },
    schema: page(referenceSchema),
    cacheKey: ['items', itemId, 'references'],
    staleAfterMs: 0,
  });

export const listReferencedBy = (itemId: string, limit?: number, cursor?: string) =>
  defineQuery({
    operation: 'references.referencedBy',
    path: `/api/v1/items/${itemId}/referenced-by`,
    query: { limit, cursor },
    schema: page(referencedBySchema),
    cacheKey: ['items', itemId, 'referenced-by'],
    staleAfterMs: 0,
  });

// ---- Upload completion by id ---------------------------------------------------------------

/** Completes an upload the caller began elsewhere (an agent PUT the bytes itself). */
export const completeUploadById = (uploadId: string): CommandEndpoint<Operation> =>
  defineCommand({
    operation: 'files.upload.complete',
    method: 'POST',
    path: `/api/v1/files/uploads/${uploadId}/complete`,
    schema: operationSchema,
  });

// ---- Which operations the workspace's agent switches gate ----------------------------------

export type AgentGate = 'approve' | 'public-link';

/**
 * The operations a workspace owner switches on for agents: approving or revoking a file version,
 * and creating a public link. Everything else is open to agents under their ordinary scope.
 */
export function agentGate(operationId: string, body: unknown): AgentGate | undefined {
  if (operationId === 'CreatePublicLink') return 'public-link';
  if (operationId === 'SetFileVersionState') {
    const state = (body as { state?: unknown } | null | undefined)?.state;
    if (state === 'approved' || state === 'revoked') return 'approve';
  }
  return undefined;
}
