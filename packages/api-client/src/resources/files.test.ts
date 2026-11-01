import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInMemoryTokenStore } from '../auth.js';
import { createNixClient } from '../client.js';
import { server, TEST_BASE_URL, testUrl } from '../testing/server.js';
import {
  beginUpload,
  cancelUpload,
  completeUpload,
  completeUploadAndWait,
  downloadFile,
  fetchFileContent,
  fileByItem,
  uploadById,
} from './files.js';

const ITEM = 'a1111111-1111-4111-8111-111111111111';
const WORKSPACE = 'a1000000-0000-4000-8000-000000000001';
const OPERATION = 'a2222222-2222-4222-8222-222222222222';
const upload = {
  id: ITEM,
  status: 'pending_upload',
  uploadUrl: 'https://objects.example/upload',
  capabilityExpiresAt: '2026-08-31T19:15:00+00:00',
  expiresAt: '2026-08-31T20:00:00+00:00',
  itemId: null,
  failureCode: null,
};
const version = {
  id: OPERATION,
  version: 1,
  fileName: 'photo.png',
  mediaType: 'image/png',
  byteLength: 12,
  sha256: '1'.repeat(64),
  previewable: true,
  pixelWidth: 3,
  pixelHeight: 4,
  createdAt: '2026-08-31T19:16:00+00:00',
  current: true,
  thumbnail: null,
};
const operation = {
  id: OPERATION,
  kind: 'file.publish',
  status: 'completed',
  result: null,
  errorCode: null,
  errorDetail: null,
  attempts: 1,
  cancellationRequested: false,
  createdAt: '2026-08-31T19:15:00+00:00',
  completedAt: '2026-08-31T19:16:00+00:00',
};

