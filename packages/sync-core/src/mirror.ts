import { byteLength } from './base64.js';
import { z } from 'zod';

export const syncCursorSchema = z.string().regex(/^\d+$/);
const timestamp = z.iso.datetime({ offset: true });
const properties = z.record(z.string(), z.unknown());

export const mirrorScopeSchema = z.object({
  serverOrigin: z.url(),
  tenantId: z.string().min(1),
  principalId: z.string().min(1),
});
export type MirrorScope = z.infer<typeof mirrorScopeSchema>;

export const nativeItemSnapshotSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  parentId: z.uuid().nullable(),
  type: z.string(),
  title: z.string(),
  seq: z.union([z.int(), z.string().regex(/^-?\d+$/)]),
  revision: syncCursorSchema,
  lifecycleState: z.string(),
  properties,
  computedProperties: properties.nullable().default(null),
  schema: properties.nullable(),
  views: properties.nullable(),
  recurrence: properties.nullable(),
  noDelete: z.boolean(),
  noChildren: z.boolean(),
  managedBy: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp.nullable(),
  canWrite: z.boolean(),
  locked: z.boolean(),
  canPersistBody: z.boolean(),
  metadataExpiresAt: timestamp.nullable(),
  bodyDocId: z.uuid().nullable(),
  bodyHeadSeq: syncCursorSchema.nullable(),
  file: z
    .object({
      versionId: z.uuid(),
      fileName: z.string(),
      mediaType: z.string(),
      byteLength: z.number().int().nonnegative(),
      sha256: z.string(),
    })
    .nullable(),
});
export type NativeItemSnapshot = z.infer<typeof nativeItemSnapshotSchema>;
export type MirrorItem = NativeItemSnapshot;

export const nativeSnapshotPageSchema = z.object({
  boundary: syncCursorSchema,
  nextCursor: z.uuid().nullable(),
  complete: z.boolean(),
  resync: z.boolean(),
  items: z.array(nativeItemSnapshotSchema).max(500),
  serverTime: timestamp,
});
export type NativeSnapshotPage = z.infer<typeof nativeSnapshotPageSchema>;

export const nativeChangesPageSchema = z.object({
  cursor: syncCursorSchema,
  hasMore: z.boolean(),
  resync: z.boolean(),
  items: z.array(nativeItemSnapshotSchema).max(500),
  serverTime: timestamp,
});
export type NativeChangesPage = z.infer<typeof nativeChangesPageSchema>;

export const nativeReconcilePageSchema = z.object({
  items: z.array(nativeItemSnapshotSchema).max(500),
  removed: z.array(z.object({ itemId: z.uuid(), reason: z.literal('inaccessible') })).max(500),
  serverTime: timestamp,
});
export type NativeReconcilePage = z.infer<typeof nativeReconcilePageSchema>;

const operationEnvelope = {
  operationId: z.uuid(),
  itemId: z.uuid(),
};
const writeEnvelope = { ...operationEnvelope, expectedRevision: syncCursorSchema };
export const outboxOperationSchema = z.discriminatedUnion('kind', [
  z.object({
    ...operationEnvelope,
    kind: z.literal('daily-note'),
    expectedRevision: z.null(),
    payload: z.object({ date: z.iso.date() }),
  }),
  z.object({
    ...operationEnvelope,
    kind: z.literal('create'),
    payload: z.object({
      type: z.string().min(1),
      title: z.string(),
      parentId: z.uuid().nullable(),
      properties: properties.optional(),
    }),
  }),
  z.object({
    ...writeEnvelope,
    kind: z.literal('rename'),
    payload: z.object({ title: z.string() }),
  }),
  z.object({
    ...writeEnvelope,
    kind: z.literal('move'),
    payload: z.object({ parentId: z.uuid().nullable(), afterId: z.uuid().nullable().optional() }),
  }),
  z.object({ ...writeEnvelope, kind: z.literal('archive'), payload: z.strictObject({}) }),
  z.object({
    ...writeEnvelope,
    kind: z.literal('properties'),
    payload: z.object({ changes: properties }),
  }),
]);
export type OutboxOperation = z.infer<typeof outboxOperationSchema>;

