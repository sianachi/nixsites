import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ObjectTransfer } from '../shared/object-transfer.ts';
import { buildSite } from './build.ts';
import { CoreClient } from './core-client.ts';
import { JobError } from './dispatch.ts';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/site-render/src/__fixtures__/blog',
);
const JOB = '0199c0de-0300-7000-8000-000000000001';
const EXECUTION = 'sites-test:exec-1';
const SECRET = 'test-secret';
const HOST_MANIFEST = JSON.stringify({ version: 1, buildId: 'b', generation: 1 });

const manifest = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8')) as Record<
  string,
  unknown
>;
const pages = JSON.parse(readFileSync(join(FIXTURE, 'pages.json'), 'utf8')) as {
  ordinal: number;
  itemId: string;
  content: { seq: number } | null;
}[];

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Core, collab and the object store, as three tiny servers that record what they were asked. */
class Harness {
  readonly calls: string[] = [];
  readonly objects = new Map<string, Buffer>();
  readonly uploaded: {
    path: string;
    kind: string;
    mediaType: string;
    sha256: string;
    byteLength: number;
  }[] = [];
  sealed: Record<string, unknown> | null = null;
  withhold = false;
  failPuts = false;
  precreated = new Set<string>();
  private servers: Server[] = [];
  coreUrl = '';
  collabUrl = '';
  s3Url = '';

  private serve(
    handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void,
  ): Promise<string> {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        handler(request, response, Buffer.concat(chunks));
      });
    });
    this.servers.push(server);
    return new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
      }),
    );
  }

  async start(): Promise<void> {
    this.s3Url = await this.serve((request, response, body) => {
      const key = request.url?.split('?')[0] ?? '';
      if (request.method === 'GET') {
        const name = key.replace('/obj/', '');
        const file = readdirSync(join(FIXTURE, 'files')).find((candidate) =>
          candidate.startsWith(name),
        );
        if (file === undefined) return void response.writeHead(404).end();
        return void response.writeHead(200).end(readFileSync(join(FIXTURE, 'files', file)));
      }
      this.calls.push(`put ${key}`);
      if (this.failPuts) return void response.writeHead(500).end();
      expect(request.headers['x-amz-checksum-sha256']).toBe(
        createHash('sha256').update(body).digest('base64'),
      );
      if (
        request.headers['if-none-match'] === '*' &&
        (this.objects.has(key) || this.precreated.has(key))
      ) {
        return void response.writeHead(412).end();
      }
      this.objects.set(key, body);
      response.writeHead(200).end();
    });

    this.collabUrl = await this.serve((request, response) => {
      expect(request.headers.authorization).toBe('Bearer body-token');
      expect(request.headers['x-nix-internal-secret']).toBe(SECRET);
      const itemId = /\/documents\/([^/]+)\/bundles/.exec(request.url ?? '')?.[1] ?? '';
      expect(request.url).toContain('scope=item&atSeq=');
      const path = join(FIXTURE, 'bodies', `${itemId}.json`);
      const body = this.withhold
        ? null
        : existsSync(path)
          ? (JSON.parse(readFileSync(path, 'utf8')) as unknown)
          : { schemaVersion: 1, prosemirror: { type: 'doc', content: [] } };
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(
        `${JSON.stringify({ format: 'nix-archive', formatVersion: 1, items: [] })}\n${JSON.stringify({ id: itemId, body })}\n${JSON.stringify({ end: true, items: 1 })}\n`,
      );
    });

    this.coreUrl = await this.serve((request, response, body) => {
      expect(request.headers['x-nix-internal-secret']).toBe(SECRET);
      expect(request.headers['x-nix-worker-job-id']).toBe(JOB);
      expect(request.headers['x-nix-worker-execution-id']).toBe(EXECUTION);
      const url = new URL(request.url ?? '/', 'http://core');
      const route =
        url.pathname.replace(`/internal/worker-executions/sites/builds/${JOB}`, '') || '/';
      this.calls.push(`${request.method ?? ''} ${route}`);
      const json = (value: unknown, status = 200): void => {
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(value));
      };

      if (route === '/') {
        json(manifest);
        return;
      }
      if (route === '/pages') {
        const after = Number(url.searchParams.get('after'));
        const limit = Number(url.searchParams.get('limit'));
        const rest = pages.filter((page) => page.ordinal > after);
        const take = rest.slice(0, 7); // small pages exercise the cursor
        void limit;
        json({
          pages: take,
          next: rest.length > take.length ? (take.at(-1)?.ordinal ?? null) : null,
        });
        return;
      }
      const bodyRoute = /^\/bodies\/([^/]+)$/.exec(route);
      if (bodyRoute !== null) {
        json({
          sourceUrl: `${this.collabUrl}/documents/${bodyRoute[1] ?? ''}/bundles?scope=item&atSeq=1`,
          bearerToken: 'body-token',
          expiresAt: '2026-10-11T13:00:00Z',
        });
        return;
      }
      const fileRoute = /^\/files\/([^/]+)$/.exec(route);
      if (fileRoute !== null) {
        const id = fileRoute[1] ?? '';
        const name = readdirSync(join(FIXTURE, 'files')).find((candidate) =>
          candidate.startsWith(id),
        );
        if (name === undefined) {
          json({ code: 'sites.file_unavailable', detail: 'no' }, 404);
          return;
        }
        const bytes = readFileSync(join(FIXTURE, 'files', name));
        json({
          fileItemId: id,
          fileVersionId: id,
          sha256: sha(bytes),
          mediaType:
            {
              jpg: 'image/jpeg',
              svg: 'image/svg+xml',
              pdf: 'application/pdf',
              txt: 'text/plain',
            }[name.slice(name.lastIndexOf('.') + 1)] ?? 'image/png',
          byteLength: bytes.length,
          fileName: (
            JSON.parse(readFileSync(join(FIXTURE, 'files', 'names.json'), 'utf8')) as Record<
              string,
              string
            >
          )[id],
          url: `${this.s3Url}/obj/${id}`,
          expiresAt: '2026-10-11T13:00:00Z',
        });
        return;
      }
      if (route === '/uploads') {
        const entries = (JSON.parse(body.toString()) as { entries: Harness['uploaded'] }).entries;
        expect(entries.length).toBeLessThanOrEqual(100);
        this.uploaded.push(...entries);
        json({
          targets: entries.map((entry) => ({
            path: entry.path,
            key: `k/${entry.kind}/${entry.path}`,
            uploadUrl: `${this.s3Url}/k/${entry.kind}/${entry.path}`,
            expiresAt: '2026-10-11T13:00:00Z',
          })),
        });
        return;
      }
      if (route === '/seal') {
        this.sealed = JSON.parse(body.toString()) as Record<string, unknown>;
        json({
          writes: [
            {
              hostname: 'blog.sites.test',
              key: 'sites/_hosts/blog.sites.test.json',
              body: HOST_MANIFEST,
              uploadUrl: `${this.s3Url}/host`,
              expiresAt: '2026-10-11T13:00:00Z',
            },
          ],
        });
        return;
      }
      if (route === '/activated') return void response.writeHead(204).end();
      response.writeHead(404).end();
    });
  }

  async stop(): Promise<void> {
    for (const server of this.servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  }

  run(): Promise<unknown> {
    const core = new CoreClient({ baseUrl: this.coreUrl, secret: SECRET });
    return buildSite(
      {
        core,
        objects: new ObjectTransfer({ origins: [this.s3Url] }),
        collab: new ObjectTransfer({ origins: [this.collabUrl] }),
        internalSecret: SECRET,
      },
      {
        job: {
          id: JOB,
          tenantId: 't',
          workspaceId: 'w',
          actorId: 'a',
          kind: 'site.build',
          payload: {},
          attempts: 1,
          cancellationRequested: false,
        },
        execution: { jobId: JOB, executionId: EXECUTION },
        signal: new AbortController().signal,
      },
    );
  }
}

