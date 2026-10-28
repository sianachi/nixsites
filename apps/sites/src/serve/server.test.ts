import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { readServeConfig } from './config.ts';
import { PDF_CSP, SVG_CSP, createSiteServer, hostnameOf, normalizePath } from './server.ts';
import type { ObjectReader } from './store.ts';

const SITE = '11111111-1111-4111-8111-111111111111';
const BUILD = '22222222-2222-4222-8222-222222222222';
const BUILD_PREFIX = `sites/${SITE}/builds/${BUILD}/`;
const ASSETS_PREFIX = `sites/${SITE}/assets/`;
const SHA = 'a'.repeat(64);

function memory(objects: Record<string, string>): ObjectReader {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async open(key, method, range) {
      const value = objects[key];
      if (value === undefined) return null;
      const bytes = Buffer.from(value);
      const [from, to] = range === undefined ? [] : range.slice('bytes='.length).split('-');
      const start = from === undefined || from === '' ? 0 : Number(from);
      if (range !== undefined && start >= bytes.length) {
        return {
          length: null,
          status: 416,
          contentRange: `bytes */${String(bytes.length)}`,
          body: null,
        };
      }
      const end = to === undefined || to === '' ? bytes.length - 1 : Number(to);
      const part = range === undefined ? bytes : bytes.subarray(start, end + 1);
      return {
        length: part.length,
        status: range === undefined ? 200 : 206,
        contentRange:
          range === undefined
            ? null
            : `bytes ${String(start)}-${String(start + part.length - 1)}/${String(bytes.length)}`,
        body: method === 'HEAD' ? null : new Blob([part]).stream(),
      };
    },
  };
}

function hostManifest(
  extra: { generation?: number; redirectTo?: string | null; buildPrefix?: string } = {},
): string {
  return JSON.stringify({
    version: 1,
    siteId: SITE,
    buildId: BUILD,
    generation: extra.generation ?? 1,
    buildPrefix: extra.buildPrefix ?? BUILD_PREFIX,
    assetsPrefix: ASSETS_PREFIX,
    canonicalHost: 'docs.sites.test',
    activatedAt: '2026-10-11T00:00:00Z',
    redirectTo: extra.redirectTo ?? null,
  });
}

