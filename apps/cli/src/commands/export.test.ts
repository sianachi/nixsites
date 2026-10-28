import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import { outputOptions } from '../output.ts';
import { runExport } from './export.ts';
import { captureJson, makeProfile } from './cli.test-helper.ts';

const API = 'http://nix.test';
const DOWNLOAD = 'http://127.0.0.1:9446/export';
const ITEM = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const EXPORT = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const CREATED_AT = '2026-09-01T00:00:00+00:00';
const COMPLETED_AT = '2026-09-01T00:00:02+00:00';
const EXPIRES_AT = '2026-09-02T00:00:02+00:00';

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
  makeProfile({
    apiUrl: API,
    token: 'nixpat_abc',
    // Deliberately unreachable: any old format routing makes MSW fail the test as unhandled.
    collabUrl: 'http://unused-collaboration.test',
    mediaUrl: 'http://unused-media.test',
  });

function format(
  name: string,
  extension = name,
  mediaType = 'application/octet-stream',
): Record<string, unknown> {
  return {
    format: name,
    label: name.toUpperCase(),
    extension,
    mediaType,
    lossless: name === 'nix',
    declaredLoss: name === 'nix' ? [] : ['Some native body kinds may be omitted.'],
  };
}

function catalog(...formats: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { formats, observedAt: CREATED_AT };
}

function exportState(
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled',
  options: {
    readonly format?: string;
    readonly scope?: 'item' | 'subtree';
    readonly fileName?: string;
    readonly mediaType?: string;
    readonly byteLength?: number;
    readonly sha256?: string;
    readonly failureCode?: string;
    readonly failureDetail?: string;
  } = {},
): Record<string, unknown> {
  const completed = status === 'completed';
  return {
    id: EXPORT,
    itemId: ITEM,
    workspaceId: WORKSPACE,
    format: options.format ?? 'nix',
    scope: options.scope ?? 'item',
    fileName: options.fileName ?? 'Soup.nix',
    mediaType: options.mediaType ?? 'application/vnd.nix.archive',
    status,
    itemCount: completed ? 4 : null,
    omittedCount: completed ? 1 : null,
    byteLength: completed ? (options.byteLength ?? 7) : null,
    sha256: completed ? (options.sha256 ?? '1'.repeat(64)) : null,
    loss: completed ? ['Formatting was simplified.'] : [],
    omissions: completed ? ['One unsupported body was omitted.'] : [],
    failureCode: options.failureCode ?? null,
    failureDetail: options.failureDetail ?? null,
    cancellationRequested: status === 'cancelled',
    downloadReady: completed,
    createdAt: CREATED_AT,
    completedAt: completed || status === 'failed' || status === 'cancelled' ? COMPLETED_AT : null,
    expiresAt: completed ? EXPIRES_AT : null,
  };
}

function capability(input: {
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}): Record<string, unknown> {
  return { url: DOWNLOAD, expiresAt: EXPIRES_AT, ...input };
}

