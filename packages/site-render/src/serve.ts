import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

/**
 * A local preview server for a rendered site, with the production headers (plan M3): the same
 * content security policy, no cookies, GET and HEAD only, redirects from `_nix/redirects.json`,
 * the theme's 404 page, and a fixed extension-to-type map.
 */

export const SITE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** A custom-layout build's pages: its own script runs, in an opaque origin (`apps/sites`). */
export const SANDBOX_CSP =
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * A captured diagram's own policy: its inline `<style>` may apply, and nothing may run or load,
 * even when the picture is opened directly rather than through an <img>.
 */
export const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

/**
 * A published PDF's policy: sandboxed, so a script inside it has no origin and no storage, and
 * nothing it names may load should a browser render it. Every published file is a download.
 */
export const PDF_CSP = "sandbox; default-src 'none'; frame-ancestors 'none'";

const DOWNLOAD_PATH =
  /^\/_nix\/files\/[0-9a-f]{64}\/([A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(pdf|txt|csv|mp4|webm))$/;

const DOWNLOAD_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/**
 * The headers a published download is served with, or null when the path is not one. The file
 * name comes from the path, which the pattern limits to letters, digits, `-` and `_`, so it needs
 * no quoting beyond the quotes around it.
 */
export function downloadHeaders(path: string): Record<string, string> | null {
  const match = DOWNLOAD_PATH.exec(path);
  const name = match?.[1];
  const ext = match?.[2];
  if (name === undefined || ext === undefined) {
    return null;
  }
  return {
    'Content-Type': DOWNLOAD_TYPES[ext] ?? 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${name}"`,
    ...(ext === 'pdf' ? { 'Content-Security-Policy': PDF_CSP } : {}),
  };
}

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

const HEADERS = {
  'Content-Security-Policy': SITE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/** The request path as a safe relative path, or null for one that must be refused. */
export function normalizePath(raw: string): string | null {
  const path = raw.split('?')[0] ?? '/';
  if (/%2f|%5c|%00/i.test(path)) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) {
    return null;
  }
  if (decoded.split('/').some((segment) => segment === '..' || segment === '.')) {
    return null;
  }
  return decoded;
}

export function createPreviewServer(dir: string): Server {
  const root = resolve(dir);
  const redirectsFile = join(root, '_nix', 'redirects.json');
  // Read once at start: a preview serves one build.
  const redirects = (
    existsSync(redirectsFile) ? JSON.parse(readFileSync(redirectsFile, 'utf8')) : {}
  ) as Record<string, string>;
  const indexFile = join(root, '_nix', 'build.json');
  const sandboxed =
    existsSync(indexFile) &&
    (JSON.parse(readFileSync(indexFile, 'utf8')) as { sandboxed?: unknown }).sandboxed === true;
  return createServer((request, response) => {
    // WebKit matches no 'self' for a fetch from the sandbox's opaque origin; name the host too.
    const host = /^[a-z0-9.-]+(:\d{1,5})?$/i.exec(request.headers.host ?? '')?.[0] ?? 'localhost';
    const base: Record<string, string> = sandboxed
      ? {
          ...HEADERS,
          'Content-Security-Policy': SANDBOX_CSP.replace(
            "connect-src 'self'",
            `connect-src 'self' http://${host} https://${host}`,
          ),
          'Access-Control-Allow-Origin': '*',
        }
      : HEADERS;
    void (async () => {
      const head = request.method === 'HEAD';
      if (request.method !== 'GET' && !head) {
        response.writeHead(405, { ...base, Allow: 'GET, HEAD' }).end();
        return;
      }
      const path = normalizePath(request.url ?? '/');
      if (path === null) {
        response.writeHead(400, base).end();
        return;
      }
      const redirect = redirects[path] ?? redirects[`${path}/`];
      if (redirect !== undefined) {
        response.writeHead(308, { ...base, Location: redirect }).end();
        return;
      }

      let file = resolve(root, `.${path}`);
      if (file !== root && !file.startsWith(root + sep)) {
        response.writeHead(400, base).end();
        return;
      }
      if (existsSync(file) && statSync(file).isDirectory()) {
        if (!path.endsWith('/')) {
          response.writeHead(308, { ...base, Location: `${path}/` }).end();
          return;
        }
        file = join(file, 'index.html');
      }
      const download = downloadHeaders(path);
      const type = download?.['Content-Type'] ?? TYPES[extname(file)];
      if (!existsSync(file) || !statSync(file).isFile() || type === undefined) {
        const page = join(root, '404.html');
        const body = existsSync(page) ? await readFile(page) : Buffer.from('Not found');
        response.writeHead(404, { ...base, 'Content-Type': 'text/html; charset=utf-8' });
        response.end(head ? undefined : body);
        return;
      }
      const immutable = path.startsWith('/_nix/assets/') || path.startsWith('/_nix/theme/');
      const body = await readFile(file);
      response.writeHead(200, {
        ...base,
        ...(type === 'image/svg+xml' ? { 'Content-Security-Policy': SVG_CSP } : {}),
        ...download,
        'Content-Type': type,
        'Content-Length': String(body.length),
        'Cache-Control': immutable
          ? 'public, max-age=31536000, immutable'
          : download !== null
            ? 'public, max-age=300'
            : 'no-cache',
      });
      response.end(head ? undefined : body);
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, base);
      }
      response.end();
    });
  });
}