export const nativeReplayResultSchema = z.object({
  operationId: z.uuid(),
  status: z.enum(['applied', 'conflict', 'refused']),
  itemId: z.uuid(),
  revision: syncCursorSchema.nullable(),
  item: nativeItemSnapshotSchema.nullable(),
  code: z.string().nullable(),
});
export type NativeReplayResult = z.infer<typeof nativeReplayResultSchema>;

export const BODY_SYNC_LIMITS = {
  documents: 20,
  updatesPerDocument: 64,
  updateBytes: 1024 * 1024,
  stateVectorBytes: 64 * 1024,
  responseUpdateBytes: 16 * 1024 * 1024,
  requestBytes: 8 * 1024 * 1024,
  responseBytes: 32 * 1024 * 1024,
};

function encodedBytes(maxBytes: number): z.ZodString {
  return z
    .string()
    .min(4)
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((value) => value.length % 4 === 0 && byteLength(value) <= maxBytes);
}

export const bodySyncRequestSchema = z.object({
  documents: z
    .array(
      z
        .object({
          itemId: z.uuid(),
          expectedDocId: z.uuid().optional(),
          stateVector: encodedBytes(BODY_SYNC_LIMITS.stateVectorBytes),
          updates: z
            .array(
              z.object({
                clientId: z.string().min(1).max(200),
                update: encodedBytes(BODY_SYNC_LIMITS.updateBytes),
              }),
            )
            .max(BODY_SYNC_LIMITS.updatesPerDocument)
            .optional(),
        })
        .refine(
          (value) => (value.updates?.length ?? 0) === 0 || value.expectedDocId !== undefined,
          'An upload requires the confirmed document identity',
        ),
    )
    .max(BODY_SYNC_LIMITS.documents),
});
export type BodySyncRequest = z.infer<typeof bodySyncRequestSchema>;

export const bodySyncSuccessSchema = z.object({
  itemId: z.uuid(),
  status: z.literal('ok'),
  docId: z.uuid(),
  headSeq: syncCursorSchema,
  schemaVersion: z.number().int().positive(),
  canWrite: z.boolean(),
  update: encodedBytes(BODY_SYNC_LIMITS.responseUpdateBytes),
  stateVector: encodedBytes(BODY_SYNC_LIMITS.stateVectorBytes),
  acknowledgedClientIds: z
    .array(z.string().min(1).max(200))
    .max(BODY_SYNC_LIMITS.updatesPerDocument),
});
export type BodySyncSuccess = z.infer<typeof bodySyncSuccessSchema>;
export type LiveBodySyncSuccess = Omit<BodySyncSuccess, 'headSeq'>;

export const bodySyncFailureSchema = z.discriminatedUnion('status', [
  z.object({ itemId: z.uuid(), status: z.literal('forbidden') }),
  z.object({
    itemId: z.uuid(),
    status: z.enum(['unavailable', 'rejected']),
    code: z.string(),
  }),
]);
export type BodySyncFailure = z.infer<typeof bodySyncFailureSchema>;
export const bodySyncResponseSchema = z.object({
  documents: z
    .array(z.union([bodySyncSuccessSchema, bodySyncFailureSchema]))
    .max(BODY_SYNC_LIMITS.documents),
});
export type BodySyncResponse = z.infer<typeof bodySyncResponseSchema>;

export interface PendingBodyUpdate {
  clientId: string;
  update: Uint8Array;
}

export interface MirrorBody {
  item: MirrorItem;
  docId: string | null;
  schemaVersion: number | null;
  headSeq: string | null;
  confirmedUpdate: Uint8Array | null;
  pending: PendingBodyUpdate[];
}

