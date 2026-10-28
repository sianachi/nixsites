import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable, pipeline } from 'node:stream';

import type { ObjectReader, StoredObject } from './store.ts';

/**
 * The anonymous serving process (ADR-0063). It maps a Host header to a build through a host
 * manifest in the object store and streams that build's files. It holds no database credential,
 * never calls Core, and keeps no session: **it never sets a cookie**, on any response, because the
 * full Nix app runs on the apex of the same sites domain and a site must not be able to touch it.
 *
 * Only `GET` and `HEAD`. A proper subdomain of the configured suffix is looked up; the apex itself
 * belongs to the app and is always refused. A Host outside the suffix (a verified custom hostname
 * or alias) is served only when Core wrote a host manifest for it; any other is refused.
 */

export const SITE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** A captured diagram's policy: its inline `<style>` applies; nothing runs or loads. */
export const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
  'content-security-policy': SITE_CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
} as const;

/** The fixed extension-to-type map; nothing else is ever served. */
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const BUILD_PREFIX = /^sites\/[0-9a-f-]{36}\/builds\/[0-9a-f-]{36}\/$/;
const ASSETS_PREFIX = /^sites\/[0-9a-f-]{36}\/assets\/$/;
const ASSET_NAME = /^[0-9a-f]{64}\.(png|jpg|webp|svg)$/;
/** A published download: its digest names the stored object, the file name only the download. */
const DOWNLOAD =
  /^\/_nix\/files\/([0-9a-f]{64})\/([A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(pdf|txt|csv|mp4|webm))$/;
const DOWNLOAD_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  mp4: 'video/mp4',
  webm: 'video/webm',
};
/** A published PDF is a download, and sandboxed should a browser render it anyway. */
export const PDF_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Downloads stay short-lived in caches so an unpublished file stops being served soon after. */
const DOWNLOAD_CACHE = 'public, max-age=300';
const REVALIDATE = 'public, max-age=0, must-revalidate';
const MANIFEST_TTL_MS = 10_000;
const ORIGIN =
  /^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;

interface HostManifest {
  readonly siteId: string;
  readonly generation: number;
  readonly buildPrefix: string;
  readonly assetsPrefix: string;
  /** For a redirect alias: the canonical origin a visitor is sent to with a 308. */
  readonly redirectTo: string | null;
}

interface Cached<T> {
  readonly value: T | null;
  readonly expires: number;
}

export interface SiteServerOptions {
  readonly reader: ObjectReader;
  readonly allowedSuffix: string;
  /** When set, only `<[a-z0-9-]+><this>.<allowedSuffix>` hosts count as this instance's own. */
  readonly defaultLabelSuffix?: string;
  readonly now?: () => number;
  readonly manifestTtlMs?: number;
}

/** The request target as a safe absolute path, or null for one that must be refused. */
export function normalizePath(rawUrl: string): string | null {
  const path = rawUrl.split('?')[0]?.split('#')[0] ?? '/';
  // One decode only, so an encoded slash or backslash cannot be smuggled past the checks below.
  if (/%2f|%5c|%00/i.test(path)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return null;
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.includes('//')) return null;
  if (decoded.split('/').some((segment) => segment === '..' || segment === '.')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return null;
  return decoded;
}

/**
 * A decoded path encoded again for a Location header: `path` is decoded, so a `?` in it would turn
 * into a query, and a character outside Latin-1 would make writeHead throw.
 */
function urlPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** The lowercase hostname of a Host header, without its port, or null if it is not a name. */
export function hostnameOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  const host = header
    .toLowerCase()
    .replace(/:\d{1,5}$/, '')
    .replace(/\.$/, '');
  return host.length <= 253 && HOSTNAME.test(host) ? host : null;
}

/** A host manifest as Core writes it, or null when anything about it is off. */
export function parseHostManifest(json: unknown): HostManifest | null {
  if (typeof json !== 'object' || json === null) return null;
  const value = json as Record<string, unknown>;
  const { siteId, generation, buildPrefix, assetsPrefix } = value;
  const redirectTo = value.redirectTo ?? null;
  return value.version === 1 &&
    typeof siteId === 'string' &&
    typeof generation === 'number' &&
    Number.isInteger(generation) &&
    typeof buildPrefix === 'string' &&
    BUILD_PREFIX.test(buildPrefix) &&
    typeof assetsPrefix === 'string' &&
    ASSETS_PREFIX.test(assetsPrefix) &&
    (redirectTo === null || (typeof redirectTo === 'string' && ORIGIN.test(redirectTo)))
    ? { siteId, generation, buildPrefix, assetsPrefix, redirectTo }
    : null;
}