function chunked(bytes: Uint8Array) {
  const split = Math.max(1, Math.floor(bytes.byteLength / 2));
  return new HttpResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, split));
        controller.enqueue(bytes.subarray(split));
        controller.close();
      },
    }),
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('nixctl export', () => {
  it('discovers md through Core, polls with bounded backoff, and streams a verified file', async () => {
    const profile = await withProfile();
    const out = join(profile.dir, 'soup.md');
    const bytes = new TextEncoder().encode('# Soup\n');
    const digest = sha256(bytes);
    const delays: number[] = [];
    let polls = 0;
    let requestBody: Record<string, unknown> | undefined;

    server.use(
      http.get(`${API}/api/v1/exports/formats`, ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer jwt-1');
        return HttpResponse.json(catalog(format('markdown', 'md', 'text/markdown')));
      }),
      http.post(`${API}/api/v1/exports`, async ({ request }) => {
        requestBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          exportState('queued', {
            format: 'markdown',
            scope: 'subtree',
            fileName: 'Soup.md',
            mediaType: 'text/markdown',
          }),
          { status: 202 },
        );
      }),
      http.get(`${API}/api/v1/exports/${EXPORT}`, () => {
        polls += 1;
        if (polls === 2) {
          return HttpResponse.json(
            { code: 'exports.temporarily_unavailable', detail: 'Try again.', status: 503 },
            { status: 503, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        return HttpResponse.json(
          polls < 5
            ? exportState('running', {
                format: 'markdown',
                scope: 'subtree',
                fileName: 'Soup.md',
                mediaType: 'text/markdown',
              })
            : exportState('completed', {
                format: 'markdown',
                scope: 'subtree',
                fileName: 'Soup.md',
                mediaType: 'text/markdown',
                byteLength: bytes.byteLength,
                sha256: digest,
              }),
        );
      }),
      http.get(`${API}/api/v1/exports/${EXPORT}/download`, () =>
        HttpResponse.json(
          capability({
            fileName: 'Soup.md',
            mediaType: 'text/markdown',
            byteLength: bytes.byteLength,
            sha256: digest,
          }),
        ),
      ),
      http.get(DOWNLOAD, ({ request }) => {
        expect(request.headers.get('authorization')).toBeNull();
        return chunked(bytes);
      }),
    );

    const printed = (await captureJson((json) =>
      runExport('default', ITEM, { format: 'md', scope: 'subtree', out }, json, {
        env: profile.env,
        randomUUID: () => REQUEST_ID,
        sleep: (milliseconds) => {
          delays.push(milliseconds);
          return Promise.resolve();
        },
      }),
    )) as Record<string, unknown>;

    expect(requestBody).toMatchObject({ itemId: ITEM, format: 'markdown', scope: 'subtree' });
    expect(requestBody?.idempotencyKey).toMatch(
      new RegExp(`^nixctl-export:${ITEM}:markdown:subtree:`),
    );
    expect(delays).toEqual([250, 500, 1_000, 2_000, 2_000]);
    expect(await readFile(out, 'utf8')).toBe('# Soup\n');
    expect(printed).toMatchObject({
      id: ITEM,
      exportId: EXPORT,
      itemId: ITEM,
      format: 'md',
      canonicalFormat: 'markdown',
      scope: 'subtree',
      file: out,
      bytes: bytes.byteLength,
      sha256: digest,
      items: 4,
      omitted: 1,
    });
    await profile.done();
  });

  it('streams a completed lossless export to stdout without adding JSON', async () => {
    const profile = await withProfile();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const digest = sha256(bytes);
    const stdout = new PassThrough();
    const received: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => received.push(chunk));

    server.use(
      http.get(`${API}/api/v1/exports/formats`, () =>
        HttpResponse.json(catalog(format('nix', 'nix', 'application/vnd.nix.archive'))),
      ),
      http.post(`${API}/api/v1/exports`, () =>
        HttpResponse.json(
          exportState('completed', { byteLength: bytes.byteLength, sha256: digest }),
          { status: 202 },
        ),
      ),
      http.get(`${API}/api/v1/exports/${EXPORT}/download`, () =>
        HttpResponse.json(
          capability({
            fileName: 'Soup.nix',
            mediaType: 'application/vnd.nix.archive',
            byteLength: bytes.byteLength,
            sha256: digest,
          }),
        ),
      ),
      http.get(DOWNLOAD, () => chunked(bytes)),
    );

    await runExport(
      'default',
      ITEM,
      { format: 'nix', scope: 'item' },
      outputOptions(false, { isTTY: false }),
      { env: profile.env, stdout, randomUUID: () => REQUEST_ID },
    );

    expect(Buffer.concat(received)).toEqual(Buffer.from(bytes));
    expect(stdout.destroyed).toBe(false);
    await profile.done();
  });

  it('rejects a format that no active worker advertises before creating a job', async () => {
    const profile = await withProfile();
    let began = false;
    server.use(
      http.get(`${API}/api/v1/exports/formats`, () =>
        HttpResponse.json(catalog(format('nix', 'nix', 'application/vnd.nix.archive'))),
      ),
      http.post(`${API}/api/v1/exports`, () => {
        began = true;
        return HttpResponse.json(exportState('queued'), { status: 202 });
      }),
    );

    await expect(
      runExport(
        'default',
        ITEM,
        { format: 'pdf', scope: 'item', out: join(profile.dir, 'x.pdf') },
        outputOptions(true, { isTTY: false }),
        { env: profile.env },
      ),
    ).rejects.toThrow(/Active formats: nix/);
    expect(began).toBe(false);
    await profile.done();
  });

  it('preserves Core problem details when durable export creation is refused', async () => {
    const profile = await withProfile();
    server.use(
      http.get(`${API}/api/v1/exports/formats`, () =>
        HttpResponse.json(catalog(format('pdf', 'pdf', 'application/pdf'))),
      ),
      http.post(`${API}/api/v1/exports`, () =>
        HttpResponse.json(
          { code: 'exports.item_not_found', detail: 'That item is gone.', status: 404 },
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    );

    await expect(
      runExport(
        'default',
        ITEM,
        { format: 'pdf', scope: 'item', out: join(profile.dir, 'x.pdf') },
        outputOptions(true, { isTTY: false }),
        { env: profile.env },
      ),
    ).rejects.toMatchObject({
      status: 404,
      code: 'exports.item_not_found',
      detail: 'That item is gone.',
    });
    await profile.done();
  });

  it('cancels unfinished durable work when the caller aborts during polling', async () => {
    const profile = await withProfile();
    const controller = new AbortController();
    let cancelled = false;
    server.use(
      http.get(`${API}/api/v1/exports/formats`, () =>
        HttpResponse.json(catalog(format('nix', 'nix', 'application/vnd.nix.archive'))),
      ),
      http.post(`${API}/api/v1/exports`, () =>
        HttpResponse.json(exportState('queued'), { status: 202 }),
      ),
      http.post(`${API}/api/v1/exports/${EXPORT}/cancel`, () => {
        cancelled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(
      runExport(
        'default',
        ITEM,
        { format: 'nix', scope: 'item', out: join(profile.dir, 'x.nix') },
        outputOptions(true, { isTTY: false }),
        {
          env: profile.env,
          signal: controller.signal,
          sleep: (_milliseconds, signal) => {
            controller.abort(new Error('Stop this export.'));
            return Promise.reject(signal.reason as Error);
          },
        },
      ),
    ).rejects.toThrow('Stop this export.');
    expect(cancelled).toBe(true);
    await profile.done();
  });

  it.each([
    {
      name: 'byte count',
      declaredBytes: 8,
      declaredSha256: sha256(new TextEncoder().encode('payload')),
      message: /size did not match/,
    },
    {
      name: 'SHA-256',
      declaredBytes: 7,
      declaredSha256: 'f'.repeat(64),
      message: /checksum did not match/,
    },
  ])('rejects a downloaded export with a mismatched $name', async (testCase) => {
    const profile = await withProfile();
    const out = join(profile.dir, 'existing.nix');
    const bytes = new TextEncoder().encode('payload');
    await writeFile(out, 'keep me');
    server.use(
      http.get(`${API}/api/v1/exports/formats`, () =>
        HttpResponse.json(catalog(format('nix', 'nix', 'application/vnd.nix.archive'))),
      ),
      http.post(`${API}/api/v1/exports`, () =>
        HttpResponse.json(
          exportState('completed', {
            byteLength: testCase.declaredBytes,
            sha256: testCase.declaredSha256,
          }),
          { status: 202 },
        ),
      ),
      http.get(`${API}/api/v1/exports/${EXPORT}/download`, () =>
        HttpResponse.json(
          capability({
            fileName: 'Soup.nix',
            mediaType: 'application/vnd.nix.archive',
            byteLength: testCase.declaredBytes,
            sha256: testCase.declaredSha256,
          }),
        ),
      ),
      http.get(DOWNLOAD, () => chunked(bytes)),
    );

    await expect(
      runExport(
        'default',
        ITEM,
        { format: 'nix', scope: 'item', out },
        outputOptions(true, { isTTY: false }),
        { env: profile.env, randomUUID: () => REQUEST_ID },
      ),
    ).rejects.toThrow(testCase.message);
    expect(await readFile(out, 'utf8')).toBe('keep me');
    expect((await readdir(profile.dir)).some((name) => name.endsWith('.part'))).toBe(false);
    await profile.done();
  });
});