const published: Record<string, string> = {
  'sites/_hosts/docs.sites.test.json': hostManifest(),
  [`${BUILD_PREFIX}index.html`]: '<h1>home</h1>',
  [`${BUILD_PREFIX}guide/index.html`]: '<h1>guide</h1>',
  [`${BUILD_PREFIX}404.html`]: '<h1>gone</h1>',
  [`${BUILD_PREFIX}_nix/redirects.json`]: JSON.stringify({
    '/old/': '/guide/',
    '/evil/': '//evil.example/',
  }),
  [`${BUILD_PREFIX}_nix/theme/abc/site.css`]: 'body{}',
  [`${ASSETS_PREFIX}${SHA}.png`]: 'png-bytes',
  [`${ASSETS_PREFIX}${SHA}.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  [`${ASSETS_PREFIX}${SHA}.pdf`]: '%PDF-1.4',
  [`${ASSETS_PREFIX}${SHA}.csv`]: 'a,b',
  [`${ASSETS_PREFIX}${SHA}.mp4`]: '0123ftypvideo-bytes',
  [`${BUILD_PREFIX}_nix/build.json`]: JSON.stringify({
    files: [
      `_nix/assets/${SHA}.png`,
      `_nix/assets/${SHA}.svg`,
      `_nix/files/${SHA}/My-CV.pdf`,
      `_nix/files/${SHA}/data.csv`,
      `_nix/files/${SHA}/clip.mp4`,
    ].map((path) => ({ path, kind: 'asset' })),
  }),
  [`${ASSETS_PREFIX}${'b'.repeat(64)}.pdf`]: '%PDF-1.4 withdrawn',
  [`${BUILD_PREFIX}secret.bin`]: 'must never be served',
};

let server: Server | null = null;

async function start(
  objects: Record<string, string>,
  defaultLabelSuffix?: string,
): Promise<number> {
  server = createSiteServer({
    reader: memory(objects),
    allowedSuffix: 'sites.test',
    ...(defaultLabelSuffix === undefined ? {} : { defaultLabelSuffix }),
    manifestTtlMs: 0,
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  const closing = server;
  server = null;
  closing?.closeAllConnections();
  await new Promise<void>((resolve) => {
    if (closing === null) resolve();
    else
      closing.close(() => {
        resolve();
      });
  });
});

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw request: unlike fetch, it sends the target and Host exactly as given. */
function get(
  port: number,
  target: string,
  host: string,
  method = 'GET',
  extra: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { port, host: '127.0.0.1', path: target, method, headers: { host, ...extra } },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('normalizePath', () => {
  it.each([
    '/a/../b',
    '/a/./b',
    '/%2e%2e/x',
    '/a%2Fb',
    '/a%5Cb',
    '/a\\b',
    '/a%00b',
    '//evil.example',
    '/a//b',
    '/%zz',
  ])('refuses %s', (value) => {
    // `%2e%2e` decodes to `..`, which is refused as a segment.
    expect(normalizePath(value)).toBeNull();
  });

  it('decodes once and drops the query', () => {
    expect(normalizePath('/guide/?q=1')).toBe('/guide/');
    expect(normalizePath('/caf%C3%A9')).toBe('/café');
  });
});

describe('hostnameOf', () => {
  it('lowercases and strips a port', () => {
    expect(hostnameOf('Docs.Sites.Test:8400')).toBe('docs.sites.test');
  });
  it.each([undefined, '', 'docs.sites.test/evil', 'a b.sites.test', 'localhost'])(
    'rejects %s',
    (value) => {
      expect(hostnameOf(value)).toBeNull();
    },
  );
});

describe('the sites server', () => {
  it('serves a page with the site headers and no cookie', async () => {
    const port = await start(published);
    const answer = await get(port, '/', 'docs.sites.test');
    expect(answer.status).toBe(200);
    expect(answer.body).toBe('<h1>home</h1>');
    expect(answer.headers['content-security-policy']).toContain("default-src 'none'");
    expect(answer.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['x-frame-options']).toBe('DENY');
    expect(answer.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(answer.headers['set-cookie']).toBeUndefined();
  });

  it('never sets a cookie, on any kind of response', async () => {
    const port = await start(published);
    for (const [target, host, method] of [
      ['/', 'docs.sites.test', 'GET'],
      ['/nope/', 'docs.sites.test', 'GET'],
      ['/guide', 'docs.sites.test', 'GET'],
      ['/', 'docs.sites.test', 'POST'],
      ['/', 'sites.test', 'GET'],
      ['/', 'evil.example', 'GET'],
      ['/a/../b', 'docs.sites.test', 'GET'],
      ['/', 'unknown.sites.test', 'GET'],
      ['/', 'docs.sites.test', 'HEAD'],
    ] as const) {
      const answer = await get(port, target, host, method);
      expect(answer.headers['set-cookie'], `${method} ${host}${target}`).toBeUndefined();
      expect(answer.headers['content-security-policy'], `${method} ${host}${target}`).toBeDefined();
    }
  });

  it('refuses the apex and any host outside the allowed suffix', async () => {
    const port = await start(published);
    expect((await get(port, '/', 'sites.test')).status).toBe(421);
    expect((await get(port, '/', 'sites.test:8400')).status).toBe(421);
    expect((await get(port, '/', 'docs.other.test')).status).toBe(421);
    expect((await get(port, '/', 'evilsites.test')).status).toBe(421);
    expect((await get(port, '/', 'nix.example.com')).status).toBe(421);
  });

  it('with a label suffix answers only one-label hosts ending in it, and custom hosts by manifest', async () => {
    const port = await start(
      {
        ...published,
        'sites/_hosts/docs-home.sites.test.json': hostManifest(),
        'sites/_hosts/docs.example.org.json': hostManifest(),
      },
      '-home',
    );
    expect((await get(port, '/', 'docs-home.sites.test')).status).toBe(200);
    expect((await get(port, '/', 'docs.example.org')).status).toBe(200);
    expect((await get(port, '/', 'nobody-home.sites.test')).status).toBe(404);
    // The unsuffixed deployment's names, deeper names and the bare suffix label are not this server's.
    expect((await get(port, '/', 'docs.sites.test')).status).toBe(421);
    expect((await get(port, '/', 'a.docs-home.sites.test')).status).toBe(421);
    expect((await get(port, '/', '-home.sites.test')).status).toBe(421);
    expect((await get(port, '/', 'sites.test')).status).toBe(421);
  });

  it('answers 404 for a host with no manifest, with the theme 404 absent', async () => {
    const port = await start(published);
    expect((await get(port, '/', 'nobody.sites.test')).status).toBe(404);
  });

  it('does not serve a build whose host manifest was never written', async () => {
    const interrupted = { ...published };
    delete interrupted['sites/_hosts/docs.sites.test.json'];
    const port = await start(interrupted);
    const answer = await get(port, '/', 'docs.sites.test');
    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain('home');
  });

  it('refuses a host manifest that points outside a site prefix', async () => {
    const port = await start({
      ...published,
      'sites/_hosts/docs.sites.test.json': JSON.stringify({
        version: 1,
        buildPrefix: 'sites/_hosts/',
        assetsPrefix: ASSETS_PREFIX,
      }),
    });
    expect((await get(port, '/', 'docs.sites.test')).status).toBe(404);
  });

  it('refuses traversal and encoded separators', async () => {
    const port = await start(published);
    for (const target of [
      '/a/../index.html',
      '/%2e%2e/secret.bin',
      '/a%2f..%2fb',
      '/a%5cb',
      '/a%00b',
      '//evil.example/x',
    ]) {
      expect((await get(port, target, 'docs.sites.test')).status, target).toBe(400);
    }
  });

  it('serves the theme 404 page with status 404', async () => {
    const port = await start(published);
    const answer = await get(port, '/missing/', 'docs.sites.test');
    expect(answer.status).toBe(404);
    expect(answer.body).toBe('<h1>gone</h1>');
  });

  it('serves only known extensions', async () => {
    const port = await start(published);
    const answer = await get(port, '/secret.bin', 'docs.sites.test');
    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain('never be served');
  });

  it('redirects a moved path with 308, and a directory without its slash to its slash', async () => {
    const port = await start(published);
    const moved = await get(port, '/old/', 'docs.sites.test');
    expect(moved.status).toBe(308);
    expect(moved.headers.location).toBe('/guide/');
    const slash = await get(port, '/guide', 'docs.sites.test');
    expect(slash.status).toBe(308);
    expect(slash.headers.location).toBe('/guide/');
  });

  it('does not follow a redirect target that leaves the site', async () => {
    const port = await start(published);
    const answer = await get(port, '/evil/', 'docs.sites.test');
    expect(answer.status).toBe(404);
    expect(answer.headers.location).toBeUndefined();
  });

  it('maps assets to the site asset prefix, immutable, and rejects other names', async () => {
    const port = await start(published);
    const asset = await get(port, `/_nix/assets/${SHA}.png`, 'docs.sites.test');
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toBe('image/png');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await get(port, '/_nix/assets/not-a-digest.png', 'docs.sites.test')).status).toBe(404);
    const theme = await get(port, '/_nix/theme/abc/site.css', 'docs.sites.test');
    expect(theme.headers['cache-control']).toContain('immutable');
  });

  it('serves a captured diagram with a policy that lets nothing run or load', async () => {
    const port = await start(published);
    const diagram = await get(port, `/_nix/assets/${SHA}.svg`, 'docs.sites.test');
    expect(diagram.status).toBe(200);
    expect(diagram.headers['content-type']).toBe('image/svg+xml');
    expect(diagram.headers['content-security-policy']).toBe(SVG_CSP);
    expect(diagram.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves a download from the asset prefix: every file an attachment, a PDF also sandboxed', async () => {
    const port = await start(published);
    const pdf = await get(port, `/_nix/files/${SHA}/My-CV.pdf`, 'docs.sites.test');
    expect(pdf.status).toBe(200);
    expect(pdf.body).toBe('%PDF-1.4');
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe('attachment; filename="My-CV.pdf"');
    expect(pdf.headers['content-security-policy']).toBe(PDF_CSP);
    expect(pdf.headers['x-content-type-options']).toBe('nosniff');
    expect(pdf.headers['cache-control']).toBe('public, max-age=300');
    const csv = await get(port, `/_nix/files/${SHA}/data.csv`, 'docs.sites.test');
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="data.csv"');
    expect(csv.headers['cache-control']).toBe('public, max-age=300');
    for (const target of [
      `/_nix/files/${SHA}/My-CV.html`,
      `/_nix/files/${SHA}/a%22b.pdf`,
      `/_nix/files/not-a-digest/a.pdf`,
      `/_nix/files/${SHA}.pdf`,
      `/_nix/files/${SHA}/x.txt`,
    ]) {
      expect((await get(port, target, 'docs.sites.test')).status, target).toBe(404);
    }
  });

  it('does not serve a stored file the live build no longer lists', async () => {
    const port = await start(published);
    const gone = 'b'.repeat(64);
    expect((await get(port, `/_nix/files/${gone}/Old.pdf`, 'docs.sites.test')).status).toBe(404);
    expect((await get(port, `/_nix/assets/${gone}.png`, 'docs.sites.test')).status).toBe(404);
  });

  it('serves a video and answers a range, so a player can seek', async () => {
    const port = await start(published);
    const path = `/_nix/files/${SHA}/clip.mp4`;
    const whole = await get(port, path, 'docs.sites.test');
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    const part = await get(port, path, 'docs.sites.test', 'GET', { range: 'bytes=4-7' });
    expect(part.status).toBe(206);
    expect(part.body).toBe('ftyp');
    expect(part.headers['content-range']).toBe('bytes 4-7/19');
    const past = await get(port, path, 'docs.sites.test', 'GET', { range: 'bytes=500-' });
    expect(past.status).toBe(416);
    // A range list is ignored, not forwarded.
    const list = await get(port, path, 'docs.sites.test', 'GET', { range: 'bytes=0-1,4-5' });
    expect(list.status).toBe(200);
  });

  it('allows only GET and HEAD, and HEAD carries no body', async () => {
    const port = await start(published);
    const post = await get(port, '/', 'docs.sites.test', 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    const head = await get(port, '/', 'docs.sites.test', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe(String('<h1>home</h1>'.length));
  });

  it('serves a custom hostname only once Core wrote its manifest, and still refuses the apex', async () => {
    const objects = { ...published, 'sites/_hosts/osinachi.example.com.json': hostManifest() };
    const port = await start(objects);
    const custom = await get(port, '/guide/', 'osinachi.example.com');
    expect(custom.status).toBe(200);
    expect(custom.body).toBe('<h1>guide</h1>');
    expect((await get(port, '/', 'unverified.example.com')).status).toBe(421);
    expect((await get(port, '/', 'sites.test')).status).toBe(421);
  });

  it('sends a redirect alias to the canonical origin with 308, keeping path and query', async () => {
    const objects = {
      ...published,
      'sites/_hosts/old.sites.test.json': hostManifest({ redirectTo: 'https://docs.example.com' }),
      'sites/_hosts/bad.sites.test.json': hostManifest({ redirectTo: 'javascript:alert(1)' }),
    };
    const port = await start(objects);
    const moved = await get(port, '/guide/?q=1&x=y', 'old.sites.test');
    expect(moved.status).toBe(308);
    expect(moved.headers.location).toBe('https://docs.example.com/guide/?q=1&x=y');
    // The decoded path is encoded again: a %3F stays in the path, and a non-Latin-1 name redirects
    // instead of failing.
    const encoded = await get(port, '/a%3Fb/%E4%B8%AD', 'old.sites.test');
    expect(encoded.status).toBe(308);
    expect(encoded.headers.location).toBe('https://docs.example.com/a%3Fb/%E4%B8%AD');
    expect((await get(port, '/', 'bad.sites.test')).status).toBe(404);
  });

  it('keeps the newer generation when an older host manifest lands after it', async () => {
    const other = `sites/${SITE}/builds/33333333-3333-4333-8333-333333333333/`;
    const objects: Record<string, string> = {
      ...published,
      'sites/_hosts/docs.sites.test.json': hostManifest({ generation: 5 }),
      [`${other}index.html`]: '<h1>older</h1>',
    };
    const port = await start(objects);
    expect((await get(port, '/', 'docs.sites.test')).body).toBe('<h1>home</h1>');
    objects['sites/_hosts/docs.sites.test.json'] = hostManifest({
      generation: 4,
      buildPrefix: other,
    });
    expect((await get(port, '/', 'docs.sites.test')).body).toBe('<h1>home</h1>');
    objects['sites/_hosts/docs.sites.test.json'] = hostManifest({
      generation: 6,
      buildPrefix: other,
    });
    expect((await get(port, '/', 'docs.sites.test')).body).toBe('<h1>older</h1>');
  });

  it('survives a stored body that fails mid-stream and answers the next request', async () => {
    const reader = memory(published);
    server = createSiteServer({
      reader: {
        async open(key, method) {
          if (!key.endsWith('guide/index.html')) return reader.open(key, method);
          await Promise.resolve();
          return {
            length: 1000,
            status: 200,
            contentRange: null,
            body: new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode('<h1>par'));
                controller.error(new Error('storage reset'));
              },
            }),
          };
        },
      },
      allowedSuffix: 'sites.test',
      manifestTtlMs: 0,
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await get(port, '/guide/', 'docs.sites.test').catch(() => undefined);
    expect((await get(port, '/', 'docs.sites.test')).body).toBe('<h1>home</h1>');
  });

  it('bounds the host cache, so a flood of unknown hosts cannot grow it without limit', async () => {
    const reads: string[] = [];
    const reader = memory({});
    server = createSiteServer({
      reader: {
        open(key, method) {
          reads.push(key);
          return reader.open(key, method);
        },
      },
      allowedSuffix: 'sites.test',
      manifestTtlMs: 60_000,
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const first = 'sites/_hosts/h0.sites.test.json';
    await get(port, '/', 'h0.sites.test');
    await get(port, '/', 'h0.sites.test');
    expect(reads.filter((key) => key === first)).toHaveLength(1);
    for (let i = 1; i <= 1100; i++) await get(port, '/', `h${String(i)}.sites.test`);
    // The oldest miss was evicted to stay under the cap, so it is read again.
    await get(port, '/', 'h0.sites.test');
    expect(reads.filter((key) => key === first)).toHaveLength(2);
  });
  it('reads the host manifest once for requests that arrive while it is being read', async () => {
    const reads: string[] = [];
    const reader = memory(published);
    server = createSiteServer({
      reader: {
        async open(key, method) {
          reads.push(key);
          await new Promise((resolve) => setTimeout(resolve, 50));
          return reader.open(key, method);
        },
      },
      allowedSuffix: 'sites.test',
      manifestTtlMs: 0,
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => get(port, '/', 'docs.sites.test')),
    );
    expect(responses.every((response) => response.body === '<h1>home</h1>')).toBe(true);
    expect(reads.filter((key) => key === 'sites/_hosts/docs.sites.test.json')).toHaveLength(1);
    expect(reads.filter((key) => key.endsWith('_nix/redirects.json'))).toHaveLength(1);
  });
});

describe('readServeConfig', () => {
  const base = {
    NIX_SITES_ALLOWED_SUFFIX: 'nixsites.com',
    NIX_SITES_S3_ENDPOINT: 'http://store:7070',
    NIX_SITES_S3_BUCKET: 'nix-sites',
    NIX_SITES_S3_ACCESS_KEY: 'a',
    NIX_SITES_S3_SECRET_KEY: 'b',
  };

  it('reads an optional default label suffix', () => {
    expect(readServeConfig(base).defaultLabelSuffix).toBe('');
    expect(
      readServeConfig({ ...base, NIX_SITES_DEFAULT_LABEL_SUFFIX: ' -home ' }).defaultLabelSuffix,
    ).toBe('-home');
  });

  it.each(['home', '-Home', '-home.x', '-', '-a-very-long-suffix-label'])(
    'refuses the label suffix %j',
    (value) => {
      expect(() => readServeConfig({ ...base, NIX_SITES_DEFAULT_LABEL_SUFFIX: value })).toThrow(
        /NIX_SITES_DEFAULT_LABEL_SUFFIX/,
      );
    },
  );
});
