import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  fileDownloadCapabilitySchema,
  fileRecordSchema,
  fileThumbnailCapabilitySchema,
  fileUploadSchema,
  fileUploadStatusSchema,
  type FileDownloadCapability,
  type FileRecord,
  type FileThumbnailCapability,
  type FileUpload,
  type FileUploadStatus,
} from '../schemas/files.js';
import { operationSchema, type Operation } from '../schemas/operations.js';
import { noContentSchema } from '../schemas/index.js';
import type { NixClient } from '../client.js';
import { waitForOperation } from './operations.js';

export interface BeginFileUploadInput {
  readonly workspaceId: string;
  readonly parentId: string | null;
  readonly targetItemId?: string | null;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly idempotencyKey: string;
}

export const beginUpload = (input: BeginFileUploadInput): CommandEndpoint<FileUpload> =>
  defineCommand({
    operation: 'files.upload.begin',
    method: 'POST',
    path: '/api/v1/files/uploads',
    body: input,
    schema: fileUploadSchema,
  });
export const completeUpload = (upload: FileUpload): CommandEndpoint<Operation> =>
  defineCommand({
    operation: 'files.upload.complete',
    method: 'POST',
    path: `/api/v1/files/uploads/${upload.id}/complete`,
    schema: operationSchema,
  });
export const cancelUpload = (uploadId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'files.upload.cancel',
    method: 'DELETE',
    path: `/api/v1/files/uploads/${uploadId}`,
    schema: noContentSchema,
    invalidates: [['file-uploads', uploadId]],
  });
export const uploadById = (uploadId: string): QueryEndpoint<FileUploadStatus> =>
  defineQuery({
    operation: 'files.upload.get',
    path: `/api/v1/files/uploads/${uploadId}`,
    schema: fileUploadStatusSchema,
    cacheKey: ['file-uploads', uploadId],
    staleAfterMs: 0,
  });
export const fileByItem = (itemId: string): QueryEndpoint<FileRecord> =>
  defineQuery({
    operation: 'files.get',
    path: `/api/v1/items/${itemId}/file`,
    schema: fileRecordSchema,
    cacheKey: ['files', itemId],
  });
export const downloadFile = (
  itemId: string,
  versionId?: string,
  preview = false,
): QueryEndpoint<FileDownloadCapability> =>
  defineQuery({
    operation: 'files.download',
    path: `/api/v1/items/${itemId}/file/download`,
    query: { versionId, preview },
    schema: fileDownloadCapabilitySchema,
    staleAfterMs: 0,
  });

/**
 * A short-lived URL for a file version's JPEG thumbnail. Core answers 404 for a file the caller
 * cannot read, a file under a closed lock, and a version with no thumbnail alike.
 */
export const thumbnailFile = (
  itemId: string,
  versionId?: string,
): QueryEndpoint<FileThumbnailCapability> =>
  defineQuery({
    operation: 'files.thumbnail',
    path: `/api/v1/items/${itemId}/file/thumbnail`,
    query: { versionId },
    schema: fileThumbnailCapabilitySchema,
    staleAfterMs: 0,
  });

export async function putUploadCapability(
  uploadUrl: string | null,
  file: Blob,
  signal?: AbortSignal,
): Promise<void> {
  if (uploadUrl === null) throw new Error('The upload capability is no longer available.');
  const url = new URL(uploadUrl);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new TypeError('Upload capabilities must use HTTPS outside local development.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Upload capabilities cannot contain URL credentials.');
  }
  const response = await fetch(url, {
    method: 'PUT',
    body: file,
    ...(signal === undefined ? {} : { signal }),
    credentials: 'omit',
    redirect: 'error',
    headers: { 'content-type': 'application/octet-stream' },
  });
  if (!response.ok) throw new Error(`The file upload failed (${String(response.status)}).`);
}

export async function completeUploadAndWait(
  client: NixClient,
  upload: FileUpload,
  signal?: AbortSignal,
): Promise<FileRecord> {
  const operation = await client.execute(completeUpload(upload), { signal });
  await waitForOperation(client, operation.id, signal === undefined ? {} : { signal });
  client.invalidate(['file-uploads', upload.id]);
  const status = await client.query(uploadById(upload.id), { signal, forceRefresh: true });
  if (status.status !== 'completed' || status.itemId === null) {
    throw new Error(status.failureCode ?? 'The file did not publish.');
  }
  client.invalidate(['items', status.itemId]);
  client.invalidate(['files', status.itemId]);
  const published = await client.query(fileByItem(status.itemId), { signal, forceRefresh: true });
  client.invalidate(['workspaces', published.workspaceId, 'items']);
  return published;
}

export async function uploadAndCompleteFile(
  client: NixClient,
  upload: FileUpload,
  file: Blob,
  signal?: AbortSignal,
): Promise<FileRecord> {
  try {
    await putUploadCapability(upload.uploadUrl, file, signal);
    return await completeUploadAndWait(client, upload, signal);
  } catch (error) {
    try {
      await client.execute(cancelUpload(upload.id));
    } catch {
      // The terminal worker path or expiry reaper may already own cleanup.
    }
    throw error;
  }
}

export async function fetchFileContent(
  client: NixClient,
  itemId: string,
  versionId?: string,
  preview = false,
  signal?: AbortSignal,
): Promise<{ readonly blob: Blob; readonly capability: FileDownloadCapability }> {
  const capability = await client.query(downloadFile(itemId, versionId, preview), {
    signal,
    forceRefresh: true,
  });
  const url = new URL(capability.url);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new TypeError('Download capabilities must use HTTPS outside local development.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Download capabilities cannot contain URL credentials.');
  }
  const response = await fetch(url, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`The file download failed (${String(response.status)}).`);
  const blob = await response.blob();
  if (blob.size !== capability.byteLength) {
    throw new Error('The downloaded file size did not match its capability.');
  }
  return { blob, capability };
}
