/**
 * The value functions behind the record, reference, version-state, link and upload tools. Each takes
 * an open session and returns plain data, so the CLI commands and the MCP tools (stdio and HTTP)
 * share one implementation and one request shape.
 */

import {
  agentRecords,
  exports as exportResource,
  files,
  operations,
  workspaceQuery,
} from '@nix/api-client';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Session } from '../session.ts';

/**
 * A guard against mistakes, not a security boundary: Core treats a `nixctl auth login` session as a
 * person, so an agent running on one would pass as you. Approving or revoking a file version and
 * creating a public link are refused here unless the profile is an access token, which is the only
 * credential Core can tell apart. `nixctl api` and raw REST are not covered; Core enforces the
 * workspace switches for tokens either way.
 */
export function assertTokenSession(session: Session, what: string): void {
  if (session.authKind !== 'token')
    throw new Error(
      `${what} needs an access token, but this profile is a browser-approved login, which Core treats as a person. ` +
        'Run unattended agents on an access token (create one in Settings and use it with `nixctl auth login --token`). ' +
        'This check only guards against mistakes; it is not a security boundary, and Core still applies the workspace settings.',
    );
}

/** Applies {@link assertTokenSession} to a generic operation, so run_nix_action cannot sidestep it. */
export function assertGenericGate(session: Session, operationId: string, body: unknown): void {
  const gate = agentRecords.agentGate(operationId, body);
  if (gate !== undefined)
    assertTokenSession(
      session,
      gate === 'approve' ? 'Approving or revoking a file version' : 'Creating a public link',
    );
}

export async function lookupByProperty(
  session: Session,
  input: { workspaceId: string; key: string; value: string; parentId?: string | undefined },
): Promise<unknown> {
  const { workspaceId, ...rest } = input;
  return session.client.execute(agentRecords.lookupItems(workspaceId, rest));
}

export interface WorkspaceQueryInput {
  readonly workspaceId: string;
  readonly parentId?: string | undefined;
  readonly filters?:
    readonly { property: string; operator: string; value?: string | undefined }[] | undefined;
  readonly sort?: { property: string; descending?: boolean | undefined } | undefined;
  readonly limit?: number | undefined;
  readonly today?: string | undefined;
}

export async function queryWorkspace(
  session: Session,
  input: WorkspaceQueryInput,
): Promise<unknown> {
  return session.client.execute(
    workspaceQuery.runWorkspaceQuery(input.workspaceId, {
      ...(input.parentId === undefined ? {} : { scope: { parentId: input.parentId } }),
      ...(input.filters === undefined
        ? {}
        : {
            filters: input.filters.map((rule) => ({
              property: rule.property,
              operator: rule.operator,
              value: rule.value ?? null,
            })),
          }),
      ...(input.sort === undefined
        ? {}
        : {
            sort: {
              property: input.sort.property,
              ...(input.sort.descending === undefined ? {} : { descending: input.sort.descending }),
            },
          }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.today === undefined ? {} : { today: input.today }),
    }),
  );
}

/** Reads a batch file: either `{ rows, strict? }` or a bare array of rows. */
export async function readBatchFile(
  path: string,
): Promise<{ rows: agentRecords.BatchRow[]; strict: boolean | undefined }> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const body = Array.isArray(parsed)
    ? { rows: parsed }
    : (parsed as { rows?: unknown; strict?: unknown });
  if (!Array.isArray(body.rows))
    throw new Error('The batch file must be a JSON array of rows or { "rows": [...] }.');
  return {
    rows: body.rows as agentRecords.BatchRow[],
    strict: typeof body.strict === 'boolean' ? body.strict : undefined,
  };
}

/** A create row (no key, no itemId) without an idempotencyKey would duplicate on retry: refuse it before sending. */
export function assertRowsRetrySafe(rows: readonly agentRecords.BatchRow[]): void {
  const unsafe = rows.flatMap((row, index) =>
    row.itemId === undefined && row.keyValue === undefined && row.idempotencyKey === undefined
      ? [index]
      : [],
  );
  if (unsafe.length > 0)
    throw new Error(
      `Row ${unsafe.join(', ')} creates a record without an idempotencyKey, so a retry could duplicate it. ` +
        'Give each create row an idempotencyKey, or key it with keyField and keyValue. Nothing was sent.',
    );
}

