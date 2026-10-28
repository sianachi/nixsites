import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import { downloadFileValue, probeFileValue, uploadFileValue } from './files.ts';
import { makeProfile } from './cli.test-helper.ts';

const API = 'http://nix.test';
const WS = '22222222-2222-4222-8222-222222222222';
const UPLOAD = 'a1111111-1111-4111-8111-111111111111';
const OPERATION = 'a2222222-2222-4222-8222-222222222222';
const ITEM = 'a3333333-3333-4333-8333-333333333333';
const VERSION = 'a4444444-4444-4444-8444-444444444444';
const server = setupServer(
  http.post(`${API}/public/v1/auth/token`, () =>
    HttpResponse.json({ accessToken: 'jwt-1', tokenType: 'Bearer', expiresInSeconds: 600 }),
  ),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const withProfile = () =>
  makeProfile({ apiUrl: API, token: 'nixpat_abc', collabUrl: 'http://nix.test:8100' });

function operation() {
  return {
    id: OPERATION,
    kind: 'file.inspect',
    status: 'completed',
    result: { itemId: ITEM },
    errorCode: null,
    errorDetail: null,
    attempts: 1,
    cancellationRequested: false,
    createdAt: '2026-09-01T00:00:00Z',
    completedAt: '2026-09-01T00:00:01Z',
  };
}

function fileRecord() {
  return {
    itemId: ITEM,
    workspaceId: WS,
    current: {
      id: VERSION,
      version: 1,
      fileName: 'sample.bin',
      mediaType: 'application/octet-stream',
      byteLength: 7,
      sha256: '1'.repeat(64),
      previewable: false,
      pixelWidth: null,
      pixelHeight: null,
      createdAt: '2026-09-01T00:00:01Z',
      current: true,
    },
    versions: [],
  };
}

describe('nixctl file', () => {
  it('streams an upload through a private capability and waits for inspection', async () => {
    const profile = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-files-source-'));
    const source = join(dir, 'sample.bin');
    await writeFile(source, 'payload');
    let uploaded = '';
    server.use(
      http.post(`${API}/api/v1/files/uploads`, () =>
        HttpResponse.json({
          id: UPLOAD,
          status: 'pending_upload',
          uploadUrl: 'http://localhost:9446/upload',
          capabilityExpiresAt: '2026-09-01T00:10:00Z',
          expiresAt: '2026-09-01T01:00:00Z',
          itemId: null,
          failureCode: null,
        }),
      ),
      http.put('http://localhost:9446/upload', async ({ request }) => {
        uploaded = await request.text();
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`${API}/api/v1/files/uploads/${UPLOAD}/complete`, () =>
        HttpResponse.json(operation(), { status: 202 }),
      ),
      http.get(`${API}/api/v1/operations/${OPERATION}`, () => HttpResponse.json(operation())),
      http.get(`${API}/api/v1/files/uploads/${UPLOAD}`, () =>
        HttpResponse.json({
          id: UPLOAD,
          status: 'completed',
          expiresAt: '2026-09-01T01:00:00Z',
          itemId: ITEM,
          failureCode: null,
        }),
      ),
      http.get(`${API}/api/v1/items/${ITEM}/file`, () => HttpResponse.json(fileRecord())),
    );

    const result = (await uploadFileValue(
      'default',
      { workspaceId: WS, path: source },
      { env: profile.env },
    )) as { itemId: string };

    expect(uploaded).toBe('payload');
    expect(result.itemId).toBe(ITEM);
    await rm(dir, { recursive: true, force: true });
    await profile.done();
  });

  it('authorizes and streams a historical version without overwriting an existing path', async () => {
    const profile = await withProfile();
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-files-download-'));
    const destination = join(dir, 'out.bin');
    server.use(
      http.get(`${API}/api/v1/items/${ITEM}/file/download`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('versionId')).toBe(VERSION);
        return HttpResponse.json({
          url: 'http://127.0.0.1:9446/download',
          expiresAt: '2026-09-01T00:10:00Z',
          fileName: 'sample.bin',
          mediaType: 'application/octet-stream',
          byteLength: 7,
          sha256: '1'.repeat(64),
          inline: false,
          unscanned: true,
          noSniff: true,
        });
      }),
      http.get('http://127.0.0.1:9446/download', () => new HttpResponse('payload')),
    );

    await downloadFileValue('default', ITEM, destination, VERSION, { env: profile.env });
    expect(await readFile(destination, 'utf8')).toBe('payload');
    await expect(
      downloadFileValue('default', ITEM, destination, VERSION, { env: profile.env }),
    ).rejects.toThrow(/exist/i);
    await rm(dir, { recursive: true, force: true });
    await profile.done();
  });
});

describe('file delivery probe', () => {
  it('uses Core authorization and checks ranges without returning a capability', async () => {
    const profile = await withProfile();
    try {
      server.use(
        http.get(`${API}/api/v1/items/${ITEM}/file/thumbnail`, () =>
          HttpResponse.json({
            url: 'https://objects.test/cover',
            expiresAt: '2099-01-01T00:00:00Z',
            width: 40,
            height: 60,
            byteLength: 100,
          }),
        ),
      );
      expect(
        await probeFileValue(undefined, ITEM, true, {
          env: profile.env,
          fetchImpl: async (input, init) => {
            if (input !== 'https://objects.test/cover') return fetch(input, init);
            expect(new Headers(init?.headers).get('Range')).toBe('bytes=0-63');
            expect(new Headers(init?.headers).has('Authorization')).toBe(false);
            expect(init?.credentials).toBe('omit');
            return new Response(new Uint8Array(64), {
              status: 206,
              headers: { 'content-type': 'image/jpeg', 'content-range': 'bytes 0-63/100' },
            });
          },
        }),
      ).toEqual({
        itemId: ITEM,
        thumbnail: true,
        status: 206,
        mediaType: 'image/jpeg',
        contentRange: 'bytes 0-63/100',
        disposition: null,
        bytes: 64,
      });
    } finally {
      await profile.done();
    }
  });
});
