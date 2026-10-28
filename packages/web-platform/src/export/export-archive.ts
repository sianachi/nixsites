import {
  exports as exportResources,
  isCanceledError,
  isNixApiError,
  type Export,
  type ExportDownloadCapability,
  type NixClient,
} from '@nix/api-client';

import type { ExportFormat } from './export-formats';

export type ArchiveScope = 'item' | 'subtree';

export interface ArchiveResult {
  readonly exportId: string;
  readonly fileName: string;
  readonly downloadUrl: string;
  readonly capabilityExpiresAt: string;
  readonly mediaType: string;
  readonly byteLength: number | string;
  readonly sha256: string;
  readonly itemCount: number;
  readonly omittedCount: number;
  readonly loss: readonly string[];
  readonly omissions: readonly string[];
}

export type ArchiveOutcome =
  | { readonly ok: true; readonly value: ArchiveResult }
  | { readonly ok: false; readonly error: string; readonly cancelled: boolean };

export interface ArchiveRequest {
  readonly client: NixClient;
  readonly itemId: string;
  readonly scope: ArchiveScope;
  readonly format: ExportFormat;
  readonly signal?: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly onStarted?: (state: Export) => void;
  readonly onProgress?: (state: Export) => void;
}

export async function requestArchive(request: ArchiveRequest): Promise<ArchiveOutcome> {
  try {
    const state = await exportResources.beginAndWait(
      request.client,
      {
        itemId: request.itemId,
        scope: request.scope,
        format: request.format,
        idempotencyKey: `web-export:${globalThis.crypto.randomUUID()}`,
      },
      {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.pollIntervalMs === undefined ? {} : { pollIntervalMs: request.pollIntervalMs }),
        ...(request.onStarted === undefined ? {} : { onStarted: request.onStarted }),
        ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
      },
    );

    if (state.status === 'cancelled') {
      return { ok: false, error: 'The export was cancelled.', cancelled: true };
    }
    if (state.status === 'failed') {
      return {
        ok: false,
        error: state.failureDetail ?? state.failureCode ?? 'The export worker could not finish.',
        cancelled: false,
      };
    }
    if (!state.downloadReady) {
      return {
        ok: false,
        error: 'The export finished, but its download is not available.',
        cancelled: false,
      };
    }

    const capability = await exportResources.downloadForCompletedExport(
      request.client,
      state,
      request.signal,
    );
    return {
      ok: true,
      value: resultFrom(state, capability),
    };
  } catch (reason) {
    const cancelled =
      request.signal?.aborted === true || isCanceledError(reason) || isAbort(reason);
    return {
      ok: false,
      cancelled,
      error: cancelled ? 'The export was cancelled.' : exportFailure(reason),
    };
  }
}

export async function cancelArchive(client: NixClient, exportId: string): Promise<void> {
  await client.execute(exportResources.cancel(exportId));
}

function resultFrom(state: Export, capability: ExportDownloadCapability): ArchiveResult {
  return {
    exportId: state.id,
    fileName: capability.fileName,
    downloadUrl: capability.url,
    capabilityExpiresAt: capability.expiresAt,
    mediaType: capability.mediaType,
    byteLength: capability.byteLength,
    sha256: capability.sha256,
    itemCount: safeCount(state.itemCount, 'item count'),
    omittedCount: safeCount(state.omittedCount, 'omitted count'),
    loss: state.loss,
    omissions: state.omissions,
  };
}

function safeCount(value: number | string | null, field: string): number {
  if (value === null) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`The export ${field} was outside the supported range.`);
  }
  return parsed;
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError';
}

function exportFailure(reason: unknown): string {
  if (isNixApiError(reason)) {
    return reason.detail ?? 'The export service refused the request.';
  }
  return reason instanceof Error ? reason.message : 'The export could not be prepared.';
}

/**
 * The file name from a legacy authenticated binary response.
 *
 * Template archives still use the direct binary boundary. Durable item exports get their name
 * from Core's capability response and do not need to parse a header in the browser.
 */
export function fileNameFrom(header: string | null, extension = 'nix'): string {
  const match = header === null ? null : /filename="([^"]+)"/.exec(header);
  const name = match?.[1];

  return name === undefined || name.length === 0 ? `export.${extension}` : name;
}

interface BlobDownload {
  readonly fileName: string;
  readonly blob: Blob;
}

/** Hands either a legacy Blob or a private export capability to the browser's downloader. */
export function saveArchive(
  result: ArchiveResult | BlobDownload,
  target: Document = document,
): void {
  let objectUrl: string | null = null;
  const anchor = target.createElement('a');

  if ('blob' in result) {
    objectUrl = URL.createObjectURL(result.blob);
    anchor.href = objectUrl;
  } else {
    anchor.href = result.downloadUrl;
  }
  anchor.download = result.fileName;
  anchor.rel = 'noopener';
  anchor.referrerPolicy = 'no-referrer';
  target.body.append(anchor);
  anchor.click();
  anchor.remove();

  if (objectUrl !== null) {
    requestAnimationFrame(() => {
      URL.revokeObjectURL(objectUrl);
    });
  }
}