export interface MirrorCheckpoint {
  cursor: string | null;
  snapshot: { boundary: string; nextCursor: string } | null;
  sealed: boolean;
}

export interface MirrorConflict {
  id: string;
  workspaceId: string;
  itemId: string;
  kind: 'metadata' | 'body';
  code: string;
  operation: OutboxOperation | null;
  createdAt: string;
}

export interface WorkspaceLease {
  workspaceId: string;
  ownerId: string;
  nowMs: number;
  expiresAtMs: number;
}

export interface MirrorStore {
  readonly scope: MirrorScope;
  acquireLease(lease: WorkspaceLease): Promise<boolean>;
  renewLease(lease: WorkspaceLease): Promise<boolean>;
  releaseLease(workspaceId: string, ownerId: string): Promise<void>;
  getCheckpoint(workspaceId: string): Promise<MirrorCheckpoint>;
  sealWorkspace(workspaceId: string): Promise<void>;
  unsealWorkspace(workspaceId: string): Promise<void>;
  applySnapshotPage(workspaceId: string, page: NativeSnapshotPage, reset: boolean): Promise<void>;
  applyChangesPage(workspaceId: string, page: NativeChangesPage): Promise<void>;
  applyReconcilePage(workspaceId: string, page: NativeReconcilePage): Promise<void>;
  knownItemIds(workspaceId: string): Promise<string[]>;
  purgeExpired(workspaceId: string, nowMs: number): Promise<void>;
  listBodyCandidates(
    workspaceId: string,
    afterItemId: string | null,
    limit: number,
  ): Promise<MirrorBody[]>;
  commitBodySync(workspaceId: string, response: BodySyncSuccess): Promise<void>;
  commitLiveBodySync(workspaceId: string, response: LiveBodySyncSuccess): Promise<void>;
  recordBodyFailure(workspaceId: string, failure: BodySyncFailure): Promise<void>;
  listOutbox(workspaceId: string): Promise<OutboxOperation[]>;
  peekOutbox(workspaceId: string): Promise<OutboxOperation | null>;
  recordReplayResult(workspaceId: string, response: NativeReplayResult): Promise<void>;
  wipeWorkspace(workspaceId: string): Promise<void>;
  wipe(): Promise<void>;

  listItems(workspaceId: string): Promise<MirrorItem[]>;
  searchItems(workspaceId: string, query: string): Promise<MirrorItem[]>;
  resolveItemId(workspaceId: string, itemId: string): Promise<string>;
  requestBody(workspaceId: string, itemId: string): Promise<void>;
  readBody(workspaceId: string, itemId: string): Promise<MirrorBody | null>;
  enqueue(workspaceId: string, operation: OutboxOperation): Promise<void>;
  enqueueBodyUpdate(workspaceId: string, itemId: string, update: PendingBodyUpdate): Promise<void>;
  listConflicts(workspaceId: string): Promise<MirrorConflict[]>;
  subscribe(listener: () => void): () => void;
}

export interface MirrorApi {
  snapshot(input: {
    workspaceId: string;
    boundary?: string;
    cursor?: string;
    limit: number;
  }): Promise<unknown>;
  changes(input: { workspaceId: string; after: string; limit: number }): Promise<unknown>;
  reconcile(input: { workspaceId: string; itemIds: string[] }): Promise<unknown>;
  replay(input: { workspaceId: string; operation: OutboxOperation }): Promise<unknown>;
  syncBodies(input: BodySyncRequest): Promise<unknown>;
}

export class MirrorAccessRevokedError extends Error {
  readonly scope: 'account' | 'workspace';

  constructor(scope: 'account' | 'workspace' = 'account') {
    super('The mirror account is no longer authorized');
    this.name = 'MirrorAccessRevokedError';
    this.scope = scope;
  }
}

export { runSyncPass } from './engine.js';
export type { SyncPassInput, SyncPassResult } from './engine.js';