let harness: Harness | null = null;
async function started(): Promise<Harness> {
  harness = new Harness();
  await harness.start();
  return harness;
}
afterEach(async () => {
  await harness?.stop();
  harness = null;
});

describe('buildSite', () => {
  // One successful build serves every test that only reads its result.
  const h = new Harness();
  let result: { buildId: string; pageCount: number; fileCount: number };
  beforeAll(async () => {
    await h.start();
    result = (await h.run()) as typeof result;
  });
  afterAll(() => h.stop());

  it('builds the fixture site and takes it live in the order Core requires', () => {
    expect(result).toMatchObject({ pageCount: 21 });
    // Everything is uploaded before the seal; the host manifest is written after the seal and
    // before the build is marked live, so an interrupted build is never served.
    const order = h.calls.map((call) => call.split(' ').slice(0, 2).join(' '));
    const seal = order.indexOf('POST /seal');
    const host = order.findIndex((call) => call === 'put /host');
    const activated = order.indexOf('POST /activated');
    const lastBuildPut = order.map((call) => call.startsWith('put /k/')).lastIndexOf(true);
    expect(lastBuildPut).toBeGreaterThan(-1);
    expect(lastBuildPut).toBeLessThan(seal);
    expect(host).toBeGreaterThan(seal);
    expect(activated).toBeGreaterThan(host);
    expect(h.objects.get('/host')?.toString()).toBe(HOST_MANIFEST);

    // Core's seal check: every upload recorded, with the index digest bound.
    const index = h.objects.get('/k/build/_nix/build.json');
    expect(h.sealed).toMatchObject({
      fileCount: h.uploaded.length,
      buildIndexSha256: sha(index ?? ''),
    });
    expect(h.objects.get('/k/build/index.html')?.toString()).toContain('<!doctype html>');
  });

  it('declares only extension and media-type pairs Core accepts, and keys assets by digest', () => {
    const accepted: Record<string, string> = {
      html: 'text/html',
      css: 'text/css',
      js: 'text/javascript',
      json: 'application/json',
      xml: 'application/xml',
      txt: 'text/plain',
      png: 'image/png',
      jpg: 'image/jpeg',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      woff2: 'font/woff2',
      pdf: 'application/pdf',
      csv: 'text/csv',
    };
    for (const entry of h.uploaded) {
      const extension = entry.path.slice(entry.path.lastIndexOf('.') + 1);
      expect(accepted[extension], entry.path).toBe(entry.mediaType);
      if (entry.kind === 'asset') expect(entry.path).toBe(`${entry.sha256}.${extension}`);
      else expect(entry.path).not.toMatch(/^\/|\.\./);
    }
    expect(h.uploaded.some((entry) => entry.kind === 'asset')).toBe(true);
    expect(
      h.uploaded.some((entry) => entry.path === 'feed.xml' || entry.path.endsWith('/feed.xml')),
    ).toBe(true);
  });

  it('publishes images with their metadata stripped', () => {
    const original = readFileSync(
      join(FIXTURE, 'files', '0199c0de-0200-7000-8000-000000000707.jpg'),
    );
    const jpegs = h.uploaded.filter(
      (entry) => entry.kind === 'asset' && entry.path.endsWith('.jpg'),
    );
    expect(jpegs).toHaveLength(1);
    const published = h.objects.get(`/k/asset/${jpegs[0]?.path ?? ''}`) ?? Buffer.alloc(0);
    expect(published.length).toBeLessThan(original.length);
    expect(sha(published)).toBe(jpegs[0]?.sha256);
  });

  it('publishes a captured Mermaid diagram re-sanitised, as an image on its page', () => {
    const svgs = h.uploaded.filter(
      (entry) => entry.kind === 'asset' && entry.path.endsWith('.svg'),
    );
    expect(svgs).toHaveLength(1);
    const published = h.objects.get(`/k/asset/${svgs[0]?.path ?? ''}`)?.toString() ?? '';
    expect(published).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(published).not.toMatch(/<script|foreignObject/);
    const post = h.objects
      .get('/k/build/blog/why-your-jetson-wont-stay-bricked/index.html')
      ?.toString();
    expect(post).toContain(`<img src="/_nix/assets/${svgs[0]?.path ?? ''}"`);
  });

  it('publishes an attached PDF as a download under its digest, linked from its page', () => {
    const pdfs = h.uploaded.filter(
      (entry) => entry.kind === 'asset' && entry.path.endsWith('.pdf'),
    );
    expect(pdfs).toHaveLength(1);
    expect(pdfs[0]?.mediaType).toBe('application/pdf');
    const original = readFileSync(
      join(FIXTURE, 'files', '0199c0de-0200-7000-8000-000000000709.pdf'),
    );
    expect(h.objects.get(`/k/asset/${pdfs[0]?.path ?? ''}`)).toEqual(original);
    const page = h.objects.get('/k/build/uses/index.html')?.toString();
    expect(page).toContain(`href="/_nix/files/${pdfs[0]?.sha256 ?? ''}/Desk-setup-2026.pdf"`);
  });

  // Mutates the shared store, so it runs after the read-only tests above.
  it('counts an object that is already in storage as written (a redelivered job)', async () => {
    // A second run against the same store: every create-only put now answers 412.
    h.precreated = new Set(h.objects.keys());
    h.objects.clear();
    await expect(h.run()).resolves.toMatchObject({ pageCount: 21 });
  });

  it('fails the job rather than publish a hole where a body was withheld', async () => {
    const h = await started();
    h.withhold = true;
    const failure = await h.run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobError);
    expect((failure as JobError).code).toBe('site_body_withheld');
    expect(h.calls.some((call) => call.includes('/seal') || call.includes('/activated'))).toBe(
      false,
    );
  });

  it('fails the job before the seal when an upload is refused', async () => {
    const h = await started();
    h.failPuts = true;
    await expect(h.run()).rejects.toThrow('The destination upload returned 500.');
    expect(h.calls.some((call) => call.includes('/seal'))).toBe(false);
  });
});
