import type { NixClient } from '../client.js';
import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  exportDownloadCapabilitySchema,
  exportFormatCatalogSchema,
  exportSchema,
  type Export,
  type ExportDownloadCapability,
  type ExportFormatCatalog,
} from '../schemas/exports.js';
import { noContentSchema } from '../schemas/index.js';

export interface BeginExportInput {
  readonly itemId: string;
  readonly format: string;
  readonly scope: 'item' | 'subtree';
  readonly idempotencyKey: string;
  /** Adds each note's comment threads to the export (Markdown, PDF, DOCX and .nix). */
  readonly includeComments?: boolean;
}

export const formats = (): QueryEndpoint<ExportFormatCatalog> =>
  defineQuery({
    operation: 'exports.formats',
    path: '/api/v1/exports/formats',
    schema: exportFormatCatalogSchema,
    cacheKey: ['exports', 'formats'],
    staleAfterMs: 15_000,
  });

export const begin = (input: BeginExportInput): CommandEndpoint<Export> =>
  defineCommand({
    operation: 'exports.begin',
    method: 'POST',
    path: '/api/v1/exports',
    body: input,
    schema: exportSchema,
    invalidates: [['exports']],
  });

export const byId = (exportId: string): QueryEndpoint<Export> =>
  defineQuery({
    operation: 'exports.get',
    path: `/api/v1/exports/${exportId}`,
    schema: exportSchema,
    cacheKey: ['exports', exportId],
    staleAfterMs: 0,
  });

export const cancel = (exportId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'exports.cancel',
    method: 'POST',
    path: `/api/v1/exports/${exportId}/cancel`,
    schema: noContentSchema,
    invalidates: [['exports', exportId]],
  });

export const authorizeDownload = (exportId: string): QueryEndpoint<ExportDownloadCapability> =>
  defineQuery({
    operation: 'exports.download.authorize',
    path: `/api/v1/exports/${exportId}/download`,
    schema: exportDownloadCapabilitySchema,
    cacheKey: ['exports', exportId, 'download'],
    staleAfterMs: 0,
  });

export async function beginAndWait(
  client: NixClient,
  input: BeginExportInput,
  options: {
    readonly signal?: AbortSignal;
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
    readonly onStarted?: (state: Export) => void;
    readonly onProgress?: (state: Export) => void;
  } = {},
): Promise<Export> {
  const started = await client.execute(begin(input), { signal: options.signal });
  options.onStarted?.(started);
  return waitForExport(client, started, options);
}

export async function waitForExport(
  client: NixClient,
  initial: Export,
  options: {
    readonly signal?: AbortSignal;
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
    readonly onProgress?: (state: Export) => void;
  } = {},
): Promise<Export> {
  const pollIntervalMs = options.pollIntervalMs ?? 750;
  if (
    pollIntervalMs < 10 ||
    (options.timeoutMs !== undefined && options.timeoutMs < pollIntervalMs)
  ) {
    throw new RangeError('Export polling limits are invalid.');
  }

  const deadline = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs;
  let state = initial;
  options.onProgress?.(state);

  while (!isTerminal(state)) {
    options.signal?.throwIfAborted();
    if (deadline !== null && Date.now() >= deadline) {
      throw new Error('The export did not finish before its deadline.');
    }
    await delay(pollIntervalMs, options.signal);
    state = await client.query(byId(state.id), {
      signal: options.signal,
      forceRefresh: true,
    });
    options.onProgress?.(state);
  }

  return state;
}

export async function downloadCapability(
  client: NixClient,
  exportId: string,
  signal?: AbortSignal,
): Promise<ExportDownloadCapability> {
  const capability = await client.query(authorizeDownload(exportId), {
    signal,
    forceRefresh: true,
  });
  validateCapabilityAddress(capability.url);
  if (Date.parse(capability.expiresAt) <= Date.now()) {
    throw new Error('The export download capability has expired.');
  }
  return capability;
}

export async function downloadForCompletedExport(
  client: NixClient,
  state: Export,
  signal?: AbortSignal,
): Promise<ExportDownloadCapability> {
  if (state.status !== 'completed' || !state.downloadReady) {
    throw new Error('The export is not ready to download.');
  }
  const capability = await downloadCapability(client, state.id, signal);
  if (
    state.byteLength === null ||
    state.sha256 === null ||
    BigInt(state.byteLength) !== BigInt(capability.byteLength) ||
    state.sha256 !== capability.sha256 ||
    state.fileName !== capability.fileName ||
    state.mediaType !== capability.mediaType
  ) {
    throw new Error('The export download capability did not match the completed job.');
  }
  return capability;
}

function isTerminal(state: Export): boolean {
  return state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled';
}

function validateCapabilityAddress(value: string): void {
  const url = new URL(value);
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError('Export download capabilities must use HTTPS outside local development.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Export download capabilities cannot contain URL credentials.');
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', cancelWait, { once: true });

    function finish(): void {
      signal?.removeEventListener('abort', cancelWait);
      resolve();
    }

    function cancelWait(): void {
      globalThis.clearTimeout(timer);
      const reason = signal?.reason as unknown;
      reject(reason instanceof Error ? reason : new Error('The export wait was cancelled.'));
    }
  });
}
