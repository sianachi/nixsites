import type { NixClient } from '../client.js';
import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { noContentSchema } from '../schemas/index.js';
import { operationSchema, type Operation } from '../schemas/operations.js';
import {
  templateImportDigestSchema,
  templateImportSchema,
  templateImportUploadSchema,
  type TemplateImport,
  type TemplateImportPreview,
  type TemplateImportResult,
  type TemplateImportUpload,
} from '../schemas/template-imports.js';
import { waitForOperation } from './operations.js';

export interface BeginTemplateImportInput {
  readonly workspaceId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly idempotencyKey: string;
}

type PreviewedTemplateImport = TemplateImport & { readonly preview: TemplateImportPreview };
type CompletedTemplateImport = TemplateImport & {
  readonly status: 'completed';
  readonly result: TemplateImportResult;
};

export const templateImportKey = (importId: string): readonly string[] => [
  'template-imports',
  importId,
];

export const begin = (input: BeginTemplateImportInput): CommandEndpoint<TemplateImportUpload> =>
  defineCommand({
    operation: 'template-imports.begin',
    method: 'POST',
    path: '/api/v1/template-imports',
    body: input,
    schema: templateImportUploadSchema,
  });

export const byId = (importId: string): QueryEndpoint<TemplateImport> =>
  defineQuery({
    operation: 'template-imports.get',
    path: `/api/v1/template-imports/${importId}`,
    schema: templateImportSchema,
    cacheKey: templateImportKey(importId),
    staleAfterMs: 0,
  });

export const preview = (importId: string): CommandEndpoint<Operation> =>
  defineCommand({
    operation: 'template-imports.preview',
    method: 'POST',
    path: `/api/v1/template-imports/${importId}/preview`,
    schema: operationSchema,
    invalidates: [templateImportKey(importId)],
  });

export const commit = (importId: string, expectedDigest: string): CommandEndpoint<Operation> =>
  defineCommand({
    operation: 'template-imports.commit',
    method: 'POST',
    path: `/api/v1/template-imports/${importId}/commit`,
    body: { expectedDigest: templateImportDigestSchema.parse(expectedDigest) },
    schema: operationSchema,
    invalidates: [templateImportKey(importId)],
  });

export const cancel = (importId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'template-imports.cancel',
    method: 'DELETE',
    path: `/api/v1/template-imports/${importId}`,
    schema: noContentSchema,
    invalidates: [templateImportKey(importId)],
  });

export async function beginAndPreviewTemplate(
  client: NixClient,
  input: BeginTemplateImportInput,
  source: Blob,
  signal?: AbortSignal,
  onStarted?: (importId: string) => void,
): Promise<TemplateImport> {
  if (source.size !== input.byteLength) {
    throw new RangeError('The template upload size does not match its declared byte length.');
  }

  const upload = await client.execute(begin(input), { signal });
  onStarted?.(upload.id);
  let operation: TemplateImport | null = null;
  try {
    if (upload.uploadUrl !== null) {
      await putCapability(upload.uploadUrl, source, signal);
      const queued = await client.execute(preview(upload.id), { signal });
      await waitForOperation(client, queued.id, signal === undefined ? {} : { signal });
    } else {
      operation = await client.query(byId(upload.id), { signal, forceRefresh: true });
      if (operation.status === 'preview_queued' && operation.previewOperationId !== null) {
        await waitForOperation(
          client,
          operation.previewOperationId,
          signal === undefined ? {} : { signal },
        );
        operation = null;
      }
    }

    operation ??= await client.query(byId(upload.id), { signal, forceRefresh: true });
    if (
      !['preview_ready', 'commit_queued', 'staging', 'staged', 'completed'].includes(
        operation.status,
      ) ||
      operation.preview === null
    ) {
      throw new Error(
        operation.failureCode ??
          (upload.uploadUrl === null
            ? 'The template upload capability is no longer available. Start a new import.'
            : 'The template preview did not become ready.'),
      );
    }
    return operation;
  } catch (error) {
    // Leaving the page only stops this caller's wait. The durable import remains resumable
    // through its idempotency key and must not be mistaken for an explicit user cancellation.
    if (signal?.aborted === true) throw error;
    const recovered = await readTemplateImport(client, upload.id, signal);
    const resumed = await resumePreview(client, recovered, signal).catch(
      (recoveryError: unknown) => {
        if (signal?.aborted === true) throw recoveryError;
        return null;
      },
    );
    if (hasPreview(resumed)) return resumed;
    throw error;
  }
}