function clientWithInvalidations() {
  const client = createNixClient({
    baseUrl: TEST_BASE_URL,
    tokens: createInMemoryTokenStore({
      initialAccessToken: 'token',
      refresh: () => Promise.resolve(null),
    }),
  });
  const invalidations: string[][] = [];
  client.cache.subscribeInvalidation((prefix) => invalidations.push([...prefix]));
  return { client, invalidations };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('the files resource', () => {
  it('keeps file metadata and object capabilities behind Core', () => {
    expect(fileByItem(ITEM)).toMatchObject({
      path: `/api/v1/items/${ITEM}/file`,
      cacheKey: ['files', ITEM],
    });
    expect(downloadFile(ITEM)).toMatchObject({
      path: `/api/v1/items/${ITEM}/file/download`,
      query: { versionId: undefined, preview: false },
    });
    expect(
      beginUpload({
        workspaceId: WORKSPACE,
        parentId: null,
        fileName: 'photo.png',
        mediaType: 'image/png',
        byteLength: 12,
        idempotencyKey: 'one',
      }),
    ).toMatchObject({ path: '/api/v1/files/uploads', method: 'POST' });
  });

  it('completes only the exact object capability Core initiated', () => {
    const endpoint = completeUpload(upload);
    expect(endpoint.path).toBe(`/api/v1/files/uploads/${ITEM}/complete`);
    expect(endpoint.body).toBeUndefined();
    expect(endpoint.invalidates).toEqual([]);
    expect(cancelUpload(ITEM)).toMatchObject({
      path: `/api/v1/files/uploads/${ITEM}`,
      method: 'DELETE',
    });
  });

  it('refreshes the published file and its workspace only after durable publication', async () => {
    const { client, invalidations } = clientWithInvalidations();
    server.use(
      http.post(testUrl(`/api/v1/files/uploads/${ITEM}/complete`), () =>
        HttpResponse.json({ ...operation, status: 'queued', completedAt: null }, { status: 202 }),
      ),
      http.get(testUrl(`/api/v1/operations/${OPERATION}`), () => {
        expect(invalidations).toEqual([]);
        return HttpResponse.json(operation);
      }),
      http.get(testUrl(`/api/v1/files/uploads/${ITEM}`), () =>
        HttpResponse.json({ ...upload, status: 'completed', itemId: ITEM }),
      ),
      http.get(testUrl(`/api/v1/items/${ITEM}/file`), () => {
        expect(invalidations).toEqual([
          ['file-uploads', ITEM],
          ['items', ITEM],
          ['files', ITEM],
        ]);
        return HttpResponse.json({
          itemId: ITEM,
          workspaceId: WORKSPACE,
          current: version,
          versions: [version],
        });
      }),
    );

    const published = await completeUploadAndWait(client, upload);

    expect(published.current.fileName).toBe('photo.png');
    expect(invalidations).toEqual([
      ['file-uploads', ITEM],
      ['items', ITEM],
      ['files', ITEM],
      ['workspaces', WORKSPACE, 'items'],
    ]);
  });

  it('does not announce file publication when the durable upload has failed', async () => {
    const { client, invalidations } = clientWithInvalidations();
    server.use(
      http.post(testUrl(`/api/v1/files/uploads/${ITEM}/complete`), () =>
        HttpResponse.json(operation, { status: 202 }),
      ),
      http.get(testUrl(`/api/v1/operations/${OPERATION}`), () => HttpResponse.json(operation)),
      http.get(testUrl(`/api/v1/files/uploads/${ITEM}`), () =>
        HttpResponse.json({ ...upload, status: 'failed', failureCode: 'file.inspection_failed' }),
      ),
    );

    await expect(completeUploadAndWait(client, upload)).rejects.toThrow('file.inspection_failed');
    expect(invalidations).toEqual([['file-uploads', ITEM]]);
  });

  it('announces durable publication even when the subsequent file metadata read fails', async () => {
    const { client, invalidations } = clientWithInvalidations();
    server.use(
      http.post(testUrl(`/api/v1/files/uploads/${ITEM}/complete`), () =>
        HttpResponse.json(operation, { status: 202 }),
      ),
      http.get(testUrl(`/api/v1/operations/${OPERATION}`), () => HttpResponse.json(operation)),
      http.get(testUrl(`/api/v1/files/uploads/${ITEM}`), () =>
        HttpResponse.json({ ...upload, status: 'completed', itemId: ITEM }),
      ),
      http.get(testUrl(`/api/v1/items/${ITEM}/file`), () =>
        HttpResponse.json({ title: 'Temporarily unavailable', status: 503 }, { status: 503 }),
      ),
    );

    await expect(completeUploadAndWait(client, upload)).rejects.toMatchObject({ status: 503 });
    expect(invalidations).toEqual([
      ['file-uploads', ITEM],
      ['items', ITEM],
      ['files', ITEM],
    ]);
  });

  it('reads the published replacement while older upload and metadata requests are still pending', async () => {
    const { client } = clientWithInvalidations();
    const metadataStarted = gate();
    const statusStarted = gate();
    const oldMetadata = gate();
    const oldStatus = gate();
    let metadataReads = 0;
    let statusReads = 0;
    server.use(
      http.post(testUrl(`/api/v1/files/uploads/${ITEM}/complete`), () =>
        HttpResponse.json(operation, { status: 202 }),
      ),
      http.get(testUrl(`/api/v1/operations/${OPERATION}`), () => HttpResponse.json(operation)),
      http.get(testUrl(`/api/v1/files/uploads/${ITEM}`), async () => {
        statusReads += 1;
        if (statusReads === 1) {
          statusStarted.resolve();
          await oldStatus.promise;
          return HttpResponse.json(upload);
        }
        return HttpResponse.json({ ...upload, status: 'completed', itemId: ITEM });
      }),
      http.get(testUrl(`/api/v1/items/${ITEM}/file`), async () => {
        metadataReads += 1;
        if (metadataReads === 1) {
          metadataStarted.resolve();
          await oldMetadata.promise;
          return HttpResponse.json({
            itemId: ITEM,
            workspaceId: WORKSPACE,
            current: version,
            versions: [version],
          });
        }
        const replaced = { ...version, version: 2, fileName: 'replacement.png' };
        return HttpResponse.json({
          itemId: ITEM,
          workspaceId: WORKSPACE,
          current: replaced,
          versions: [version, replaced],
        });
      }),
    );
    const originalMetadata = client.query(fileByItem(ITEM));
    const originalStatus = client.query(uploadById(ITEM));
    await Promise.all([metadataStarted.promise, statusStarted.promise]);

    const published = await completeUploadAndWait(client, upload);
    oldMetadata.resolve();
    oldStatus.resolve();
    await Promise.all([originalMetadata, originalStatus]);

    expect(published.current.fileName).toBe('replacement.png');
    expect(client.cache.peek(['files', ITEM])?.data).toEqual(published);
    expect(client.cache.peek(['file-uploads', ITEM])?.data).toMatchObject({ status: 'completed' });
    expect(metadataReads).toBe(2);
    expect(statusReads).toBe(2);
  });
});

describe('fetchFileContent offline', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const capability = (url: string) => ({
    url,
    expiresAt: '2026-08-31T19:15:00+00:00',
    fileName: 'a.txt',
    mediaType: 'text/plain',
    byteLength: 3,
    sha256: 'a'.repeat(64),
    inline: true,
    unscanned: false,
    noSniff: true,
  });
  const clientFor = (url: string) =>
    createNixClient({
      baseUrl: TEST_BASE_URL,
      tokens: createInMemoryTokenStore('t'),
      fetch: () => Promise.resolve(Response.json(capability(url))),
    });

  it('reads a blob made by this page, and only that page', async () => {
    vi.stubGlobal('location', { origin: 'https://nix.example' });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('abc')));
    const read = await fetchFileContent(clientFor('blob:https://nix.example/1'), ITEM);
    expect(read.blob.size).toBe(3);
    await expect(fetchFileContent(clientFor('blob:https://evil.example/1'), ITEM)).rejects.toThrow(
      /HTTPS/,
    );
  });
});
