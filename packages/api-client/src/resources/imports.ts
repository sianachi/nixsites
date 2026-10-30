import type { z } from 'zod';

import type { NixClient } from '../client.js';
import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  documentImportPlanSchema,
  documentImportPreviewCapabilitySchema,
  documentImportSchema,
  documentImportUploadSchema,
  type DocumentImport,
  type DocumentImportPlan,
  type DocumentImportUpload,
} from '../schemas/imports.js';
import { noContentSchema } from '../schemas/index.js';
import { operationSchema, type Operation } from '../schemas/operations.js';
import { waitForOperation } from './operations.js';

export interface BeginDocumentImportInput {
  readonly workspaceId: string;
  readonly parentId: string | null;
  readonly format: 'nix' | 'markdown' | 'txt' | 'docx' | 'pdf';
  readonly title: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly idempotencyKey: string;
}

export const beginDocumentImport = (
  input: BeginDocumentImportInput,
): CommandEndpoint<DocumentImportUpload> =>
  defineCommand({
    operation: 'imports.begin',
    method: 'POST',
    path: '/api/v1/imports',
    body: input,
    schema: documentImportUploadSchema,
  });

export const documentImportById = (importId: string): QueryEndpoint<DocumentImport> =>
  defineQuery({
    operation: 'imports.get',
    path: `/api/v1/imports/${importId}`,
    schema: documentImportSchema,
    cacheKey: ['imports', importId],
    staleAfterMs: 0,
  });

export const previewDocumentImport = (importId: string): CommandEndpoint<Operation> =>
  defineCommand({
    operation: 'imports.preview',
    method: 'POST',
    path: `/api/v1/imports/${importId}/preview`,
    schema: operationSchema,
    invalidates: [['imports', importId]],
  });

export const documentImportPreview = (
  importId: string,
): QueryEndpoint<z.infer<typeof documentImportPreviewCapabilitySchema>> =>
  defineQuery({
    operation: 'imports.preview.get',
    path: `/api/v1/imports/${importId}/preview`,
    schema: documentImportPreviewCapabilitySchema,
    cacheKey: ['imports', importId, 'preview'],
    staleAfterMs: 0,
  });

export const commitDocumentImport = (importId: string): CommandEndpoint<Operation> =>
  defineCommand({
    operation: 'imports.commit',
    method: 'POST',
    path: `/api/v1/imports/${importId}/commit`,
    schema: operationSchema,
    invalidates: [['imports', importId]],
  });

export const cancelDocumentImport = (importId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'imports.cancel',
    method: 'DELETE',
    path: `/api/v1/imports/${importId}`,
    schema: noContentSchema,
    invalidates: [['imports', importId]],
  });

export async function beginAndPreviewDocument(
  client: NixClient,
  input: BeginDocumentImportInput,
  source: Blob,
  signal?: AbortSignal,
  onStarted?: (importId: string) => void,
): Promise<{ readonly operation: DocumentImport; readonly plan: DocumentImportPlan }> {
  const upload = await client.execute(beginDocumentImport(input), { signal });
  onStarted?.(upload.id);
  try {
    if (upload.uploadUrl === null) {
      throw new Error('The import upload capability is no longer available. Start a new import.');
    }
    await putCapability(upload.uploadUrl, source, signal);
    const preview = await client.execute(previewDocumentImport(upload.id), { signal });
    await waitForOperation(client, preview.id, signal === undefined ? {} : { signal });
    const operation = await client.query(documentImportById(upload.id), {
      signal,
      forceRefresh: true,
    });
    if (operation.status !== 'preview_ready') {
      throw new Error(operation.failureCode ?? 'The document preview did not become ready.');
    }
    const plan = await fetchDocumentImportPlan(client, upload.id, signal);
    return { operation, plan };
  } catch (error) {
    // The durable expiry reaper is the backstop. This best-effort cancellation releases staged
    // objects promptly when upload, preview, parsing, or caller cancellation fails mid-flight.
    await client.execute(cancelDocumentImport(upload.id)).catch(() => undefined);
    throw error;
  }
}

export async function commitAndWaitDocumentImport(
  client: NixClient,
  importId: string,
  signal?: AbortSignal,
): Promise<DocumentImport> {
  const commit = await client.execute(commitDocumentImport(importId), { signal });
  await waitForOperation(client, commit.id, signal === undefined ? {} : { signal });
  client.invalidate(['imports', importId]);
  const operation = await client.query(documentImportById(importId), {
    signal,
    forceRefresh: true,
  });
  if (operation.status !== 'completed' || operation.rootItemId === null) {
    throw new Error(operation.failureCode ?? 'The document import did not publish.');
  }
  client.invalidate(['items']);
  client.invalidate(['workspaces', operation.workspaceId, 'items']);
  return operation;
}

export async function fetchDocumentImportPlan(
  client: NixClient,
  importId: string,
  signal?: AbortSignal,
): Promise<DocumentImportPlan> {
  const capability = await client.query(documentImportPreview(importId), {
    signal,
    forceRefresh: true,
  });
  if (capability.byteLength > 16 * 1024 * 1024) {
    throw new Error('The document preview exceeds the supported size.');
  }
  const response = await capabilityFetch(capability.url, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== capability.byteLength) {
    throw new Error('The document preview size did not match its capability.');
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const actualSha256 = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (actualSha256 !== capability.sha256) {
    throw new Error('The document preview checksum did not match its capability.');
  }
  return documentImportPlanSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

async function putCapability(url: string, source: Blob, signal?: AbortSignal): Promise<void> {
  const response = await capabilityFetch(url, {
    method: 'PUT',
    body: source,
    ...(signal === undefined ? {} : { signal }),
    headers: { 'content-type': 'application/octet-stream' },
  });
  if (!response.ok) throw new Error(`The document upload failed (${String(response.status)}).`);
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