export function createSiteServer(options: SiteServerOptions): Server {
  const now = options.now ?? Date.now;
  const ttl = options.manifestTtlMs ?? MANIFEST_TTL_MS;
  const suffix = `.${options.allowedSuffix}`;
  const ownTail = `${options.defaultLabelSuffix ?? ''}${suffix}`;
  // Without a label suffix every proper subdomain is this instance's; with one, only one label
  // ending in it, so another deployment sharing the domain is never answered with a 404.
  const isOwnHost = (host: string): boolean =>
    options.defaultLabelSuffix
      ? host.endsWith(ownTail) && /^[a-z0-9-]+$/.test(host.slice(0, -ownTail.length))
      : host.endsWith(suffix);
  const tables: Map<string, Cached<unknown>>[] = [];

  // Fixed: the maps are bounded, not only swept. Host headers are client-chosen and misses are
  // cached, so a burst of distinct hosts within one TTL could grow them without limit; past the
  // cap the oldest entries (a Map keeps insertion order) are dropped and simply re-read later.
  function sweep(): void {
    const at = now();
    for (const table of tables) {
      if (table.size < 1024) continue;
      for (const [key, entry] of table) if (entry.expires <= at) table.delete(key);
      for (const key of table.keys()) {
        if (table.size < 1024) break;
        table.delete(key);
      }
    }
  }

  async function readJson(key: string, limit = 1 << 20): Promise<unknown> {
    const object = await options.reader.open(key, 'GET');
    if (object?.body == null) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of object.body) {
      total += chunk.byteLength;
      if (total > limit) return null;
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) as unknown;
    } catch {
      return null;
    }
  }

  /**
   * A TTL cache whose misses are shared: requests arriving while a read is in flight wait for it
   * instead of each reading storage again, so an expiry under load costs one read, not one per
   * request. Negative results are cached too, so an unknown hostname cannot turn every request
   * into a storage read. A failed read is not cached.
   */
  function ttlCache<T>(
    load: (key: string, stale: T | null) => Promise<T | null>,
  ): (key: string) => Promise<T | null> {
    const table = new Map<string, Cached<T>>();
    const flights = new Map<string, Promise<T | null>>();
    tables.push(table);
    return (key) => {
      const hit = table.get(key);
      if (hit !== undefined && hit.expires > now()) return Promise.resolve(hit.value);
      let flight = flights.get(key);
      if (flight === undefined) {
        sweep();
        flight = load(key, hit?.value ?? null)
          .then((value) => {
            table.set(key, { value, expires: now() + ttl });
            return value;
          })
          .finally(() => flights.delete(key));
        flights.set(key, flight);
      }
      return flight;
    };
  }

  const hostManifest = ttlCache<HostManifest>(async (host, previous) => {
    const value = parseHostManifest(await readJson(`sites/_hosts/${host}.json`));
    // Two activations of one site can land out of order in the bucket; a manifest older than the
    // one already served for the same site is ignored rather than rolling the host back.
    return value !== null &&
      previous !== null &&
      previous.siteId === value.siteId &&
      value.generation < previous.generation
      ? previous
      : value;
  });

  const redirectTable = ttlCache<Record<string, string>>(async (buildPrefix) => {
    const json = await readJson(`${buildPrefix}_nix/redirects.json`);
    const table: Record<string, string> = {};
    if (typeof json === 'object' && json !== null && !Array.isArray(json)) {
      for (const [from, to] of Object.entries(json)) {
        // A target is a site path; anything else (a scheme, `//host`) is not a redirect to follow.
        if (typeof to === 'string' && /^\/(?!\/)[^\\\s]*$/.test(to)) table[from] = to;
      }
    }
    return table;
  });
  const redirects = async (buildPrefix: string): Promise<Record<string, string>> =>
    (await redirectTable(buildPrefix)) ?? {};

  /**
   * The asset and download paths the live build lists in its index. Assets are stored once per site,
   * so a superseded build's files are still in the store; only this list says a file is published.
   * An unreadable index lists nothing, so a missing file is never served by mistake.
   */
  const assetTable = ttlCache<ReadonlySet<string>>(async (buildPrefix) => {
    const json = await readJson(`${buildPrefix}_nix/build.json`, 16 << 20);
    const paths = new Set<string>();
    const files = (json as { files?: unknown } | null)?.files;
    if (Array.isArray(files)) {
      for (const file of files as { path?: unknown; kind?: unknown }[]) {
        if (file.kind === 'asset' && typeof file.path === 'string') paths.add(file.path);
      }
    }
    return paths;
  });
  const liveAssets = async (buildPrefix: string): Promise<ReadonlySet<string>> =>
    (await assetTable(buildPrefix)) ?? new Set();

  function send(
    response: ServerResponse,
    status: number,
    headers: Record<string, string>,
    body: StoredObject | Buffer | null,
  ): void {
    // No Set-Cookie, ever: this is the only place a response is written.
    response.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    if (body === null) {
      response.end();
    } else if (Buffer.isBuffer(body)) {
      response.end(body);
    } else if (body.body === null) {
      response.end();
    } else {
      // pipeline, not pipe: a storage stream that fails mid-body (a timeout, a reset) must end
      // this response, not surface as an unhandled 'error' that exits the process.
      pipeline(Readable.fromWeb(body.body as never), response, () => undefined);
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      send(response, 405, { allow: 'GET, HEAD' }, null);
      return;
    }

    const host = hostnameOf(request.headers.host);
    const apex = options.allowedSuffix;
    if (host === null || host === apex) {
      // Not a name, or the apex itself (the app's). 421 says "not this server's host".
      send(response, 421, {}, null);
      return;
    }
    const underSuffix = isOwnHost(host);
    if (!underSuffix && host.endsWith(suffix)) {
      // Another deployment's name on the shared domain: not this server's host.
      send(response, 421, {}, null);
      return;
    }

    const path = normalizePath(request.url ?? '/');
    if (path === null) {
      send(response, 400, {}, null);
      return;
    }

    const manifest = await hostManifest(host);
    if (manifest === null && !underSuffix) {
      // A custom hostname answers only once Core wrote its manifest, i.e. after verification.
      send(response, 421, {}, null);
      return;
    }
    if (manifest === null) {
      send(
        response,
        404,
        { 'content-type': 'text/plain; charset=utf-8' },
        Buffer.from('Not found'),
      );
      return;
    }

    if (manifest.redirectTo !== null) {
      const raw = request.url ?? '/';
      const query = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
      send(
        response,
        308,
        { location: `${manifest.redirectTo}${urlPath(path)}${query}`, 'cache-control': REVALIDATE },
        null,
      );
      return;
    }

    const head = method === 'HEAD';
    const notFound = async (): Promise<void> => {
      const page = await options.reader.open(
        `${manifest.buildPrefix}404.html`,
        head ? 'HEAD' : 'GET',
      );
      send(
        response,
        404,
        { 'content-type': 'text/html; charset=utf-8', 'cache-control': REVALIDATE },
        page,
      );
    };

    const table = await redirects(manifest.buildPrefix);
    const target = table[path] ?? table[`${path}/`];
    if (target !== undefined) {
      send(response, 308, { location: target, 'cache-control': REVALIDATE }, null);
      return;
    }

    let key: string;
    let cacheControl = REVALIDATE;
    let download: Record<string, string> = {};
    if (path.startsWith('/_nix/files/')) {
      const [, digest, name, ext] = DOWNLOAD.exec(path) ?? [];
      if (digest === undefined || name === undefined || ext === undefined) return notFound();
      if (!(await liveAssets(manifest.buildPrefix)).has(path.slice(1))) return notFound();
      key = `${manifest.assetsPrefix}${digest}.${ext}`;
      cacheControl = DOWNLOAD_CACHE;
      // The name is limited to letters, digits, `-` and `_` by the pattern, so quoting is enough.
      download = {
        'content-type': DOWNLOAD_TYPES[ext] ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
        ...(ext === 'pdf' ? { 'content-security-policy': PDF_CSP } : {}),
      };
    } else if (path.startsWith('/_nix/assets/')) {
      const name = path.slice('/_nix/assets/'.length);
      if (!ASSET_NAME.test(name)) return notFound();
      if (!(await liveAssets(manifest.buildPrefix)).has(path.slice(1))) return notFound();
      key = manifest.assetsPrefix + name;
      cacheControl = IMMUTABLE;
    } else {
      const last = path.slice(path.lastIndexOf('/') + 1);
      if (path.endsWith('/')) {
        key = `${manifest.buildPrefix}${path.slice(1)}index.html`;
      } else if (last.includes('.')) {
        key = manifest.buildPrefix + path.slice(1);
        if (path.startsWith('/_nix/theme/')) cacheControl = IMMUTABLE;
      } else {
        // A directory asked for without its slash goes to the canonical URL.
        const directory = await options.reader.open(
          `${manifest.buildPrefix}${path.slice(1)}/index.html`,
          'HEAD',
        );
        if (directory === null) return notFound();
        send(response, 308, { location: `${urlPath(path)}/`, 'cache-control': REVALIDATE }, null);
        return;
      }
    }

    const extension = key.slice(key.lastIndexOf('.'));
    const type = download['content-type'] ?? TYPES[extension];
    if (type === undefined) return notFound();
    // Only a download is ranged (a player seeks with it); one `bytes=a-b` range, never a list.
    const rangeHeader = request.headers.range;
    const range =
      download['content-type'] !== undefined &&
      typeof rangeHeader === 'string' &&
      /^bytes=\d*-\d*$/.test(rangeHeader)
        ? rangeHeader
        : undefined;
    const object = await options.reader.open(key, head ? 'HEAD' : 'GET', range);
    if (object === null) return notFound();
    send(
      response,
      object.status,
      {
        ...(object.contentRange === null ? {} : { 'content-range': object.contentRange }),
        ...(download['content-type'] === undefined ? {} : { 'accept-ranges': 'bytes' }),
        'content-type': type,
        ...(type === 'image/svg+xml' ? { 'content-security-policy': SVG_CSP } : {}),
        ...download,
        'cache-control': cacheControl,
        ...(object.length === null ? {} : { 'content-length': String(object.length) }),
      },
      object,
    );
  }

  return createServer((request, response) => {
    // Health for a process supervisor: answered for loopback names only, never for a site host.
    if (
      request.url === '/healthz' &&
      /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(request.headers.host ?? '')
    ) {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502, SECURITY_HEADERS);
      response.end();
    });
  });
}