/** One sentence naming each failed row, for a non-zero exit and for agents reading the result. */
export function describeBatchFailures(result: agentRecords.BatchResult): string | undefined {
  if (result.failed === 0) return undefined;
  const failed = result.rows
    .filter((row) => row.status === 'error')
    .map(
      (row) =>
        `row ${String(row.index)} (${row.error?.code ?? 'error'}: ${row.error?.message ?? 'failed'})`,
    );
  return `${String(result.failed)} of ${String(result.rows.length)} rows failed: ${failed.join('; ')}. The other rows were written; retry the same request to fix only the failed ones.`;
}

export const newKey = (prefix: string): string => `${prefix}:${randomUUID()}`;

/** Begins an upload and returns the presigned PUT the caller uses itself; no bytes pass through here. */
export async function beginUploadValue(
  session: Session,
  input: {
    workspaceId: string;
    parentId?: string | undefined;
    targetItemId?: string | undefined;
    fileName: string;
    mediaType?: string | undefined;
    byteLength: number;
    idempotencyKey?: string | undefined;
  },
): Promise<unknown> {
  const upload = await session.client.execute(
    files.beginUpload({
      workspaceId: input.workspaceId,
      parentId: input.parentId ?? null,
      targetItemId: input.targetItemId ?? null,
      fileName: input.fileName,
      mediaType: input.mediaType ?? 'application/octet-stream',
      byteLength: input.byteLength,
      idempotencyKey: input.idempotencyKey ?? newKey('agent-file'),
    }),
  );
  if (upload.uploadUrl === null) throw new Error('The upload capability is no longer available.');
  return {
    uploadId: upload.id,
    method: 'PUT',
    uploadUrl: upload.uploadUrl,
    // The object store signs these; send the body unchanged with exactly this content type.
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(input.byteLength),
    },
    capabilityExpiresAt: upload.capabilityExpiresAt,
    expiresAt: upload.expiresAt,
    next: 'PUT the file bytes to uploadUrl, then call complete_file_upload with uploadId.',
  };
}

/** Finishes an upload and waits for the publish job; returns the item and the version it made. */
export async function completeUploadValue(session: Session, uploadId: string): Promise<unknown> {
  const operation = await session.client.execute(agentRecords.completeUploadById(uploadId));
  await operations.waitForOperation(session.client, operation.id);
  session.client.invalidate(['file-uploads', uploadId]);
  const status = await session.client.query(files.uploadById(uploadId), { forceRefresh: true });
  if (status.status !== 'completed' || status.itemId === null)
    throw new Error(status.failureCode ?? 'The file did not publish.');
  session.client.invalidate(['items', status.itemId]);
  session.client.invalidate(['files', status.itemId]);
  return {
    itemId: status.itemId,
    publishedVersionId: status.publishedVersionId ?? null,
    status: status.status,
  };
}

/** Exports a note to a file item and waits for the new version to publish. */
export async function exportToFileValue(
  session: Session,
  input: { itemId: string; format: string; targetItemId?: string | undefined },
): Promise<unknown> {
  const finished = await exportResource.beginAndWait(session.client, {
    itemId: input.itemId,
    format: input.format,
    scope: 'item',
    idempotencyKey: newKey('agent-export'),
    toFile: true,
    ...(input.targetItemId === undefined ? {} : { targetItemId: input.targetItemId }),
  });
  if (finished.status !== 'completed')
    throw new Error(
      finished.failureDetail ?? finished.failureCode ?? `The export ${finished.status}.`,
    );
  if (!finished.uploadId) return { export: finished };
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await session.client.query(files.uploadById(finished.uploadId), {
      forceRefresh: true,
    });
    if (status.status === 'completed' && status.itemId !== null)
      return {
        itemId: status.itemId,
        publishedVersionId: status.publishedVersionId ?? null,
        exportId: finished.id,
      };
    if (status.status === 'failed' || status.status === 'cancelled' || Date.now() > deadline)
      throw new Error(status.failureCode ?? 'The exported file did not publish.');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The key the expiry property is stored under; Core moves the item to trash at that moment. */
export const EXPIRY_KEY = 'expiry';