export async function commitAndWaitTemplate(
  client: NixClient,
  importId: string,
  expectedDigest: string,
  signal?: AbortSignal,
): Promise<TemplateImport> {
  let operation: TemplateImport | null = null;
  try {
    const queued = await client.execute(commit(importId, expectedDigest), { signal });
    await waitForOperation(client, queued.id, signal === undefined ? {} : { signal });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    operation = await readTemplateImport(client, importId, signal);
    operation = await resumeCommit(client, operation, signal).catch((recoveryError: unknown) => {
      if (signal?.aborted === true) throw recoveryError;
      return operation;
    });
    if (!isCompleted(operation)) throw error;
  }
  operation ??= await client.query(byId(importId), { signal, forceRefresh: true });
  if (operation.status !== 'completed' || operation.result === null) {
    throw new Error(operation.failureCode ?? 'The template import did not publish.');
  }
  client.invalidate(['workspaces', operation.workspaceId, 'templates']);
  return operation;
}

export async function cancelTemplateImport(
  client: NixClient,
  importId: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.execute(cancel(importId), signal === undefined ? {} : { signal });
}

async function readTemplateImport(
  client: NixClient,
  importId: string,
  signal?: AbortSignal,
): Promise<TemplateImport | null> {
  try {
    return await client.query(byId(importId), { signal, forceRefresh: true });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return null;
  }
}

async function resumePreview(
  client: NixClient,
  operation: TemplateImport | null,
  signal?: AbortSignal,
): Promise<TemplateImport | null> {
  if (hasPreview(operation)) return operation;
  if (operation?.status !== 'preview_queued' || operation.previewOperationId === null) {
    return operation;
  }
  await waitForOperation(
    client,
    operation.previewOperationId,
    signal === undefined ? {} : { signal },
  );
  return await client.query(byId(operation.id), { signal, forceRefresh: true });
}

async function resumeCommit(
  client: NixClient,
  operation: TemplateImport | null,
  signal?: AbortSignal,
): Promise<TemplateImport | null> {
  if (isCompleted(operation)) return operation;
  if (
    operation === null ||
    !['commit_queued', 'staging', 'staged'].includes(operation.status) ||
    operation.commitOperationId === null
  ) {
    return operation;
  }
  await waitForOperation(
    client,
    operation.commitOperationId,
    signal === undefined ? {} : { signal },
  );
  return await client.query(byId(operation.id), { signal, forceRefresh: true });
}

function hasPreview(operation: TemplateImport | null): operation is PreviewedTemplateImport {
  return (
    operation !== null &&
    ['preview_ready', 'commit_queued', 'staging', 'staged', 'completed'].includes(
      operation.status,
    ) &&
    operation.preview !== null
  );
}

function isCompleted(operation: TemplateImport | null): operation is CompletedTemplateImport {
  return operation?.status === 'completed' && operation.result !== null;
}

async function putCapability(url: string, source: Blob, signal?: AbortSignal): Promise<void> {
  const response = await capabilityFetch(url, {
    method: 'PUT',
    body: source,
    ...(signal === undefined ? {} : { signal }),
    headers: { 'content-type': 'application/octet-stream' },
  });
  if (!response.ok) throw new Error(`The template upload failed (${String(response.status)}).`);
}

async function capabilityFetch(url: string, init: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    throw new TypeError('Object capabilities must use HTTPS outside local development.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('Object capabilities cannot contain URL credentials.');
  }
  const response = await fetch(parsed, { ...init, credentials: 'omit', redirect: 'error' });
  if (!response.ok)
    throw new Error(`The object capability was refused (${String(response.status)}).`);
  return response;
}
